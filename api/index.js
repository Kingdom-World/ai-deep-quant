// ─────────────────────────────────────────────────────────────
// AI深度量化 · Vercel Serverless Function 入口
//   Vercel 约定：api/ 目录下每个文件是一个 Serverless Function。
//   本文件为 ESM 包装（项目 package.json 为 "type": "module"，
//   .cjs 后端通过 Node ESM 互操作直接复用，避免重复维护两份代码）。
//
//   本地开发/自托管仍使用 server/index.cjs（node server/index.cjs）；
//   部署到 Vercel 后，VERCEL=1 由平台注入，后端自动切换为
//   Serverless 模式（不监听端口、收紧超时、禁用本地调度）。
// ─────────────────────────────────────────────────────────────
import app from '../server/index.cjs';

export default app;
