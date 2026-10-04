'use strict';
// ─────────────────────────────────────────────────────────────
// 模型工坊路由（Phase 1）
//   · GET  /api/models/schema   规范常量（前端表单由**单一源**生成，不手抄白名单）
//   · POST /api/models/validate 只校验不执行（表单实时反馈；权威校验在服务端）
//   · POST /api/models/run      校验 → 构建复合截面 → 跑引擎 → 返回指纹与结果
//
//   🔴 公网门控：模型回测依赖**本地归档**（data/history/kline），Vercel 上不存在。
//     直接在 Vercel 返回 503 显式拒绝，而不是让用户等一个必然失败的请求——
//     master-plan 纪律："IS_VERCEL 门控先于功能上线"。
// ─────────────────────────────────────────────────────────────

/** 注册模型工坊路由 */
function registerModelRoutes(app, deps) {
  const { modelrun, modelspec, IS_VERCEL } = deps;
  const fe = require('../factorexpr.cjs'); // 服务端权威表达式校验（白名单 AST）

  /** 规范常量：前端据此渲染表单（避免前后端各维护一份白名单） */
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
    });
  });

  /** 只校验（不执行、不落库）：表单实时反馈用；权威结论仍以本接口为服务端口径 */
  app.post('/api/models/validate', (req, res) => {
    try {
      const r = modelspec.normalizeModel(req.body, { parseExpr: fe.parseExpression });
      res.json({ ok: r.ok, errors: r.errors, warnings: r.warnings, model: r.model });
    } catch (e) {
      res.status(500).json({ ok: false, error: `校验失败: ${String(e.message || e).slice(0, 120)}` });
    }
  });

  /** 执行模型回测 */
  app.post('/api/models/run', (req, res) => {
    if (IS_VERCEL) {
      return res.status(503).json({
        ok: false,
        stage: 'env',
        error:
          '模型回测依赖本地数据归档，公网演示版暂不支持——请在本地版本中使用「模型工坊」。' +
          '公网可用的在线功能：行情/资讯/因子分析/策略回测（预设因子）。',
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
