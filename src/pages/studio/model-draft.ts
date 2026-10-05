// ─────────────────────────────────────────────────────────────
// 模型工坊 · 草稿层（纯逻辑，无 React）
//
//   与 Model JSON 的关系：`Draft` 是**编辑态**（数字字段用字符串，避免 `0.`/`-`/`1.`
//   这类中间态被 Number() 吃掉），`draftToModel` 才是提交态。两者互转必须无损。
//   本轮重构只是把这段逻辑从页面里抽出来（行为零变化），便于单独推理与复用。
// ─────────────────────────────────────────────────────────────
import type { ModelSpec, ValidationIssue } from '../../api';
import { theme } from '../../lib/theme';
// 值导入（经 .mjs 转发壳 → .cjs）：方向默认值必须与规范层同源
import { defaultDirection } from '../../../shared/modelspec.mjs';

/**
 * 编辑器里的方向是**三态**：
 *   'auto' → 不写进 JSON，由规范层按因子名推导（`rev*` 反转，其余正向）
 *    1 / -1 → 用户**显式**指定，写进 JSON 覆盖推导值
 * 🔴 两态（1|-1）是不够的：草稿一旦落成 1，规范层的"缺省即反转"就永远到不了，
 *    用户在 `expr` 里把 `mom20` 改成 `rev20` 会得到"名字反转、行为动量"的模型。
 */
export type DraftDirection = 1 | -1 | 'auto';

export interface DraftFactor {
  id: string;
  expr: string;
  weight: string;
  direction: DraftDirection;
}

/** 草稿方向 → 生效方向（'auto' 时按因子名推导；与规范层同源，不另立一套规则） */
export const effectiveDirection = (f: { expr: string; direction: DraftDirection }): 1 | -1 =>
  f.direction === 'auto' ? defaultDirection(f.expr) : f.direction;

/** 三态循环：自动 → 正向 → 反向 → 自动 */
export const nextDirection = (d: DraftDirection): DraftDirection =>
  d === 'auto' ? 1 : d === 1 ? -1 : 'auto';

/**
 * 提交态的方向字段：`'auto'` **一律省略**，显式才写出。
 * 🔴 不能写成 `direction: effectiveDirection(f)`：那等于把"此刻的推导结果"固化进 JSON，
 *    此后无论因子名怎么改都不再跟随，且会触发规范层"显式 1 + rev 预置名"的警告噪声。
 *    省略才是"缺省语义"，规范层才拿得到推导的机会。
 */
export const directionField = (d: DraftDirection): { direction?: 1 | -1 } =>
  d === 'auto' ? {} : { direction: d };
export interface DraftTransform {
  type: string;
  method?: string;
  n?: string;
}
export interface DraftFilter {
  field: string;
  min: string;
  max: string;
}
export interface Draft {
  name: string;
  hypothesis: string;
  factors: DraftFactor[];
  transforms: DraftTransform[];
  filters: DraftFilter[];
  rebalance: string;
  groups: string;
  fees: boolean;
  author: string;
}

export const emptyDraft = (): Draft => ({
  name: '',
  hypothesis: '',
  factors: [{ id: 'f1', expr: 'mom20', weight: '1', direction: 'auto' }],
  transforms: [],
  filters: [],
  rebalance: 'monthly',
  groups: '5',
  fees: true,
  author: '',
});

/** 草稿 → Model JSON（空串字段一律省略，避免用 '' 冒充有效值） */
export function draftToModel(d: Draft): ModelSpec {
  return {
    schemaVersion: 1,
    name: d.name.trim(),
    ...(d.hypothesis.trim() ? { hypothesis: d.hypothesis.trim() } : {}),
    // 🔴 'auto' 必须**省略** direction 字段（见 directionField），不能写成推导值：
    //    写死等于把「此刻的推导结果」固化进 JSON；此后无论因子名怎么改都不会再跟随，
    //    且会触发规范层"显式 direction=1 + rev 预置名"的警告噪声。省略才是"缺省语义"。
    factors: d.factors.map((f, i) => ({
      id: f.id.trim() || `f${i + 1}`,
      expr: f.expr.trim(),
      weight: f.weight.trim() === '' ? 1 : Number(f.weight),
      ...directionField(f.direction),
    })),
    ...(d.transforms.length
      ? {
          transforms: d.transforms.map((t) => {
            const args: Record<string, unknown> = {};
            if (t.type === 'winsorize') {
              args.method = t.method || 'mad';
              if (t.n !== undefined && t.n.trim() !== '') args.n = Number(t.n);
            }
            return Object.keys(args).length ? { type: t.type as never, args } : { type: t.type as never };
          }),
        }
      : {}),
    ...(d.filters.length
      ? {
          filters: d.filters.map((f) => {
            const out: Record<string, unknown> = { type: 'field_range', field: f.field };
            if (f.min.trim() !== '') out.min = Number(f.min);
            if (f.max.trim() !== '') out.max = Number(f.max);
            return out as never;
          }),
        }
      : {}),
    backtest: { rebalance: d.rebalance as never, groups: Number(d.groups) || 5, fees: d.fees },
    meta: { author: d.author.trim() || 'me' },
  };
}

/** Model JSON → 草稿（模板载入 / 模型库载入 / JSON 轨同步共用） */
export function modelToDraft(m: ModelSpec & { meta?: { author?: string } }): Draft {
  return {
    name: m.name || '',
    hypothesis: m.hypothesis || '',
    factors: (m.factors || []).map((f, i) => ({
      id: f.id || `f${i + 1}`,
      expr: f.expr,
      weight: String(f.weight ?? 1),
      // 🔴 direction 缺省映射为 'auto'（不是 1）：保持"缺省"这一信息不丢失，
      //    否则导入 `{expr:'rev20'}` 会被固化成 `direction:1`，得到"名字反转、行为动量"的模型。
      direction: f.direction === undefined ? 'auto' : f.direction === -1 ? -1 : 1,
    })),
    transforms: (m.transforms || []).map((t) => {
      const args = (t.args || {}) as { method?: string; n?: number };
      return { type: t.type, method: args.method, n: args.n === undefined ? undefined : String(args.n) };
    }),
    filters: (m.filters || []).map((f) => {
      const ff = f as unknown as { field: string; min?: number; max?: number };
      return {
        field: ff.field,
        min: ff.min === undefined ? '' : String(ff.min),
        max: ff.max === undefined ? '' : String(ff.max),
      };
    }),
    rebalance: m.backtest?.rebalance || 'monthly',
    groups: String(m.backtest?.groups ?? 5),
    fees: m.backtest?.fees !== false,
    author: m.meta?.author || '',
  };
}

// ── 编辑面分区（左栏结构树 / 错误定位共用同一套 id，避免两处各写一份）──
export type StudioSection = 'basic' | 'factors' | 'transforms' | 'filters' | 'backtest';

export const STUDIO_SECTIONS: { id: StudioSection; label: string; hint: string }[] = [
  { id: 'basic', label: '基本信息', hint: '名称与研究假设' },
  { id: 'factors', label: '因子', hint: '表达式 · 权重 · 方向' },
  { id: 'transforms', label: '截面预处理', hint: '按顺序生效' },
  { id: 'filters', label: '过滤器', hint: '字段区间筛选' },
  { id: 'backtest', label: '回测设置', hint: '调仓 · 分组 · 成本' },
];

/**
 * 校验 issue 的 path → 所属编辑分区。
 * 🔴 这是「错误锚定控件」的枢纽：没有它，用户只能对着 `factors[2].weight` 自己找。
 */
export function sectionOfIssuePath(path: string | undefined): StudioSection {
  const p = String(path || '');
  if (p.startsWith('factors')) return 'factors';
  if (p.startsWith('transforms')) return 'transforms';
  if (p.startsWith('filters')) return 'filters';
  if (p.startsWith('backtest') || p.startsWith('combine') || p.startsWith('universe') || p.startsWith('schemaVersion')) {
    return 'backtest';
  }
  return 'basic';
}

/**
 * 取出属于某个字段前缀的 issue。
 * `prefix='factors[2]'` 命中 `factors[2]` 与 `factors[2].weight`，但不命中 `factors[20]`。
 */
export function issuesFor(issues: ValidationIssue[], prefix: string): ValidationIssue[] {
  return issues.filter((e) => e.path === prefix || String(e.path || '').startsWith(`${prefix}.`));
}

// ── 展示格式化（全站口径：涨红跌绿）──
export const fmtPct = (v: number | null | undefined) =>
  typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(2)}%` : '—';
export const fmtNum = (v: number | null | undefined, d = 2) =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—';

/** 涨红跌绿（国内惯例）—— 语义色仍取自 theme，不在分区里另立一套 */
export function pctColor(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return theme.color.textMuted;
  return v >= 0 ? theme.color.up : theme.color.down;
}
