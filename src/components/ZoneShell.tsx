// ─────────────────────────────────────────────────────────────
// ZoneShell —— 功能区外壳（架构第一块砖 · 2026-10-05）
//
//   分层模型（对应设计评审的结论）：
//     theme.base        —— 语义层：涨红跌绿、单位、字号阶梯基准（全域不可分叉）
//     ZONE_VARS[zone]   —— 表现层：本区自己的底色/线色/圆角/间距/栏宽/字体族
//     ZoneShell         —— 骨架层：本区的容器与滚动模型
//
//   🔴 为什么用 CSS 变量而不是再造一套 theme 对象：
//     变量可被后代元素直接消费（`var(--zone-line)`），不必逐层透传 props；
//     且**只在 data-zone 作用域内生效**，天生不会污染其他功能区。
//   ⚠️ 未迁移的功能区不套此壳 ⇒ 旧页面渲染结果完全不变。
// ─────────────────────────────────────────────────────────────
import type { CSSProperties, ReactNode } from 'react';
import { theme } from '../lib/theme';
import { ZONES, type ZoneKey } from '../lib/zones';

/** 分区表现层令牌（只放"本区独有"的东西；语义色一律仍来自 theme.color） */
export const ZONE_VARS: Partial<Record<ZoneKey, Record<string, string>>> = {
  studio: {
    // 工作台比极光底更平、更中性：靠"线"而非"光"来分层
    '--zone-surface': '#0e1218',
    '--zone-surface-2': '#131822',
    '--zone-surface-3': '#182029',
    '--zone-line': '#222a36',
    '--zone-line-strong': '#35415a',
    '--zone-radius': '10px',
    '--zone-gap': '12px',
    '--zone-rail': '256px',
    '--zone-inspector': '372px',
    '--zone-mono': "Consolas, 'SF Mono', Menlo, monospace",
    // 工作台密度更高：同一屏要多放结构，不放大留白
    '--zone-pad': '14px',
  },
};

export default function ZoneShell({
  zone,
  children,
  style,
}: {
  zone: ZoneKey;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const vars = ZONE_VARS[zone];
  const meta = ZONES[zone];
  return (
    <div
      data-zone={zone}
      data-zone-shell={meta ? meta.shell : 'stream'}
      style={{
        ...theme.page,
        ...(vars as CSSProperties | undefined),
        ...style,
      }}
    >
      {children}
    </div>
  );
}
