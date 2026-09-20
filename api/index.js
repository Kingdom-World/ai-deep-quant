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

// ── Serverless 只读 FS 单点兜底（2026-09-20 追加）────────────────
//   背景：Vercel 的 /var/task 是**只读**的。本应用有十余处「模块加载期」的
//   `fs.mkdirSync(data/...)`（paper / auth / reports / news / experiments …），
//   **任何一处抛出都会让整个函数加载失败 → 全站 500**。
//
//   已实测到"拉锯"现象：修好 `paper/store.cjs:load()` 后，下一个立刻浮出
//   `paper/strategies.cjs:load()` —— 而两者报错文本**一字不差**
//   （都是 `mkdir '/var/task/data/paper'`），极易误判为"上次没修好"。
//   逐个打补丁 = 每轮一次部署（~2 分钟）才能露下一个，代价过高。
//
//   故在此做**单点兜底**：仅当 VERCEL=1 时，把 `fs.mkdirSync` 包成
//   "失败即降级 + 逐次告警"。只读环境下无法持久化的模块按内存态运行 ——
//   这与既定「Vercel 承载边界」一致（模拟盘 / 回测留痕本就不在 Vercel 支持范围）。
//
//   ⚠️ 为什么不算"静默降级"（项目铁律 #4）：每次降级都打 `[vercel-fs-guard]`
//   警告，并在 `/api/__ping` 的 `fsGuardCount` 中计数，异常外露可查。
function installReadOnlyFsGuard() {
  if (!process.env.VERCEL) return;
  const fs = require_('node:fs');
  if (fs.__roGuardInstalled) return;
  const orig = fs.mkdirSync;
  fs.mkdirSync = function (p, opts) {
    try {
      return orig.call(fs, p, opts);
    } catch (e) {
      fs.__roGuardCount = (fs.__roGuardCount || 0) + 1;
      console.warn(
        '[vercel-fs-guard] mkdirSync 降级（只读 FS）:',
        String(p),
        '→',
        e.code || e.message,
      );
      return undefined;
    }
  };
  fs.__roGuardInstalled = true;
}
installReadOnlyFsGuard();

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
  // ── 探针端点（2026-09-20 追加）────────────────────────────────
  //   目的：一次性把"故障在哪一层"问清楚，不再靠猜。
  //   · 若 /api/__ping 返回 200 而 /api/health 仍 500
  //       → 函数本体、打包、Node 运行时都正常，问题在 Express 路由或请求路径；
  //   · 若 /api/__ping 同样 500
  //       → 问题在函数/平台层（打包缺文件、超时、入口格式）。
  //   该端点**不经过 Express**，也不依赖任何业务模块，故可作为"最小可运行单元"。
  //   同时把函数实际看到的 req.url 打进日志 —— 这是验证 vercel.json 的
  //   rewrite 是否把路径改掉（Express 因此找不到路由）的关键证据。
  const urlSeen = String(req.url || '');
  console.log('[vercel-entry] req.url =', urlSeen, '| method =', req.method);
  if (urlSeen.includes('__ping')) {
    return sendJson(res, 200, {
      ok: true,
      probe: 'entry-alive',
      appReady: !initError,
      initError: initError ? initError.message.slice(0, 300) : null,
      initMs,
      node: process.version,
      urlSeenByFunction: urlSeen,
      fsGuardCount: require_('node:fs').__roGuardCount || 0,
      vercel: process.env.VERCEL || null,
      region: process.env.VERCEL_REGION || null,
    });
  }

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
