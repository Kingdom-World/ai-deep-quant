// ─────────────────────────────────────────────────────────────
// 功能区分区（架构第一块砖 · 2026-10-05）
//
//   🔴 为什么要有这个文件：
//     此前全站是「一套模板复制 16 页」——`App.tsx` 在 <Routes> **外**挂全局单例
//     `<Backdrop/>`，`theme.ts` 头注释原文写着"**所有页面**从这里取色/取字号/
//     取间距/取背景"。六个功能区（消费/决策/执行/创作/研究/解释）的使用频次与
//     认知负荷几乎相反（见 2026-10-04 设计评审），却共用同一套底、同一套密度。
//
//   ⇢ 分区原则：**共用的应是「约束」，不是「外观」**。
//     共用（语义层，不可分叉）：涨红跌绿、单位与精度、鉴权、错误码、审计留痕。
//     分开（表现与数据策略层）：背景、栅格、密度、字号尺度、骨架、取数策略。
//
//   ⚠️ 迁移状态（诚实记录）：**本次只迁移「创作区」**（/models、/backtest）。
//     其余各区仍走原来的深空极光底 —— 目的是零视觉回归：一次只动一个路由区间，
//     先验证分区方案成立，再按 消费 → 执行 → 研究 的顺序推进。
//     未迁移 ≠ 未定义：分区在这里已经切好，后续只需把 backdrop/shell 字段改掉。
// ─────────────────────────────────────────────────────────────

export type ZoneKey = 'consumer' | 'decision' | 'execution' | 'studio' | 'research' | 'explainer';

/** 视觉底类型：aurora=全站深空极光（现状）；workbench=平面工作台（分区自有底） */
export type BackdropKind = 'aurora' | 'workbench';

/** 骨架形态：各区信息密度与主操作完全不同，骨架不能共享 */
export type ShellKind = 'stream' | 'console' | 'state' | 'studio' | 'bench' | 'chat';

export interface ZoneMeta {
  key: ZoneKey;
  label: string;
  /** 用户此刻的心智（决定信息密度与首屏该放什么） */
  mindset: string;
  backdrop: BackdropKind;
  shell: ShellKind;
  /** 路由前缀（按**最长前缀**匹配，`/` 为兜底） */
  prefixes: string[];
  /** 是否已迁移到分区外壳 */
  migrated: boolean;
}

const ZONE_LIST: ZoneMeta[] = [
  {
    key: 'studio',
    label: '创作区',
    mindset: '我要造一个策略',
    backdrop: 'workbench',
    shell: 'studio',
    prefixes: ['/models', '/backtest'],
    migrated: true,
  },
  {
    key: 'research',
    label: '研究区',
    mindset: '这个结论靠不靠得住',
    backdrop: 'aurora',
    shell: 'bench',
    // /data（数据质量）同属研究心智：都在回答"这个结论靠不靠得住"（数据底稿也是结论的一部分）
    prefixes: ['/research', '/experiments', '/factor-eval', '/data'],
    migrated: false,
  },
  {
    key: 'execution',
    label: '执行区',
    mindset: '我的仓位现在怎么样',
    backdrop: 'aurora',
    shell: 'state',
    prefixes: ['/paper'],
    migrated: false,
  },
  {
    key: 'explainer',
    label: '解释区',
    mindset: '帮我弄明白 / 帮我做',
    backdrop: 'aurora',
    shell: 'chat',
    prefixes: ['/assistant', '/agents', '/agent-research'],
    migrated: false,
  },
  {
    key: 'decision',
    label: '决策区',
    mindset: '哪些标的符合我的条件',
    backdrop: 'aurora',
    shell: 'console',
    prefixes: ['/screener', '/analyze'],
    migrated: false,
  },
  {
    key: 'consumer',
    label: '消费区',
    mindset: '现在发生了什么',
    backdrop: 'aurora',
    shell: 'stream',
    prefixes: ['/', '/stock', '/news', '/features', '/legal'],
    migrated: false,
  },
];

export const ZONES: Record<ZoneKey, ZoneMeta> = ZONE_LIST.reduce(
  (acc, z) => ({ ...acc, [z.key]: z }),
  {} as Record<ZoneKey, ZoneMeta>,
);

/**
 * 路由 → 功能区（最长前缀优先）。
 * 纯函数、无副作用 —— 便于在测试与调试中直接复用。
 */
export function zoneOfPath(pathname: string): ZoneKey {
  const p = pathname || '/';
  let best: { key: ZoneKey; len: number } | null = null;
  for (const z of ZONE_LIST) {
    for (const pre of z.prefixes) {
      const hit = p === pre || p.startsWith(pre === '/' ? '/' : `${pre}/`);
      if (hit && (!best || pre.length > best.len)) best = { key: z.key, len: pre.length };
    }
  }
  return best ? best.key : 'consumer';
}

/** 该功能区用哪种底 */
export const backdropOf = (zone: ZoneKey): BackdropKind => (ZONES[zone] || ZONES.consumer).backdrop;
