// ─────────────────────────────────────────────────────────────
// 标的代码归一化（纯函数，与 server/index.cjs toTencentCode 语义一致）
//   · 已带前缀 sh|sz|bj|hk（不分大小写）→ 统一小写返回
//   · us 前缀 → 保持 us + 原名
//   · 6 位纯数字 → 北交所段(43/83/87/88/92) → bj，否则 6/9 开头 → sh，其余 → sz
//   · 5 位纯数字 → hk 前缀
//   · 其他（美股字母代码）→ us + 大写
//   · 空值 / 非字符串 / 空串 → 返回空串
// 注意：本模块为纯函数，不依赖 index.cjs 的在线行情链路，可独立测试。
// ─────────────────────────────────────────────────────────────
function normalizeSymbol(symbol) {
  if (typeof symbol !== 'string') return '';
  const raw = String(symbol).trim();
  if (raw === '') return '';
  const lower = raw.toLowerCase();
  if (/^(sh|sz|bj|hk)/.test(lower)) return lower; // bj = 北交所（920/43/83/87/88 开头）
  if (/^us/i.test(lower)) return `us${raw.slice(2)}`;
  if (/^\d{6}$/.test(raw)) {
    if (/^(43|83|87|88|92)/.test(raw)) return `bj${raw}`; // 北交所代码段
    return /^[69]/.test(raw) ? `sh${raw}` : `sz${raw}`;
  }
  if (/^\d{5}$/.test(raw)) return `hk${raw}`;
  return `us${raw.toUpperCase()}`;
}

module.exports = { normalizeSymbol };
