// ─────────────────────────────────────────────────────────────
// 实验对比 · 纯判定函数 —— **前端入口（转发壳，不含任何实现）**
//
//   🔴 2026-10-04：与 shared/modelspec.mjs / rsi.mjs 同一类事故的预防性整改。
//     实现已移至 `shared/experiments.cjs`。原因：服务端/测试用 `require()`
//     加载 .mjs 依赖 Node 的 `require(ESM)` 特性 —— 本地默认开启（永远正常），
//     线上 Vercel 运行时禁用（抛 ERR_REQUIRE_ESM），曾导致整站 500。
//
//     两个方向各自用最稳的用法：
//       · 前端 `import … from './experiments.mjs'` —— 本文件转发
//       · 服务端/测试 `require('./experiments.cjs')` —— CommonJS 原生
//
//   ⚠️ 本文件零逻辑，唯一实现仍是 `shared/experiments.cjs`。
//      回归锁：test/no-require-esm.test.cjs
// ─────────────────────────────────────────────────────────────
export { MAX_COMPARE, recKey, nextSelection, paramKeyUnion, diffParams } from './experiments.cjs';
