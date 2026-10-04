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
//
//   🔴 路由注册顺序：/schema 必须在 /:id 之前，否则 'schema' 会被当成 id 吃掉。
//
//   🔴 公网能力边界（用户决策 2026-10-04）：
//     公网允许**配置、校验、保存、导出**模型（纯声明式，无执行 → 无损害面）；
//     **执行**依赖本地数据归档，公网显式 503，不启用"必然失败"的重计算。
// ─────────────────────────────────────────────────────────────

/** 注册模型工坊路由 */
function registerModelRoutes(app, deps) {
  const { modelrun, modelspec, modelstore, uidOf, IS_VERCEL } = deps;
  const fe = require('../factorexpr.cjs'); // 服务端权威表达式校验（白名单 AST）

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
      /** 公网是否可执行（false=仅可配置/导出；前端据此禁用「运行」按钮并给出说明） */
      canRun: !IS_VERCEL,
    });
  });

  // ── 只校验（不执行、不落库）──
  app.post('/api/models/validate', (req, res) => {
    try {
      const r = modelspec.normalizeModel(req.body, { parseExpr: fe.parseExpression });
      res.json({ ok: r.ok, errors: r.errors, warnings: r.warnings, model: r.model });
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

  // ── 执行回测 ──
  app.post('/api/models/run', (req, res) => {
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
      const r = modelrun.runModel(body.model !== undefined ? body.model : body, {
        topN: body.topN,
        capital: body.capital,
        slippage: body.slippage,
        startDate: body.startDate,
        endDate: body.endDate,
      });
      if (!r.ok) {
        return res.status(400).json({ ok: false, stage: r.stage, error: r.error, issues: r.issues });
      }
      res.json({
        ok: true,
        engineVersion: r.engineVersion,
        plan: r.plan,
        fingerprint: r.fingerprint,
        model: r.model,
        result: r.result,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: `模型执行失败: ${String(e.message || e).slice(0, 120)}` });
    }
  });
}

module.exports = { registerModelRoutes };
