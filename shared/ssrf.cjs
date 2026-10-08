// ─────────────────────────────────────────────────────────────
// SSRF 目标地址判定（单一源 · 零 IO 纯函数）
//
//   用途：拦住「用户可自定义的 URL」指向**本机 / 内网 / 云元数据端点**。
//   典型场景：BYOK 的 base URL 由前端下送，若只校验 `^https?://`，
//   用户填内网地址即可让**我们的服务器**去打内网（经典 SSRF）。
//
//   🔴 为什么必须是"单一源"而不是各调用点自己写：
//     本项目已有 `server/ai/cloud.cjs` 的 `isLocalHostAllowed()`，但它的方向
//     **相反** —— 那是"**允许**本机/内网"（给本地兜底通道用的）。
//     两个方向搞混 ⇒ 有人会把"拒绝内网"写成"允许内网"的反面逻辑时顺手放宽。
//     故本文件显式区分 `isPublicEgressHost`（去程）与 cloud.cjs 的
//     `isLocalHostAllowed`（回程），互不复用、互不混淆。
//
//   🔴 威胁模型要诚实（别把它写成"万能防护"）：
//     · 本模块是**纯字符串判定**，不解析 DNS ⇒ **挡不住 DNS rebinding**
//       （攻击者让域名第一次解析到公网、第二次解析到 169.254.x.x）。
//       真要根治需"解析后再校验 IP + 锁定连接"，那是另一套机制。
//     · 但对"用户手填一个内网地址"这一**主路径**已足够 —— 而这正是我们的场景：
//       BYOK 的 base 由用户在输入框自己填，不是攻击者自动注入的 URL。
//     ⇒ 判定结论按"**防误用**"设计，不声称"防攻击"。
//
//   判定清单（全部**闭区间**判定，避免只挡前缀）：
//     · 环回：127.0.0.0/8、::1
//     · 私网：10/8、172.16/12、192.168/16、fc00::/7
//     · 链路本地：169.254/16（含云元数据 169.254.169.254）、fe80::/10
//     · 保留/文档段：0/8、100.64/10、192.0.0/24、198.18/15、240/4
//     · IPv4-mapped IPv6（::ffff:169.254.169.254）—— **不挡会被绕过**
//     · 十进制/八进制/十六进制混淆写法（2130706433、0177.0.0.1、0x7f000001）
//     · localhost 及任意 *.localhost / *.local / *.internal 等本地域名
// ─────────────────────────────────────────────────────────────
'use strict';

/** 云厂商元数据端点（最常见的 SSRF 目标，单独点名） */
const METADATA_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata.goog']);

/** 本机/本地域名后缀（DNS rebinding 之外，最常见的误用） */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.intranet'];

/** 单一字符类：IPv4 四段十进制（每段 0-255） */
const V4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';

/** 纯 IPv4 字面量（不匹配前导零的八进制写法，那是另外一条分支） */
const IPV4_RE = new RegExp(`^${V4_OCTET}\\.${V4_OCTET}\\.${V4_OCTET}\\.${V4_OCTET}$`);

/**
 * IPv6 字面量的粗判。
 * 🔴 字符类**必须含 `.`** —— IPv4-mapped 写法（`::ffff:169.254.169.254`）带点，
 *    早先漏了`.` 会让它**整条落空进不了IPv6 分支**（实测踩过），
 *    而这恰是最常见的元数据端点绕过形态。
 */
const _IPV6_RE_UNUSED = null; // 已由 expandIpv6 按数值判定替代（写法的正则判断会被 URL 规范化绕过）

/**
 * 把 host 归一为小写、去 IPv6 方括号、去 zone id（%eth0）。
 * @param {string} raw
 * @returns {string}
 */
function normalizeHost(raw) {
  let h = String(raw || '').trim().toLowerCase();
  if (!h) return '';
  // IPv6 字面量：[::1] / [::1%25eth0] ⇒ ::1
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end > 0) h = h.slice(1, end);
  }
  const pct = h.indexOf('%');
  if (pct > 0) h = h.slice(0, pct);
  // 🔴 去掉**尾部的点**（2026-10-08 审查发现并复现的绕过）：
  //   按 DNS 规范，`localhost.` ≡ `localhost`、`10.0.0.1.` ≡ `10.0.0.1`
  //   （尾点是合法 FQDN 写法，解析器会忽略）—— 而我们的字符串判定会
  //   因多一个点而**全部落空**：实测 `metadata.google.internal.` / `10.0.0.1.`
  //   / `127.0.0.1.` 六种写法 6/6 全放行，等于把整套防护变成摆设。
  while (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/**
 * 判断是否为"整数型" IPv4（十进制 / 八进制 / 十六进制混淆写法）。
 *   `2130706433` = 127.0.0.1（十进制）
 *   `0177.0.0.1` = 127.0.0.1（八进制）
 *   `0x7f000001` = 127.0.0.1（十六进制）
 * 🔴 不挡这类写法会被绕过 —— 很多手写过滤器就死在这里。
 * @returns {{ip:string, why:string}|null}
 */
function decodeIntHost(host) {
  // 十六进制（含 0x 前缀，整段形式）
  if (/^0x[0-9a-f]+$/.test(host)) {
    const n = parseInt(host.slice(2), 16);
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
      return { ip: intToIpv4(n), why: '十六进制整数型 IPv4' };
    }
  }
  // 纯十进制（无点、纯数字、且不是合法 IPv4）
  if (/^\d{1,10}$/.test(host)) {
    const n = Number(host);
    if (n <= 0xffffffff) return { ip: intToIpv4(n), why: '十进制整数型 IPv4' };
  }
  // 八进制点分：0177.0.0.1 / 0300.0250.0.1 / 0x...
  // 🔴 只有**首段**强制 `0` 前缀 —— 后三段是普通十进制 0。
  //    误写成 `(\.0[0-7]+){3}` 会让 `0177.0.0.1` 整条漏出、被当域名放行（实测踩过）。
  // 🔴 `{1,4}` 而非 `{1,3}` —— 4 位八进制段（0250=168）也合法（实测踩过）。
  const octalLike = /^0[0-7]+\.(?:[0-9]{1,4}\.){2}[0-9]{1,4}$/.test(host);
  if (octalLike) {
    const parts = host.split('.');
    const first = parseInt(parts[0], 8);                    // 首段按八进制解
    const rest = parts.slice(1).map((p) => (/^0[0-7]+$/.test(p) ? parseInt(p, 8) : Number(p)));
    if (Number.isFinite(first) && first <= 255 && parts[0].length > 1
        && rest.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)) {
      return { ip: [first, ...rest].join('.'), why: '八进制整数型 IPv4' };
    }
  }
  return null;
}

/** 32 位无符号整数 → 点分十进制 */
function intToIpv4(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/**
 * IPv4 是否属"不可对外出网"的保留段。
 * 🔴 用**数值区间**判定而非字符串前缀 —— `172.16` 也是前缀，
 *    但 `172.160.x.x` 不是私网（前缀写法会把它误判进去）。
 * @param {string} ip 点分十进制
 * @returns {{why:string}|null} 命中返回原因，未命中返回 null
 */
function blockedIpv4Reason(ip) {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    // 不是合法 IPv4 ⇒ 交给上层当"非 IP 字面量"处理（可能是域名）
    return null;
  }
  const [a, b] = parts;
  if (a === 0) return { why: '0/8 保留段' };
  if (a === 127) return { why: '127/8环回' };
  if (a === 10) return { why: '10/8 私网 A' };
  if (a === 172 && b >= 16 && b <= 31) return { why: '172.16/12 私网 B' };
  if (a === 192 && b === 168) return { why: '192.168/16 私网 C' };
  if (a === 169 && b === 254) return { why: '169.254/16 链路本地（含云元数据）' };
  if (a === 100 && b >= 64 && b <= 127) return { why: '100.64/10 CGNAT' };
  if (a === 192 && b === 0 && parts[2] === 0) return { why: '192.0.0/24 保留' };
  if (a === 198 && (b === 18 || b === 19)) return { why: '198.18/15 基准测试段' };
  if (a >= 224) return { why: '224/4 组播或 240/4 保留' };
  return null;
}

/**
 * 把 IPv6 字面量展开成 8 组 16 位十六进制数字（不做压缩还原，只为拿到数值）。
 * 🔴 **不能只看点分尾部** —— Node 的 `new URL()` 会把
 *    `[::ffff:169.254.169.254]` 规范化成 `[::ffff:a9fe:a9fe]`（十六进制！），
 *    点分正则永远匹配不上（实测踩过 ⇒ 绕过成立）。
 *    ⇒ 必须先把整串解析成数值，再逐段判。
 * @param {string} host 已归一（无方括号/zone）
 * @returns {number[]|null} 8 个 [0..65535]；不是合法 IPv6 返回 null
 */
function expandIpv6(host) {
  if (!host.includes(':')) return null;
  if (!/^[0-9a-f:.]+$/i.test(host)) return null;      // 只允许 hex/冒号/点（内嵌 v4）
  if ((host.match(/::/g) || []).length > 1) return null; // 至多一处`::`

  const [leftRaw, rightRaw] = host.split('::');
  const toGroups = (s) => (s ? s.split(':').filter((x) => x !== '') : []);

  const left = toGroups(leftRaw);
  const right = rightRaw === undefined ? [] : toGroups(rightRaw);

  // 尾部内嵌 IPv4（点分）⇒ 展开成 2 组
  const tailToGroups = (arr) => {
    if (!arr.length) return arr;
    const last = arr[arr.length - 1];
    if (!last.includes('.')) return arr;
    const parts = last.split('.');
    if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
    const n = parts.map(Number);
    return [...arr.slice(0, -1), ((n[0] << 8) | n[1]).toString(16), ((n[2] << 8) | n[3]).toString(16)];
  };
  const l = tailToGroups(left);
  const r = rightRaw === undefined ? [] : tailToGroups(right);
  if (!l || !r) return null;

  if (rightRaw === undefined) {
    // 无 `::`：必须正好 8 组
    return l.length === 8 ? l.map((g) => parseInt(g, 16)) : null;
  }
  // 有 `::`：中间补 0
  const fill = 8 - l.length - r.length;
  if (fill < 0) return null;
  const all = [...l, ...Array(fill).fill('0'), ...r];
  return all.map((g) => parseInt(g, 16));
}

/**
 * IPv6 字面量是否属不可对外出网的段（**按数值**判定，不看写法）。
 * @param {string} host 已归一（去方括号/zone）的 IPv6 字面量
 * @returns {{why:string}|null}
 */
function blockedIpv6Reason(host) {
  const g = expandIpv6(host);
  if (!g) return null;                       // 不是 IPv6 字面量 ⇒ 交给上层

  const isZeroPrefix = g.slice(0, 5).every((x) => x === 0);
  // 内嵌 IPv4 的两种形态：::ffff:a.b.c.d（mapped，g[5]=0xffff）与 ::a.b.c.d（compatible，g[5]=0）。
  // 🔴 判据是「前 5 组全零」+ 第 6 组是 0 或 0xffff —— 不是 slice(0,6) 全零
  //    （mapped 的 g[5]=0xffff 本就非零，实测写成 slice(0,6) 会让判定整个失效）。
  // 🔴 命中内嵌私网时返回理由，但**内嵌公网不能提前 return null** ——
  //    提前返回会连带跳过后面的 ::1 / fe80 等判定（实测踩过：[::1] 被放行）。
  if (isZeroPrefix && (g[5] === 0xffff || g[5] === 0)) {
    const octets = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
    const r = blockedIpv4Reason(octets.join('.'));
    const label = g[5] === 0xffff ? 'IPv4-mapped IPv6' : 'IPv4-compatible IPv6';
    if (r) return { why: `${label}（内嵌 ${octets.join('.')}：${r.why}）` };
  }
  const allZero = g.every((x) => x === 0);
  if (allZero) return { why: '未指定地址' };
  if (isZeroPrefix && g[5] === 1) return { why: '::1 环回' };
  // fc00::/7 ⇒ 首组高 7 位为 1111110（0xfc00-0xfdff）
  if ((g[0] & 0xfe00) === 0xfc00) return { why: 'fc00::/7 唯一本地地址' };
  // fe80::/10 ⇒ 首组前 10 位为 1111111010
  if ((g[0] & 0xffc0) === 0xfe80) return { why: 'fe80::/10 链路本地' };
  return null;
}

/**
 * 🔴 主判定：host 是否可以对外发起请求。
 * @param {string} rawHost URL 的 host 部分
 * @returns {{ok:true} | {ok:false, why:string}}
 */
function isPublicEgressHost(rawHost) {
  const host = normalizeHost(rawHost);
  if (!host) return { ok: false, why: '缺少 host' };

  // ① 点名拦截（云元数据 / 本机别名）
  if (METADATA_HOSTS.has(host)) return { ok: false, why: '云元数据端点' };
  if (host === 'localhost') return { ok: false, why: 'localhost' };
  for (const suf of LOCAL_SUFFIXES) {
    if (host.endsWith(suf)) return { ok: false, why: `本地域名后缀 ${suf}` };
  }

  // ② IPv6 字面量**先判**（含内嵌 IPv4 形态）。
  //    🔴 顺序不能颠倒：Node 的 URL 会把 `::ffff:169.254.169.254` 规范化成
  //    `::ffff:a9fe:a9fe`，若先走"是不是域名"的判断就会漏到这里之后。
  if (host.includes(':')) {
    const v6 = blockedIpv6Reason(host);
    if (v6) return { ok: false, why: `${host}（${v6.why}）` };
  }

  // ③ 混淆写法先解码再判（否则会绕过 IPv4 分支）
  const asInt = decodeIntHost(host);
  if (asInt) {
    const r = blockedIpv4Reason(asInt.ip);
    return r ? { ok: false, why: `${asInt.why} → ${asInt.ip}（${r.why}）` } : { ok: true };
  }

  // ④ IPv4 字面量
  if (IPV4_RE.test(host)) {
    const r = blockedIpv4Reason(host);
    return r ? { ok: false, why: `${host}（${r.why}）` } : { ok: true };
  }

  // ⑤ 其余当普通域名放行（🔴 挡不住 DNS rebinding，见文件头声明）
  return { ok: true };
}

/**
 * 校验一个用户可自定义的 URL 能否作为对外请求目标。
 * 协议仅允许 http/https —— `file:`/`gopher:`/`dict:` 同样是 SSRF 武器。
 * @param {unknown} rawUrl
 * @returns {{ok:true, url:string} | {ok:false, why:string}}
 */
function assertPublicEgressUrl(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return { ok: false, why: '缺少 URL' };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, why: 'URL 格式非法' };
  }
  const proto = u.protocol.toLowerCase();
  if (proto !== 'http:' && proto !== 'https:') {
    return { ok: false, why: `协议 ${proto} 不允许（仅 http/https）` };
  }
  const host = isPublicEgressHost(u.hostname);
  if (!host.ok) return host;
  return { ok: true, url: s };
}

module.exports = {
  assertPublicEgressUrl,
  isPublicEgressHost,
  normalizeHost,
  blockedIpv4Reason,
  blockedIpv6Reason,
  decodeIntHost,
  METADATA_HOSTS,
};