// ─────────────────────────────────────────────────────────────
// Model JSON v1 规范 —— **前端入口（转发壳，不含任何实现）**
//
//   🔴 2026-10-04 线上故障后的结构调整（与 shared/rsi.mjs 是同一类事故）：
//     实现原在 `shared/modelspec.mjs`，服务端用
//     `require('../shared/modelspec.mjs')` 加载 —— 这依赖 Node 的 `require(ESM)`
//     特性。本地 Node 22/24 默认开启该特性，**本地永远复现不出来**；
//     但线上 Vercel 运行时禁用（抛 ERR_REQUIRE_ESM），直接导致
//     **整个 Serverless 函数初始化失败**：/api/* 全量 500、登录页进不去。
//
//     ⇒ 与本项目 rsi 的既有解法一致：
//         · 实现放在 `shared/modelspec.cjs` —— 后端 require() 任何 Node 版本都能加载
//         · 前端 `import … from './modelspec.mjs'` —— 本文件转发（ESM 可安全 import CJS）
//       两个方向都各自模块系统最稳定的用法，彻底摆脱 Node 版本/平台差异。
//
//     ⚠️ 仍然只有**一份实现**（modelspec.cjs）。本文件零逻辑，
//        不构成第二真相源。回归锁见 test/no-require-esm.test.cjs。
// ─────────────────────────────────────────────────────────────
export {
  SCHEMA_VERSION,
  PRESET_FACTORS,
  REVERSAL_PRESETS,
  defaultDirection,
  TRANSFORM_TYPES,
  FILTER_FIELDS,
  FILTER_OPS,
  REBALANCE_BARS,
  UNIVERSES,
  COMBINE_METHODS,
  LIMITS,
  validateModel,
  normalizeModel,
  rebalanceBars,
  canonicalJSON,
} from './modelspec.cjs';
