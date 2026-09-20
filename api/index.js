// ─────────────────────────────────────────────────────────────
// AI深度量化 · Vercel Serverless Function 入口
//   Vercel 约定：api/ 目录下每个文件是一个 Serverless Function。
//
//   本地开发/自托管仍使用 server/index.cjs（node server/index.cjs）；
//   部署到 Vercel 后，VERCEL=1 由平台注入，后端自动切换为
//   Serverless 模式（不监听端口、收紧超时、禁用本地调度）。
//
// ── 2026-09-20 加固：把"看不见的 500"变成"可诊断的错误" ──
//   背景：线上 /api/* 返回 `500 INTERNAL_SERVER_ERROR`（Vercel 通用错误页），
//   无任何细节。本地无法复现（模块加载、ESM 入口、依赖完整性均通过），
//   属于 Vercel 环境特有故障 —— 若继续靠猜，只会反复试错。
//
//   因此本文件改为**可诊断入口**：
//     · 初始化失败时，把原因记入运行日志（console.error）并返回结构化 JSON；
//     · 详细堆栈仅在 DEBUG_ERRORS=1 时外露（默认关闭，避免公网泄露内部结构）。
//
//   ⚠️ 为什么不用动态 `import()` 捕获错误：
//     Vercel 用 @vercel/node 的静态分析（nft）决定打包哪些文件。
//     `import(变量)` / 动态路径**追不到依赖**，会导致模块根本没被打进去 ——
//     那是把"500"换成"另一种 500"，更糟。
//     故此处用 `createRequire` + **字符串字面量**：
//     既可 try/catch 捕获，又保持静态可分析（nft 能识别 require 字面量）。
// ─────────────────────────────────────────────────────────────
import { createRequire } from 'node:module';

// ── 进程级错误捕获（2026-09-20 追加）──────────────────────────
//   背景：线上日志只出现 [PaperStore] 的 warn，却没有任何致命错误，
//   但请求一律 500 —— 典型特征是**错误发生在 Express 之外**：
//   未捕获异常/未处理的 Promise 拒绝会让 Node 进程直接退出，
//   Vercel 随即返回平台通用 500 页（不经过我们的 handler）。
//   这里把进程级错误显式打到运行日志，否则它们会静默消失。
process.on('uncaughtException', (e) => {
  console.error('[vercel-entry] uncaughtException:', (e && e.stack) || e);
});
process.on('unhandledRejection', (r) => {
  console.error('[vercel-entry] unhandledRejection:', (r && r.stack) || r);
});

const require_ = createRequire(import.meta.url);

let app = null;
let initError = null;
let initMs = 0;

const t0 = Date.now();
try {
  // ⚠️ 路径必须是字符串字面量（勿改成变量或模板串），否则打包器追踪不到。
  const mod = require_('../server/index.cjs');
  app = mod && mod.default ? mod.default : mod;
  if (typeof app !== 'function') {
    throw new Error(
      `server/index.cjs 未导出可调用的 express app（实际类型 ${typeof app}）`,
    );
  }
} catch (e) {
  initError = e instanceof Error ? e : new Error(String(e));
  // 关键：写进运行日志 —— 这是排查线上 500 的唯一可靠线索
  console.error('[vercel-entry] 初始化失败:', initError.stack || initError.message);
}
initMs = Date.now() - t0;

/** 是否允许把错误细节外露（默认关闭；排查时临时置 1） */
const exposeErrors = () => process.env.DEBUG_ERRORS === '1';

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body, null, 2));
}

export default function handler(req, res) {
  // ── 初始化失败：给出可诊断的响应，而不是让 Vercel 抛通用 500 ──
  if (initError) {
    const detail = exposeErrors()
      ? {
          message: initError.message,
          stack: String(initError.stack || '').split('\n').slice(0, 10),
        }
      : { message: '服务初始化失败，请查看运行日志（DEBUG_ERRORS=1 可临时外露详情）' };
    return sendJson(res, 500, {
      ok: false,
      error: 'INIT_FAILED',
      ...detail,
      diagnostics: {
        initMs,
        node: process.version,
        vercel: process.env.VERCEL || null,
        region: process.env.VERCEL_REGION || null,
        cwd: process.env.VERCEL ? undefined : process.cwd(), // 公网下不外露路径
      },
    });
  }

  // ── 请求期异常：同样记录，避免 500 无线索 ──
  try {
    return app(req, res);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error('[vercel-entry] 请求处理异常:', err.stack || err.message);
    if (res.headersSent) return; // 已开始响应则不再插手，交给运行时收尾
    return sendJson(res, 500, {
      ok: false,
      error: 'REQUEST_FAILED',
      message: exposeErrors() ? err.message : '请求处理失败，请查看运行日志',
    });
  }
}
