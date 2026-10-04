// ─────────────────────────────────────────────────────────────
// API 运行态（跨域共享的可变状态与编译期派生常量）
//   · PYTHON：后端模式派生值，报价批量/推荐等域均依赖。
//   · lastComputedAt：最近一次服务端评分快照时间（python 模式每日 16:00 定时任务写入）。
// ─────────────────────────────────────────────────────────────
import { BACKEND_MODE } from '../config';

/** Python+Flask 后端模式：推荐/批量报价走服务端聚合接口（限流友好） */
export const PYTHON = BACKEND_MODE === 'python';

/** 最近一次评分快照时间（python 模式来自后端每日 16:00 定时任务） */
let lastComputedAt: string | null = null;
export const getLastComputedAt = (): string | null => lastComputedAt;
export const setLastComputedAt = (v: string | null): void => {
  lastComputedAt = v;
};
