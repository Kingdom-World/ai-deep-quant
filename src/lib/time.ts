// ─────────────────────────────────────────────────────────────
// 统一时间显示工具
//   后端一律存 ISO/UTC（toISOString），展示层必须经本工具转为浏览器本地时区。
//   禁止直接 slice ISO 字符串显示（会以 UTC 显示，比北京时间慢 8 小时）。
// ─────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

/** 解析为本地 Date；非法输入返回 null */
function toLocalDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** "YYYY-MM-DD HH:mm"（本地时区） */
export function fmtDateTime(iso: string | null | undefined): string {
  const d = toLocalDate(iso);
  if (!d) return String(iso ?? '');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "MM-DD HH:mm"（本地时区，列表场景） */
export function fmtShort(iso: string | null | undefined): string {
  const d = toLocalDate(iso);
  if (!d) return String(iso ?? '');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "HH:mm"（本地时区，图表轴） */
export function fmtClock(iso: string | null | undefined): string {
  const d = toLocalDate(iso);
  if (!d) return String(iso ?? '');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "YYYY-MM-DD"（本地时区） */
export function fmtDate(iso: string | null | undefined): string {
  const d = toLocalDate(iso);
  if (!d) return String(iso ?? '');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
