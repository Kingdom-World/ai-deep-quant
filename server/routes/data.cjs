'use strict';
// ─────────────────────────────────────────────────────────────
// 数据治理域路由（Phase 2 · 数据治理）
//   · GET /api/data/quality   归档版本索引 + 数据质量体检（**只读**，不落库、不改归档）
//   · GET /api/data/sources   口径单一源清单 + 治理校验（**只读**扫描源码）
//
//   🔴 这个端点组在回答一个长期欠缺的问题：「**这次结论是拿哪一版数据算的**」。
//     模型实验记录里只有 fingerprint（含数据**窗口**、不含数据**内容**），
//     归档每日同步 ⇒ 同窗口可能是两份数据。本接口给出内容级数据版本（digest），
//     与 fingerprint / engineVersion 合起来才是完整复现三件套。
//
//   ⚠️ 公网（Serverless）无本地归档 ⇒ 显式返回 ok:false + 原因，**不假装成功返回空索引**。
//     这与项目"降级必须显式"的约定一致：前端据 ok/env 渲染"本环境不可用"而非"数据为空"。
//
//   ⚠️ 代价：quality 首次计算要把整份归档（真实规模约 90MB）逐行摘要一遍（本机约 5–8s）。
//     故模块内带缓存（目录 mtime/size 签名 + 10 分钟 TTL），命中即返回 cached:true。
//     需要强制重算时传 `?refresh=1`。
// ─────────────────────────────────────────────────────────────
const path = require('node:path');

/** 单一源清单校验结果的进程内缓存（内容只随源码变化，5 分钟足够） */
const SOURCES_TTL_MS = 5 * 60 * 1000;
let _sourcesCache = null; // { at, report }

/** 注册数据治理路由 */
function registerDataRoutes(app, deps) {
  const { archiveindex, singlesource, IS_VERCEL } = deps;

  app.get('/api/data/quality', (req, res) => {
    try {
      const force = req.query.refresh === '1' || req.query.refresh === 'true';
      const idx = archiveindex.buildArchiveIndex(undefined, { force });
      const out = {
        ...idx,
        // 运行环境（前端据此区分"数据为空"与"本环境不提供"）
        env: IS_VERCEL ? 'serverless' : 'local',
      };
      if (!idx.ok && IS_VERCEL) {
        // 公网不是"数据坏了"，是"本环境压根不搭载归档"——把边界说清楚，别让用户以为归档烂了
        out.reason =
          '公网演示版不搭载本地数据归档 ⇒ 无数据版本与质量体检可用。' +
          '请在本地版本查看数据质量页（本地归档为独立维护的核心池日线）。';
      }
      res.json(out);
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: `数据质量检查失败: ${String((e && e.message) || e).slice(0, 120)}`,
        issues: archiveindex.DATA_ISSUES,
      });
    }
  });

  /**
   * 口径单一源清单 + 治理校验（扫源码，不扫归档 ⇒ 公网也可用）。
   * ⚠️ 结果里**只有相对路径**（不泄露绝对路径）。
   */
  app.get('/api/data/sources', (req, res) => {
    try {
      const force = req.query.refresh === '1' || req.query.refresh === 'true';
      if (!force && _sourcesCache && Date.now() - _sourcesCache.at < SOURCES_TTL_MS) {
        return res.json({ ..._sourcesCache.report, cached: true });
      }
      // 仓库根：server/routes/data.cjs → ../../ 
      const root = path.join(__dirname, '..', '..');
      const report = singlesource.verifySingleSources(root);
      _sourcesCache = { at: Date.now(), report };
      res.json({ ...report, cached: false, checkedAt: new Date().toISOString() });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: `单一源校验失败: ${String((e && e.message) || e).slice(0, 120)}`,
        entries: [],
      });
    }
  });
}

module.exports = { registerDataRoutes };

