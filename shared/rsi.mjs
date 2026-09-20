// ─────────────────────────────────────────────────────────────
// RSI —— 前端入口（转发壳，**不含任何实现**）
//
//   🔴 2026-09-20 线上故障后的结构调整：
//     实现已移至 `shared/rsi.cjs`。原因：后端此前用
//     `require('../../shared/rsi.mjs')` 加载，依赖 Node 的 `require(ESM)`
//     特性（仅 Node 20.19+/22.12+ 可用）—— 线上 Vercel 的 Node 20.x 较早版本
//     不支持，抛 ERR_REQUIRE_ESM，导致**整个 Serverless 函数崩溃**。
//
//     改为实现放 .cjs 后：
//       · 后端 require('./rsi.cjs') —— 任何 Node 版本均可（CommonJS 原生）
//       · 前端 import './rsi.mjs'   —— 本文件转发，ESM 可安全 import CJS
//     两个方向都用各自模块系统最稳的用法，**彻底摆脱 Node 版本依赖**。
//
//   ⚠️ 本文件**只是转发**，没有第二份逻辑 —— 唯一实现仍是 `shared/rsi.cjs`，
//      满足「全仓不得存在第二份 RSI 实现」的约束。
//
//   口径（Wilder 平滑）与详细说明见 shared/rsi.cjs 的文件头。
// ─────────────────────────────────────────────────────────────
export { wilderRsiSeries, wilderRsiLast } from './rsi.cjs';
