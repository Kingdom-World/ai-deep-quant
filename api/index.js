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
import { fileURLToPath } from 'node:url';

/** 本文件（函数包内 api/index.js）所在目录的父目录 = 项目根 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

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

// ── 打包完整性探针（2026-10-04 追加）────────────────────────────
//   背景：线上 /api/* 全量 500 `INIT_FAILED`（initMs≈290），而本地
//   Node 22 / Node 24 直接加载入口**完全正常**，且 .vercelignore 上传集
//   模拟也正常 —— 即：故障只可能出在「Vercel 函数打包后的文件集」。
//
//   Vercel 用 @vercel/nft 从入口做静态分析决定函数包内容，动态路径追不到，
//   **漏掉的文件在本地永远看不出来**。故此处从**函数真实运行环境**内直接
//   探测关键路径是否存在，把"猜"变成"看"。
//
//   安全：只输出**相对路径 + 布尔**，不含绝对部署路径、不含任何内容。
//   ✅ 2026-10-04 事故复盘：本探针是唯一"一次部署即定性"的手段
//      （前两次同类事故都靠反复猜 + 多次部署试错）。故**保留为常驻运维能力**，
//      仅在 `?probe=files` 或 DEBUG_ERRORS=1 时输出，且永远不输出文件内容与绝对路径。
function probeFiles() {
  const fs = require_('node:fs');
  const p = require_('node:path');
  const base = ROOT;
  const targets = [
    'server/index.cjs',
    'server/modelrun.cjs',
    'server/modelstore.cjs',
    'server/modelxform.cjs',
    'server/crosssect.cjs',
    'server/factorexpr.cjs',
    'server/routes/models.cjs',
    'shared/modelspec.mjs',
    'shared/modelspec.cjs',
    'shared/experiments.mjs',
    'shared/experiments.cjs',
    'shared/rsi.cjs',
    'shared/cn-holidays.json',
    'dist/index.html',
    'node_modules/express/package.json',
    'node_modules/pg/package.json',
  ];
  const out = {};
  for (const t of targets) {
    try {
      out[t] = fs.existsSync(p.join(base, t));
    } catch {
      out[t] = 'err';
    }
  }
  return out;
}

// ── 逐模块真实 require 探针 ────────────────────────────────────
//   `existsSync=true` 只证明**文件在**，不证明**能被 require**。
//   模型工坊链路上有一个"文件存在但加载失败"的可能（require(esm) 互操作、
//   模块级副作用…），故这里真刀真枪 require 一次，把错误码原样带出来。
//   ⚠️ 只 require 纯模块（无副作用）；失败模块不会被缓存，可重复探测。
function probeRequires() {
  const mods = [
    '../server/modelxform.cjs',
    '../server/modelrun.cjs',
    '../server/modelstore.cjs',
    '../server/routes/models.cjs',
    '../shared/modelspec.cjs',
    '../shared/experiments.cjs',
  ];
  const out = {};
  for (const m of mods) {
    try {
      require_(m);
      out[m] = 'ok';
    } catch (e) {
      out[m] = `${(e && (e.code || e.name)) || 'Error'}: ${initErrorSignature(e).message}`;
    }
  }
  return out;
}

/** 初始化错误的"可诊断签名"：剥掉绝对路径，只留模块名/错误码 */
function initErrorSignature(e) {
  const scrub = (s) =>
    String(s || '')
      .replace(/[A-Za-z]:\\[^\s)'"]+/g, (m) => '…/' + m.split(/[\\/]/).pop())
      .replace(/\/(?:var|usr|opt|home|Users|tmp)\/[^\s)'"]+/g, (m) => '…/' + m.split('/').pop());
  return {
    name: (e && e.name) || null,
    code: (e && e.code) || null,
    message: scrub(e && e.message).slice(0, 300),
    frames: String((e && e.stack) || '')
      .split('\n')
      .slice(1, 5)
      .map(scrub),
  };
}

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
  // 逐请求打印 req.url 是当时为定位"rewrite 是否改路径"加的诊断，现已完成使命。
  // 默认关闭（每个请求一行日志既有噪声也有成本）；需要时置 DEBUG_ERRORS=1 复现。
  if (process.env.DEBUG_ERRORS === '1') {
    console.log('[vercel-entry] req.url =', urlSeen, '| method =', req.method);
  }
  if (urlSeen.includes('__ping')) {
    // ⚠️ 对外只暴露"活着 / 是否就绪"这类最小信息。
    //    运行环境内情（Node 版本、部署区域、只读守卫计数、初始化错误原文）
    //    属于实现细节，且 initError **可能含绝对部署路径** ——
    //    这是本端点在 2026-09-22 自查中发现的信息外露，故默认收进
    //    `DEBUG_ERRORS=1` 后面，仅内网排查时临时打开。
    const detail = exposeErrors();
    // 打包完整性探针：`?probe=files` 或 DEBUG_ERRORS=1 时输出（排查期）
    const wantProbe = urlSeen.includes('probe=files') || detail;
    return sendJson(res, 200, {
      ok: true,
      probe: 'entry-alive',
      appReady: !initError,
      initMs,
      ...(wantProbe
        ? {
            fileProbe: probeFiles(),
            requireProbe: probeRequires(),
            initErrorSig: initError ? initErrorSignature(initError) : null,
          }
        : {}),
      ...(detail
        ? {
            initError: initError ? initError.message.slice(0, 300) : null,
            node: process.version,
            urlSeenByFunction: urlSeen,
            fsGuardCount: require_('node:fs').__roGuardCount || 0,
            runtime: process.env.VERCEL ? 'managed' : 'self-hosted',
            region: process.env.VERCEL_REGION || null,
          }
        : {}),
    });
  }

  // ── 初始化失败：给出可诊断的响应，而不是让 Vercel 抛通用 500 ──
  if (initError) {
    const detail = exposeErrors();
    const wantProbe = urlSeen.includes('probe=files') || detail;
    return sendJson(res, 500, {
      ok: false,
      error: 'INIT_FAILED',
      ...(detail
        ? {
            message: initError.message,
            stack: String(initError.stack || '').split('\n').slice(0, 10),
          }
        : { message: '服务初始化失败，请查看运行日志（DEBUG_ERRORS=1 可临时外露详情）' }),
      ...(wantProbe
        ? {
            initErrorSig: initErrorSignature(initError),
            fileProbe: probeFiles(),
          }
        : {}),
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
