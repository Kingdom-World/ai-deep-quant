// shared/rsi.mjs 的类型声明（供 TypeScript 前端引用唯一实现源）
//   .mjs 本身是 JS，TS 无法直接推断，故此处补声明。
//   实现口径：Wilder 平滑（通达信 / 同花顺 / TradingView）。

/** Wilder RSI 序列；前 n 位为 null；数据不足返回全 null 数组 */
export declare function wilderRsiSeries(closes: number[], n?: number): (number | null)[];

/** 最新一根的 Wilder RSI；数据不足返回 null */
export declare function wilderRsiLast(closes: number[], n?: number): number | null;
