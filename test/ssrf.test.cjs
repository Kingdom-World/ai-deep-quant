// SSRF 判定（shared/ssrf.cjs）—— 覆盖绕过写法，不是只测"内网被拦"
//
// 🔴 这个门禁的特点：**漏拦不会报错**，用户填个内网地址就悄悄打到了。
//    所以用例必须覆盖「看起来像外网、实际是内网」的混淆写法，
//    并且每条都做过 positive control（把实现改坏 → 对应用例必须红）。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { assertPublicEgressUrl, isPublicEgressHost, normalizeHost, blockedIpv4Reason,
  blockedIpv6Reason, decodeIntHost } = require('../shared/ssrf.cjs');
const { normalizeByokOverride } = require('../server/agents/byok.cjs');

// ── 真实公网供应商（绝不能误杀，这是门禁"过宽"的方向）──────────
const MUST_PASS = [
  'https://open.bigmodel.cn/api/paas/v4',
  'https://api.siliconflow.cn/v1',
  'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'https://api.example.com/v1',
  'https://1.2.3.4/v1',              // 公网 IP
  'https://[2001:4860:4860::8888]/v1', // 公网 IPv6
];

// ── 必须拦下的（SSRF 武器库）─────────────────────────────────────
const MUST_BLOCK = [
  ['http://localhost:8080/v1', 'localhost'],
  ['http://127.0.0.1:8080/v1', '环回'],
  ['http://[::1]:8080/v1', 'IPv6 环回'],
  ['http://10.0.0.5/v1', '私网 A'],
  ['http://172.16.0.1/v1', '私网 B 下界'],
  ['http://172.31.255.254/v1', '私网 B 上界'],
  ['http://192.168.1.1/v1', '私网 C'],
  ['http://169.254.169.254/latest/meta-data/', '云元数据'],
  ['http://[::ffff:169.254.169.254]/v1', 'IPv4-mapped 元数据'],
  ['http://2130706433/v1', '十进制整数型 127.0.0.1'],
  ['http://0177.0.0.1/v1', '八进制整数型'],
  ['http://0x7f000001/v1', '十六进制整数型'],
  ['http://metadata.google.internal/v1', 'GCP 元数据域名'],
  ['http://foo.local/v1', '.local 后缀'],
  ['http://db.internal/v1', '.internal 后缀'],
  ['http://0.0.0.0/v1', '0/8 保留'],
  ['http://100.64.0.1/v1', 'CGNAT'],
  ['http://198.18.0.1/v1', '基准测试段'],
  ['http://0300.0250.0.1/v1', '八进制私网 C（192.168.0.1）'],
  ['http://[::7f00:1]/v1', '纯十六进制 IPv6 环回'],
  ['http://[::a00:1]/v1', '纯十六进制 IPv6 私网 A'],
  ['file:///etc/passwd', 'file 协议'],
  ['gopher://127.0.0.1:11211/', 'gopher 协议'],
];

test('公网目标一律放行（门禁不能过窄）', () => {
  for (const u of MUST_PASS) {
    const r = assertPublicEgressUrl(u);
    assert.strictEqual(r.ok, true, `不该拦：${u}（原因 ${r.why}）`);
  }
});

test('内网/协议类武器一律拦下', () => {
  for (const [u, label] of MUST_BLOCK) {
    const r = assertPublicEgressUrl(u);
    assert.strictEqual(r.ok, false, `该拦没拦：${u}（${label}）`);
  }
});

test('blockedIpv4Reason 用区间而非前缀判定', () => {
  // 前缀写法会把 172.160.x误判进私网 B —— 这是真实存在的经典 bug
  assert.strictEqual(blockedIpv4Reason('172.160.0.1'), null, '172.160 不属 172.16/12');
  assert.strictEqual(blockedIpv4Reason('172.15.0.1'), null, '172.15 不属 172.16/12');
  assert.ok(blockedIpv4Reason('172.16.0.1'), '172.16 属私网 B');
  assert.ok(blockedIpv4Reason('172.31.255.255'), '172.31 属私网 B');
  assert.strictEqual(blockedIpv4Reason('11.0.0.1'), null, '11 不以 10. 开头');
  assert.strictEqual(blockedIpv4Reason('9.255.255.255'), null, '9 不能被"10"前缀误伤');
});

test('IPv4-mapped IPv6 不能绕过（::ffff:169.254.169.254）', () => {
  assert.ok(blockedIpv6Reason('::ffff:169.254.169.254'), '必须拦下');
  assert.ok(blockedIpv6Reason('::ffff:127.0.0.1'), '映射环回也要拦');
  assert.strictEqual(blockedIpv6Reason('::ffff:8.8.8.8'), null, '映射的公网 IP 应放行');
});

test('🔴 Node 的 URL 会把内嵌 IPv4 规范化成十六进制（实测最危险的绕过形态）', () => {
  // new URL('http://[::ffff:169.254.169.254]/v1').hostname === '[::ffff:a9fe:a9fe]'
  //⇒ 任何"正则匹配点分尾部"的实现都会漏检；必须按数值展开后判
  assert.strictEqual(new URL('http://[::ffff:169.254.169.254]/v1').hostname, '[::ffff:a9fe:a9fe]');
  // 两种写法都必须拦下
  assert.strictEqual(assertPublicEgressUrl('http://[::ffff:169.254.169.254]/v1').ok, false, '点分写法要拦');
  assert.strictEqual(assertPublicEgressUrl('http://[::ffff:a9fe:a9fe]/v1').ok, false, '十六进制写法也要拦');
  // 纯十六进制（无::ffff 前缀的 ::7f00:1 = 127.0.0.1）
  assert.strictEqual(assertPublicEgressUrl('http://[::7f00:1]/v1').ok, false, '::7f00:1 要拦');
  assert.strictEqual(assertPublicEgressUrl('http://[::a00:1]/v1').ok, false, '::a00:1 = 10.0.0.1 要拦');
});

test('内嵌公网 IPv6 不能被提前 return 误伤（实测[::1] 曾因此被放行）', () => {
  assert.strictEqual(assertPublicEgressUrl('http://[::ffff:8.8.8.8]/v1').ok, true, '内嵌公网应放行');
  assert.strictEqual(assertPublicEgressUrl('http://[::1]:8080/v1').ok, false, '但 ::1 环回仍必须拦');
  assert.strictEqual(assertPublicEgressUrl('http://[0:0:0:0:0:0:0:1]/v1').ok, false, '全展开写法也要拦');
});

test('IPv6 保留段按数值判（不靠写法正则）', () => {
  for (const u of ['http://[::]/v1', 'http://[fe80::1]/v1', 'http://[fc00::1]/v1', 'http://[fd00::1]/v1']) {
    assert.strictEqual(assertPublicEgressUrl(u).ok, false, `该拦：${u}`);
  }
  assert.strictEqual(assertPublicEgressUrl('http://[2001:4860:4860::8888]/v1').ok, true, '公网 IPv6 放行');
});

test('整数型混淆写法被解码后再判，而不是当域名放行', () => {
  assert.strictEqual(decodeIntHost('2130706433').ip, '127.0.0.1');
  assert.strictEqual(decodeIntHost('0x7f000001').ip, '127.0.0.1');
  // 🔴 只有**首段**带八进制前缀，后三段是普通十进制 0 —— 写成`(\.0[0-7]+){3}` 会整条漏出
  assert.strictEqual(decodeIntHost('0177.0.0.1').ip, '127.0.0.1');
  // 4 位八进制段（0250=168）⇒ 0300.0250.0.1 = 192.168.0.1（私网 C）
  assert.strictEqual(decodeIntHost('0300.0250.0.1').ip, '192.168.0.1');
  // 真实公网 IP 的十进制形式应放行，别把门关死
  assert.strictEqual(isPublicEgressHost('134744072').ok, true, '8.8.8.8 的十进制应放行');
  assert.strictEqual(isPublicEgressHost('8.8.8.8').ok, true);
});

test('八进制形态：010.0.0.1 解成 8.0.0.1（公网）应放行，别一律当私网', () => {
  assert.strictEqual(decodeIntHost('010.0.0.1').ip, '8.0.0.1');
  assert.strictEqual(isPublicEgressHost('010.0.0.1').ok, true, '8.0.0.1 是公网地址');
});

test('normalizeHost 归一：IPv6 方括号 / zone id / 大小写', () => {
  assert.strictEqual(normalizeHost('[::1]'), '::1');
  assert.strictEqual(normalizeHost('[fe80::1%25eth0]'), 'fe80::1');
  assert.strictEqual(normalizeHost('LOCALHOST'), 'localhost');
  assert.strictEqual(normalizeHost('  10.0.0.1 '), '10.0.0.1');
});

test('非法 URL / 空值不抛异常，判为不可用（fail closed）', () => {
  for (const v of ['', null, undefined, 'not a url', '://x', 123]) {
    const r = assertPublicEgressUrl(v);
    assert.strictEqual(r.ok, false, `应判不可用：${JSON.stringify(v)}`);
  }
});

// ── 以下三条针对**各自独立的那道门**（否则会被别的门"顺手拦下"而测不出）──

test('协议白名单单独考核：用公网 host 排除区间判定的干扰', () => {
  // host 是**公网 IP** ⇒ 内网区间判定完全够不着，只有协议门能拦
  for (const u of ['ftp://8.8.8.8/x', 'gopher://8.8.8.8:11211/', 'file:///etc/passwd', 'dict://8.8.8.8:11211/']) {
    const r = assertPublicEgressUrl(u);
    assert.strictEqual(r.ok, false, `协议门未拦：${u}`);
    assert.match(r.why, /协议/, `理由应是协议而非地址：${r.why}`);
  }
});

test('元数据域名单独考核：用非内网 IP 形态排除区间判定的干扰', () => {
  // metadata.google.internal 是**域名**，解析到公网 IP 也可能 ⇒ 只有点名表能拦
  for (const h of ['metadata.google.internal', 'metadata.goog']) {
    const r = isPublicEgressHost(h);
    assert.strictEqual(r.ok, false, `元数据域名未拦：${h}`);
    assert.match(r.why, /元数据/, `理由应是元数据端点：${r.why}`);
  }
});

test('整数型解码单独考核：公网整型必须放行（区间判定对整型够不着）', () => {
  // 134744072 = 8.8.8.8。若不先解码，它会被当普通域名放行（碰巧对），
  // 但若解码逻辑坏了，私有整型（2130706433）就会漏过 ⇒ 必须两条一起断言
  assert.strictEqual(isPublicEgressHost('134744072').ok, true, '公网整型应放行');
  assert.strictEqual(isPublicEgressHost('2130706433').ok, false, '私有整型必须拦下');
  assert.strictEqual(isPublicEgressHost('0x7f000001').ok, false, '十六进制环回必须拦下');
});

// ── 集成到 normalizeByokOverride：闸门真的在链路上 ──────────────
test('normalizeByokOverride：内网 base 返回 null（闸门在链路上）', () => {
  const bad = [
    'http://127.0.0.1:8080/v1',
    'http://169.254.169.254/',
    'http://[::ffff:169.254.169.254]/v1',
    'http://10.1.2.3/v1',
    'file:///etc/passwd',
  ];
  for (const base of bad) {
    assert.strictEqual(normalizeByokOverride({ provider: 'custom', base, key: 'k'.repeat(20), model: 'm' }), null,
      `闸门未拦住：${base}`);
  }
});

test('normalizeByokOverride：正常公网配置照常通过（别把功能打死）', () => {
  const ok = normalizeByokOverride({
    provider: 'zhipu', base: 'https://open.bigmodel.cn/api/paas/v4/', key: 'k'.repeat(20), model: 'glm-4.7-flash',
  });
  assert.ok(ok, '合法配置必须通过');
  assert.strictEqual(ok.base, 'https://open.bigmodel.cn/api/paas/v4', '尾部斜杠应被去掉');
});

test('normalizeByokOverride：原有铁律未被SSRF 改动破坏', () => {
  assert.strictEqual(normalizeByokOverride(null), null);
  assert.strictEqual(normalizeByokOverride({ base: 'https://a.com', key: '', model: 'm' }), null, '缺 key 仍拒');
  assert.strictEqual(normalizeByokOverride({ base: 'https://a.com', key: 'k', model: '' }), null, '缺 model 仍拒');
  assert.strictEqual(normalizeByokOverride({ base: 'ftp://a.com', key: 'k', model: 'm' }), null, '非 http(s) 仍拒');
  assert.strictEqual(normalizeByokOverride({ base: `https://a.com/${'x'.repeat(400)}`, key: 'k', model: 'm' }), null, '超长仍拒');
});
// ─────────────────────────────────────────────────────────────
// 尾点绕过（2026-10-08 审查发现并复现）
//
// 🔴 按 DNS 规范 `localhost.` ≡ `localhost`（尾点是合法 FQDN 写法，
//    解析器会忽略它）。我们的判定基于字符串 ⇒ 多一个点就全部落空。
//    实测修复前 6/6 全放行（含元数据端点），等于防护形同虚设。
// ─────────────────────────────────────────────────────────────

test('🔴 尾点绕过：所有内网形态加尾点仍必须拦下', () => {
  const bypasses = [
    'http://localhost./v1',
    'http://foo.local./v1',
    'http://db.internal./v1',
    'http://metadata.google.internal./v1',
    'http://127.0.0.1./v1',
    'http://10.0.0.1./v1',
    'http://192.168.1.1./v1',
    'http://169.254.169.254./latest/meta-data/',
  ];
  for (const u of bypasses) {
    assert.strictEqual(assertPublicEgressUrl(u).ok, false, `尾点绕过未拦：${u}`);
  }
});

test('尾点绕过：多重尾点也要拦（DNS 允许 fqdn.. 形式）', () => {
  assert.strictEqual(assertPublicEgressUrl('http://localhost../v1').ok, false);
  assert.strictEqual(assertPublicEgressUrl('http://10.0.0.1.../v1').ok, false);
});

test('尾点修复不能把公网也拦掉（防过窄）', () => {
  assert.strictEqual(assertPublicEgressUrl('https://api.example.com./v1').ok, true, '公网域名带尾点应放行');
  assert.strictEqual(assertPublicEgressUrl('https://open.bigmodel.cn/api/paas/v4').ok, true);
});

test('normalizeHost：尾点归一后与无尾点写法等价', () => {
  assert.strictEqual(normalizeHost('localhost.'), 'localhost');
  assert.strictEqual(normalizeHost('10.0.0.1.'), '10.0.0.1');
  assert.strictEqual(normalizeHost('LOCALHOST.'), 'localhost');
});
