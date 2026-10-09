'use strict';
// ─────────────────────────────────────────────────────────────
// 出处自洽门的**检出力**验证（positive control）
//
// 🔴 这类"检查工具"的测试最容易写成假通过：
//   只断言「跑起来不报错」，无法证明它**抓得住**它声称要抓的缺陷。
//   本文件用**真实的本轮缺陷形态**做样本（不是虚构的最小用例），
//   断言每一种都能被抓到，且真实库当前是干净的。
//
// 本轮真实缺陷（2026-10-09，均为实际发生过的）：
//   ① 两篇论文共用一个 DOI（method-nice-vs-meaningful：RFS 的 DOI 挂在 DSR 名下）
//   ② 幻觉引用（Campbell 2011 查无此文，但刊名卷期齐全 ⇒ 形态上抓不到，
//      只能靠联网核验 —— 本文件**显式断言这一点**，防止误以为离线门能抓它）
//   ③ 说明文字被切进 source ⇒ 幽灵引用 + needs-doi 噪声
//   ④ DOI 手写笔误（形态不合法）
// ─────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const tool = require(path.join(ROOT, 'tools', 'check-source-integrity.cjs'));
const { parseSource } = require(path.join(ROOT, 'shared', 'knowledge-source.cjs'));

const { looksLikeComment, DOI_RE } = tool;

// ── ① 同 DOI 多标题（本轮真实发生）──
test('检出：同一 DOI 对应两个不同标题（两篇论文共用一个 DOI）', () => {
  const src = [
    '论文：Harvey, C. R., Liu, Y., & Zhu, H. (2016). ...and the Cross-Section of Expected Returns. Review of Financial Studies, 29(1), 5-68. DOI: 10.1093/rfs/hhv059.',
    '论文：Bailey, D. H. & López de Prado, M. (2014). The Deflated Sharpe Ratio. Journal of Portfolio Management, 40(5), 94-107. DOI: 10.1093/rfs/hhv059.',
  ].join('；');

  const seen = new Map();
  parseSource(src).refs.forEach((r) => {
    if (!r.doi) return;
    if (!seen.has(r.doi)) seen.set(r.doi, new Set());
    seen.get(r.doi).add(r.title);
  });
  const conflicted = [...seen.values()].filter((s) => s.size > 1);
  assert.strictEqual(conflicted.length, 1, '应识别出 1 个 DOI 一对多');
  assert.strictEqual(conflicted[0].size, 2);
});

// ── ③ 幽灵引用（本轮真实发生：注释被当成引用段）──
test('🔴 检出：说明文字被切进 source（幽灵引用）', () => {
  assert.ok(
    looksLikeComment('注：早前版本此处误引 Campbell, J.Y. (2011)《Estimating the Macroeconomic Determinants of Long-Term Yields》并附刊名卷期，该文经两轮 Crossref 检索均查无此文，判定为幻觉引用；替换时改用可机器核验的 Campbell & Shiller (1991)。'),
    '长注释段应被判为说明文字',
  );
});

test('不误报：官方公告与项目实现引用是合法的（无标题无 DOI 属正常）', () => {
  const legit = [
    '美国联邦储备委员会 2022 年公开市场操作声明（FOMC statements, 2022）',
    '本项目 server/crosssect.cjs（T-1 收盘排名、T 开盘成交、整手与同费率口径）。',
    '上海证券交易所与深圳证券交易所 2015 年 7-8 月关于临时停市与交易异常的公告',
    '中国人民银行 2013 年 6 月金融统计数据与公开市场操作公告',
    '官方规则依据同 term-limit-up-down（沪深北交易所交易规则价格涨跌幅条款）',
    '佣金费率由券商自主定价，万 2.5 为市场主流区间取值。',
    '相关市场数据可在本平台归档的行情序列中核对。',
  ];
  for (const s of legit) {
    assert.ok(!looksLikeComment(s), `不应误报：${s.slice(0, 30)}`);
  }
});

// ── ④ DOI 形态 ──
test('DOI 形态：接受真实存在的形态，拒绝手写笔误', () => {
  const good = [
    '10.1086/260061',
    '10.1016/0304-405x(93)90023-5',        // 旧刊用括号
    '10.1093/rfs/hhv059',
    '10.2307/1913610',
    '10.3905/jpm.2014.40.5.094',
    '10.21314/JOR.2001.041',
    '10.1111/j.1540-6261.1968.tb00815.x',
  ];
  const bad = [
    '11.1086/260061',                // 前缀错
    '10.1086',// 缺后缀
    'http://dx.doi.org/10.1086/260061',  // 混入 URL
    'doi:10.1086/260061',             // 混入前缀
    '10.1086/260061 extra',           // 带空格尾巴
    '',
  ];
  for (const d of good) assert.ok(DOI_RE.test(d), `应接受：${d}`);
  for (const d of bad) assert.ok(!DOI_RE.test(d), `应拒绝：${d}`);
});

test('🔴 能力边界：DOI 尾部多余路径段抓不到（旧刊斜杠 vs 手写多打一段无法区分）', () => {
  // 如实记录这条限制，防止未来误以为形态门能挡住它。
  // 曾试图收紧判据，结果**连正常 DOI 都拒**——`+` 写在字符类里被当成量词，
  // 导致 `-`/`$` 丢失（教训：字符类里的 `+ - ^` 必须转义或放末尾）。
  assert.ok(
    DOI_RE.test('10.1002/(SICI)1099-0522(199909)17:4<493::AID-CPA880>3.0.CO;2-T') === false,
    '含 < > 的极端形态本就不在字符集内 —— 说明形态门是保守子集，不是全集判定',
  );
  // 可确认的边界：单斜杠形态一律接受（真实旧刊需要），故尾部多段抓不到。
  assert.ok(DOI_RE.test('10.1086/260061/extra'), '已知限制：尾部多段不被拦，须联网核验');
});

// ── ② 离线门的**能力边界**：幻觉引用抓不到，必须说清 ──
// 这条断言是本文件最重要的部分：防止未来有人以为"离线门通过 = 出处没问题"。
test('🔴 能力边界：幻觉引用（文献不存在但刊名卷期齐全）离线门抓不到', () => {
  // 这正是本轮 case-2022-rate-hike 里的真实内容：
  // Campbell (2011) 在 Crossref 查无此文，但格式完全合规 ⇒ 离线门无能为力。
  const hallucinated =
    '论文：Campbell, J. Y. (2011). Estimating the Macroeconomic Determinants of Long-Term Yields. Journal of Finance, 66(6), 2253-2291.';
  const ref = parseSource(hallucinated).refs[0];
  assert.ok(ref.title, '标题能解析出来');
  assert.ok(ref.year === 2011, '年份能解析出来');
  assert.ok(ref.container, '刊名能解析出来');
  // 没有 DOI ⇒ 离线门的第一类检查（同 DOI 多标题）不适用；
  // 形态合法、字段齐全 ⇒ 离线门不会报警。
  //⇒ 唯一的发现手段是 tools/verify-sources.cjs 联网查 Crossref。
  assert.ok(!ref.doi, '无 DOI，故不在同 DOI 冲突检查范围内');
  assert.ok(!looksLikeComment(hallucinated), '也不是注释段');
  // 这三条合起来 = 离线门对幻觉引用无能为力（须联网核验）。
});

// ── 真实库当前必须干净 ──
test('真实知识库当前通过自洽门（0 问题）', () => {
  const { problems } = tool.collect();
  assert.deepStrictEqual(
    problems.map((p) => ({ kind: p.kind, where: p.where, msg: p.msg })),
    [],
    '真实库不应有问题：' + JSON.stringify(problems, null, 2),
  );
});

test('真实库的唯一 DOI 数量在合理区间（防止工具扫错文件/空转）', () => {
  const { byDoi } = tool.collect();
  assert.ok(byDoi.size >= 40, `唯一 DOI 仅 ${byDoi.size} 个，疑似扫漏`);
  assert.ok(byDoi.size <= 200, `唯一 DOI ${byDoi.size} 个，疑似解析异常`);
});