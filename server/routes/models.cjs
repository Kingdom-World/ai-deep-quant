'use strict';
// ─────────────────────────────────────────────────────────────
// 模型工坊路由（Phase 1）
//   · GET    /api/models/schema    规范常量（前端表单的单一源）
//   · POST   /api/models/validate  只校验不执行（服务端权威 AST 校验）
//   · GET    /api/models           列出**本人**模型（uid 隔离）
//   · POST   /api/models           保存/覆盖模型（入库即校验 + 配额）
//   · GET    /api/models/:id       取单个模型（所有权校验）
//   · DELETE /api/models/:id       删除模型（所有权校验）
//   · POST   /api/models/run       执行回测（本地版；公网 503 显式拒绝）
//   · POST   /api/models/validate-suite  独立验证套件（本地版；公网 503；只读、不落库）
//
//   ── 分享（Phase 2 模型分享 v1）—— 状态机在 shared/modelshare.cjs，本文件只做编排 ──
//   · GET  /api/models/public       公开广场（**匿名可读**；只列已过审的公开示例）
//   · GET  /api/models/circle       圈内广场（需登录）
//   · GET  /api/models/review-queue 待审队列（**仅管理员**）
//   · GET  /api/models/shared/:id   取单个分享物（按 canView 判可见性）
//   · POST /api/models/:id/share    本人改可见性 / 申请公开（body: { action, note? }）
//   · POST /api/models/:id/review   管理员过审（body: { action: 'approve'|'reject', note? }）
//
//   🔴 路由注册顺序：/schema、/public、/circle、/review-queue 都必须在 /:id 之前，
//      否则 'public' 这类**单段**字面量路径会被 '/:id' 当成 id 吃掉（返回"模型不存在"）。
//      （/shared/:id 是两段，不受此影响，但统一放前面更不易错。）
//
//   🔴 公网能力边界（用户决策 2026-10-04）：
//     公网允许**配置、校验、保存、导出**模型（纯声明式，无执行 → 无损害面）；
//     **执行**依赖本地数据归档，公网显式 503，不启用"必然失败"的重计算。
// ─────────────────────────────────────────────────────────────

/** 注册模型工坊路由 */
function registerModelRoutes(app, deps) {
  const { modelrun, modelspec, modelstore, modelexp, validation, uidOf, isAdmin, IS_VERCEL } = deps;
  const fe = require('../factorexpr.cjs'); // 服务端权威表达式校验（白名单 AST）
  const share = require('../../shared/modelshare.cjs'); // 分享状态机（纯函数单一源）
  const { MAX_COMPARE } = require('../../shared/experiments.cjs'); // 对比上限单一源（⚠️ 必须 .cjs）

  /** 本次请求的访问者视角（分享相关接口统一用它判可见性） */
  const viewerOf = (req) => ({ uid: uidOf(req), isAdmin: isAdmin(req) });

  // ── 规范常量（必须注册在 /:id 之前）──
  app.get('/api/models/schema', (req, res) => {
    res.json({
      ok: true,
      schemaVersion: modelspec.SCHEMA_VERSION,
      presets: modelspec.PRESET_FACTORS,
      transforms: Object.keys(modelspec.TRANSFORM_TYPES).map((type) => ({
        type,
        args: modelspec.TRANSFORM_TYPES[type].args,
      })),
      filterFields: modelspec.FILTER_FIELDS,
      filterOps: modelspec.FILTER_OPS,
      rebalance: modelspec.REBALANCE_BARS,
      universes: modelspec.UNIVERSES,
      combineMethods: modelspec.COMBINE_METHODS,
      limits: modelspec.LIMITS,
      engineVersion: modelrun.ENGINE_VERSION,
      quotaPerUser: modelstore.QUOTA_PER_UID,
      /** 预置模型骨架（模板库；规范单一源在 shared/modelspec.cjs） */
      templates: modelspec.MODEL_TEMPLATES,
      /** 公网是否可执行（false=仅可配置/导出；前端据此禁用「运行」按钮并给出说明） */
      canRun: !IS_VERCEL,
      /**
       * 验证套件的阈值与已知局限（单一源在 server/validation.cjs）。
       * 界面直接渲染这两项，不再各写一份 → 阈值改了界面自动跟随，不会分叉。
       */
      validation: validation
        ? { rules: validation.RULES, limitations: validation.LIMITATIONS, canRun: !IS_VERCEL }
        : null,
    });
  });

  // ── 只校验（不执行、不落库）──
  app.post('/api/models/validate', (req, res) => {
    try {
      const r = modelspec.normalizeModel(req.body, { parseExpr: fe.parseExpression });
      res.json({
        ok: r.ok,
        errors: r.errors,
        warnings: r.warnings,
        model: r.model,
        /**
         * 语义核心哈希（模型**定义**身份，与数据窗口/回测参数无关）。
         * 用途：公网不能执行回测时，前端用它生成「离线执行回执」——
         * 用户把 JSON 拿到本地跑出来的结果，可以凭这个 hash 对上是同一个模型定义。
         * 由服务端计算 ⇒ 前后端不会各写一份哈希规则。
         */
        modelHash: r.ok ? modelrun.modelHash(r.model) : null,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: `校验失败: ${String(e.message || e).slice(0, 120)}` });
    }
  });

  // ── 本人模型列表 ──
  app.get('/api/models', async (req, res) => {
    try {
      const uid = uidOf(req);
      const items = await modelstore.list(uid, { limit: req.query.limit });
      const stats = await modelstore.statsForUid(uid);
      res.json({ ok: true, items, ...stats });
    } catch (e) {
      res.status(500).json({ ok: false, error: `读取模型列表失败: ${String(e.message || e).slice(0, 120)}` });
    }
  });

  // ── 保存/覆盖（入库即校验；配额超限显式拒绝）──
  app.post('/api/models', async (req, res) => {
    try {
      const uid = uidOf(req);
      const body = req.body || {};
      const input = body.model !== undefined ? body.model : body;
      const id = body.id !== undefined ? body.id : undefined;
      const r = await modelstore.save(uid, input, id);
      if (!r.ok) return res.status(400).json(r);
      res.json(r);
    } catch (e) {
      res.status(500).json({ ok: false, error: `保存失败: ${String(e.message || e).slice(0, 120)}` });
    }
  });

  // ────────────────────────────────────────────────────────────
  // 分享域（Phase 2 · 模型分享 v1）
  //   状态机一律在 shared/modelshare.cjs；本段只做「鉴权 → 取 doc → 判可见 → 应用动作 → 落库」编排。
  //   🔴 三条贯穿本段的纪律：
  //     ① 非可见一律 404（不区分"无权限"与"不存在"）——沿用模型库既有做法，不泄露存在性。
  //     ② 对外响应里的 uid 一律经 authorNameOf 脱敏（未启用鉴权时 uidOf 返回 ip:1.2.3.4）。
  //     ③ 动作失败原样 400 透传 error，不吞、不改写（前端要靠它给出可执行指引）。
  // ────────────────────────────────────────────────────────────

  /** 广场列表 → 对外摘要（🔴 uid 绝不外露） */
  const shareItems = (rows, opts = {}) =>
    rows.map((r) => share.shareSummary(r, { author: share.authorNameOf(r.uid), ...opts }));

  /** 公开广场：只列**已过审**的公开示例（pending 未过审绝不外流） */
  app.get('/api/models/public', async (req, res) => {
    try {
      const rows = await modelstore.listShared({ scope: 'public', limit: req.query.limit });
      res.json({ ok: true, shareVersion: share.SHARE_VERSION, items: shareItems(rows) });
    } catch (e) {
      res.status(500).json({ ok: false, error: `读取公开模型失败: ${String((e && e.message) || e).slice(0, 120)}` });
    }
  });

  /**
   * 公开示例详情 —— **与访问者身份无关**，故允许 CDN 边缘缓存（进了 PUBLIC_API_PREFIXES）。
   * 🔴 为什么不能直接用 /api/models/shared/:id 走公开：那支的内容随可见性变化
   *    （circle 仅登录可见、private 仅本人可见），而边缘缓存不区分身份 ⇒ 会把
   *    有权限者看到的响应喂给无权限者。本端点是"只读已过审公开模型"的窄化出口。
   */
  app.get('/api/models/public/:id', async (req, res) => {
    try {
      const doc = await modelstore.getRaw(req.params.id);
      // 双保险：既查生效可见性、也查审核态 —— 缓存错配时宁可不给
      const s = doc ? share.shareOf(doc) : null;
      if (!doc || share.effectiveVisibility(doc) !== 'public' || s.reviewState !== 'approved') {
        return res.status(404).json({ ok: false, error: '模型不存在' });
      }
      res.json({
        ok: true,
        shareVersion: share.SHARE_VERSION,
        view: share.shareView(doc, {
          author: share.authorNameOf(doc.uid),
          modelHash: modelrun.modelHash(doc),
        }),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: `读取公开模型失败: ${String((e && e.message) || e).slice(0, 120)}` });
    }
  });

  /** 圈内广场：仅登录可见（鉴权中间件挡匿名）；与 public 互斥，不重复展示 */
  app.get('/api/models/circle', async (req, res) => {
    try {
      const rows = await modelstore.listShared({ scope: 'circle', limit: req.query.limit });
      res.json({ ok: true, shareVersion: share.SHARE_VERSION, items: shareItems(rows) });
    } catch (e) {
      res.status(500).json({ ok: false, error: `读取圈内模型失败: ${String((e && e.message) || e).slice(0, 120)}` });
    }
  });

  /** 待审队列（仅管理员）：admin 要能看到 private 的 pending 模型，否则无从审核 */
  app.get('/api/models/review-queue', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: '仅管理员可查看待审队列' });
    try {
      const rows = await modelstore.listShared({ scope: 'pending', limit: req.query.limit });
      res.json({ ok: true, shareVersion: share.SHARE_VERSION, items: shareItems(rows, { includeReview: true }) });
    } catch (e) {
      res.status(500).json({ ok: false, error: `读取待审队列失败: ${String((e && e.message) || e).slice(0, 120)}` });
    }
  });

  /** 取单个分享物（按 canView 判可见性） */
  app.get('/api/models/shared/:id', async (req, res) => {
    try {
      const doc = await modelstore.getRaw(req.params.id);
      if (!doc) return res.status(404).json({ ok: false, error: '模型不存在' });
      const viewer = viewerOf(req);
      if (!share.canView(doc, viewer)) return res.status(404).json({ ok: false, error: '模型不存在' });
      const isOwner = String(doc.uid || '') === String(viewer.uid || '');
      res.json({
        ok: true,
        shareVersion: share.SHARE_VERSION,
        view: share.shareView(doc, {
          author: share.authorNameOf(doc.uid),
          // modelHash 只取语义核心，doc 里的 uid/id/visibility 不会影响它
          modelHash: modelrun.modelHash(doc),
          // 审核信息只给本人与管理员（他人无需知道"这模型正被审"）
          includeReview: isOwner || viewer.isAdmin,
        }),
        actions: share.actionsFor(doc, { isOwner, isAdmin: viewer.isAdmin }),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: `读取分享模型失败: ${String((e && e.message) || e).slice(0, 120)}` });
    }
  });

  /** 本人改可见性 / 申请公开（**只有本人**；越权按 404 处理） */
  app.post('/api/models/:id/share', async (req, res) => {
    try {
      const uid = uidOf(req);
      // 🔴 角色闸门（2026-10-06 端到端实测抓到的真漏洞）：owner 端点**只接受 owner 动作**。
      //    状态机是纯函数、不知道调用者是谁；此前不校验时，用户只要处于 pending 状态，
      //    传 action:'approve' 就能**自己给自己过审**，审核形同虚设。
      const action = String(req.body?.action || '');
      if (share.actionBy(action) !== 'owner') {
        return res.status(400).json({
          ok: false,
          error: `不允许的动作：${action.slice(0, 40) || '(空)'}（审核类动作需管理员权限）`,
        });
      }
      // 🔴 用带所有权校验的 get（不是 getRaw）：越权者拿到 null ⇒ 404，不泄露存在性
      const doc = await modelstore.get(req.params.id, uid);
      if (!doc) return res.status(404).json({ ok: false, error: '模型不存在' });
      const r = share.applyShareAction(doc, action, {
        now: new Date().toISOString(),
        note: req.body?.note,
      });
      if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
      const saved = await modelstore.setShareState(req.params.id, uid, r.patch);
      if (!saved.ok) return res.status(500).json({ ok: false, error: saved.error });
      res.json({
        ok: true,
        share: share.shareSummary(saved.doc, {
          author: share.authorNameOf(uid),
          includeReview: true,
        }),
        actions: share.actionsFor(saved.doc, { isOwner: true, isAdmin: isAdmin(req) }),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: `更新分享设置失败: ${String((e && e.message) || e).slice(0, 120)}` });
    }
  });

  /** 管理员过审（**仅管理员**；审核的是"能否成为平台公开示例"） */
  app.post('/api/models/:id/review', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: '仅管理员可审核公开申请' });
    const action = String(req.body?.action || '');
    if (!share.ADMIN_ACTIONS.includes(action)) {
      return res.status(400).json({ ok: false, error: `action 必须是 ${share.ADMIN_ACTIONS.join(' 或 ')}` });
    }
    try {
      const doc = await modelstore.getRaw(req.params.id);
      if (!doc) return res.status(404).json({ ok: false, error: '模型不存在' });
      const r = share.applyShareAction(doc, action, { now: new Date().toISOString(), note: req.body?.note });
      if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
      // 🔴 uid 必须是**模型所有者**（admin 不是 owner）：setShareState 按 uid 校验所有权
      const saved = await modelstore.setShareState(req.params.id, doc.uid, r.patch);
      if (!saved.ok) return res.status(500).json({ ok: false, error: saved.error });
      res.json({
        ok: true,
        share: share.shareSummary(saved.doc, {
          author: share.authorNameOf(doc.uid),
          includeReview: true,
        }),
        actions: share.actionsFor(saved.doc, { isOwner: false, isAdmin: true }),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: `审核失败: ${String((e && e.message) || e).slice(0, 120)}` });
    }
  });

  // ── 取单个（所有权校验；非本人一律 404，不泄露存在性）──
  app.get('/api/models/:id', async (req, res) => {
    try {
      const doc = await modelstore.get(req.params.id, uidOf(req));
      if (!doc) return res.status(404).json({ ok: false, error: '模型不存在' });
      res.json({ ok: true, model: doc });
    } catch (e) {
      res.status(500).json({ ok: false, error: `读取失败: ${String(e.message || e).slice(0, 120)}` });
    }
  });

  // ── 删除（所有权校验）──
  app.delete('/api/models/:id', async (req, res) => {
    try {
      const r = await modelstore.remove(req.params.id, uidOf(req));
      if (!r.ok) return res.status(400).json(r);
      if (!r.removed) return res.status(404).json({ ok: false, error: '模型不存在' });
      res.json({ ok: true, removed: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: `删除失败: ${String(e.message || e).slice(0, 120)}` });
    }
  });

  // ── 模型实验记录（不可变留痕；per-uid 隔离）──
  app.get('/api/model-experiments', async (req, res) => {
    try {
      const uid = uidOf(req);
      const items = await modelexp.list(uid, { limit: req.query.limit });
      const stats = await modelexp.statsForUid(uid);
      res.json({ ok: true, items, ...stats, maxCompare: MAX_COMPARE });
    } catch (e) {
      res.status(500).json({ ok: false, error: `读取实验列表失败: ${String(e.message || e).slice(0, 120)}` });
    }
  });

  // ── 对比：一次取多条完整记录（前端直接喂 shared/experiments.mjs 的纯函数）──
  app.post('/api/model-experiments/compare', async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
      if (ids.length > MAX_COMPARE) {
        return res.status(400).json({ ok: false, error: `最多对比 ${MAX_COMPARE} 条实验（收到 ${ids.length} 条）` });
      }
      const items = await modelexp.getMany(ids, uidOf(req));
      res.json({ ok: true, items, maxCompare: MAX_COMPARE, requested: ids.length });
    } catch (e) {
      res.status(500).json({ ok: false, error: `对比读取失败: ${String(e.message || e).slice(0, 120)}` });
    }
  });

  app.get('/api/model-experiments/:id', async (req, res) => {
    try {
      const doc = await modelexp.get(req.params.id, uidOf(req));
      if (!doc) return res.status(404).json({ ok: false, error: '实验不存在' });
      res.json({ ok: true, experiment: doc });
    } catch (e) {
      res.status(500).json({ ok: false, error: `读取失败: ${String(e.message || e).slice(0, 120)}` });
    }
  });

  app.delete('/api/model-experiments/:id', async (req, res) => {
    try {
      const r = await modelexp.remove(req.params.id, uidOf(req));
      if (!r.ok) return res.status(400).json(r);
      if (!r.removed) return res.status(404).json({ ok: false, error: '实验不存在' });
      res.json({ ok: true, removed: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: `删除失败: ${String(e.message || e).slice(0, 120)}` });
    }
  });

  // ── 独立验证套件（Phase 2：walk-forward + 参数平原 + 因果性 + 样本量/功效披露）──
  //   🔴 独立性：本路由**只读**模型、不写模型库、不触发实验留痕，也不回写入参模型。
  //      一旦验证能反过来影响被验证对象，它就不再是验证而是自证（validation.cjs 的定义）。
  //   ⚠️ 代价：默认约 13 次回测（1 基准 + 3 折 + 4~5 参数点 + 1 全集 + 3 截断），
  //      且因果性检验要为每个截断点**物理截断一遍归档**（约 90MB/次，本机约 10s/次）
  //      ⇒ 整体 30–60 秒。故响应带 cost.backtests，调用方（界面）据此提示耗时。
  //   ⚠️ 只接受**包装形态** `{ model, … }`：控制字段与模型必须分层，裸对象形态没地方放参数。
  app.post('/api/models/validate-suite', async (req, res) => {
    if (IS_VERCEL) {
      return res.status(503).json({
        ok: false,
        stage: 'env',
        error:
          '独立验证套件需要多次重跑回测（依赖本地数据归档），公网演示版不提供执行。' +
          '请把模型 JSON 导出到本地版本运行验证。',
      });
    }
    try {
      const body = req.body || {};
      if (body.model === undefined) {
        return res.status(400).json({
          ok: false,
          error: '请用包装形态提交：{ model, folds?, param?, skip?, topN?, capital?, slippage?, startDate?, endDate? }',
        });
      }
      const report = validation.runValidation(body.model, {
        folds: body.folds,
        param: body.param,
        cuts: body.cuts,
        skip: Array.isArray(body.skip) ? body.skip : undefined,
        /**
         * 数据版本默认**现算**（'compute'）：验证本就要跑十几次回测（30–60s），
         * 再多一次约 5–8s 的归档摘要，换来报告必定可追溯到"哪一版数据"——
         * 科研级可复现要求下这是划算的。传 dataVersion:'cache' 可退化为只用缓存。
         */
        dataVersion: body.dataVersion === 'cache' ? undefined : 'compute',
        opts: {
          topN: body.topN,
          capital: body.capital,
          slippage: body.slippage,
          startDate: body.startDate,
          endDate: body.endDate,
        },
      });
      res.json(report);
    } catch (e) {
      res.status(500).json({ ok: false, error: `验证失败: ${String(e.message || e).slice(0, 160)}` });
    }
  });

  // ── 执行回测 ──
  app.post('/api/models/run', async (req, res) => {
    if (IS_VERCEL) {
      return res.status(503).json({
        ok: false,
        stage: 'env',
        error:
          '模型回测依赖本地数据归档，公网演示版不提供执行。' +
          '公网仍可**配置、校验、保存与导出**模型 JSON；若要跑净值，请在本地版本中导入该模型执行。',
      });
    }
    try {
      const body = req.body || {};
      /**
       * 入参两种包装：裸模型对象 / `{ model, topN, …, record, modelId }`。
       * 🔴 控制字段（record / modelId）**只在包装形态下生效**：裸对象形态里
       *    body 本身就是 Model JSON，往里加 `record:false` 会被规范判为「未知键」
       *    而直接 400 —— 开关不能反过来污染模型（这是实测踩到的缺陷，勿回退）。
       */
      const wrapped = body.model !== undefined;
      const modelInput = wrapped ? body.model : body;
      const r = modelrun.runModel(modelInput, {
        topN: body.topN,
        capital: body.capital,
        slippage: body.slippage,
        startDate: body.startDate,
        endDate: body.endDate,
      });
      if (!r.ok) {
        return res.status(400).json({ ok: false, stage: r.stage, error: r.error, issues: r.issues });
      }

      // 自动留痕（项目惯例：每次回测留实验记录）。包装形态下可经 body.record===false 关闭。
      //   ⚠️ 必须在响应返回**之前** await 完成——Serverless 响应后函数冻结，未 await 的写入会静默丢失。
      //   记录失败**不影响回测结果**返回，但必须把失败如实告知（不假装记录成功）。
      let experiment = null;
      let recordError = null;
      if (!wrapped || body.record !== false) {
        try {
          const rec = await modelexp.record(uidOf(req), {
            model: r.model,
            plan: r.plan,
            fingerprint: r.fingerprint,
            engineVersion: r.engineVersion,
            modelHash: modelrun.modelHash(r.model),
            modelId: wrapped && typeof body.modelId === 'string' ? body.modelId : null,
            result: r.result,
          });
          if (rec.ok) experiment = { id: rec.id, ts: rec.ts, evicted: rec.evicted || 0 };
          else recordError = rec.error;
        } catch (e) {
          recordError = `实验记录失败: ${String(e.message || e).slice(0, 100)}`;
          console.error('[ModelStudio] 实验记录异常:', e.message);
        }
      }

      res.json({
        ok: true,
        engineVersion: r.engineVersion,
        plan: r.plan,
        fingerprint: r.fingerprint,
        model: r.model,
        result: r.result,
        experimentId: experiment ? experiment.id : null,
        ...(recordError ? { recordWarning: recordError } : {}),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: `模型执行失败: ${String(e.message || e).slice(0, 120)}` });
    }
  });
}

module.exports = { registerModelRoutes };
