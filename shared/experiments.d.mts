// shared/experiments.mjs 的类型声明（供 TypeScript 前端引用；.mjs 须配 .d.mts）
//   实验记录用**最小结构化类型**：前端 ExperimentRecord（interface）天然满足——
//   注意不能加 index signature（interface 赋给带索引签名的类型会被 TS 拒绝）。

export interface ExperimentLike {
  ts: string;
  params?: object | null;
}

export declare const MAX_COMPARE: number;
export declare const recKey: (e: ExperimentLike) => string;

export declare function nextSelection(
  selected: string[],
  rec: ExperimentLike,
  max?: number,
): { next: string[]; warn: string };

export declare function paramKeyUnion(records: ExperimentLike[]): string[];

export declare function diffParams(records: ExperimentLike[]): {
  differing: string[];
  identical: { key: string; value: string | number | boolean }[];
};
