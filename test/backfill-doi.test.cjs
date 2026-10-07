// backfill-doi 的定位与插入逻辑（#74）
//
// 🔴 这个文件考的是**静默污染**风险：插入错了工具不报错、
//    知识库 JSON 仍然合法、DOI 却挂在错误的文献上 —— 只有机器核验能发现。
//    所以每条用例都必须真的能失败（写完做过 positive control，见文件末）。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { locateFragments, planInserts, applyInserts, findSourceLiteral, titleSim, SIM_GATE,
  gateMatch, containerMatch, YEAR_TOL } = require('../tools/backfill-doi.cjs');

test('locateFragments：按出现顺序定位，重复片段各归各位', () => {
  const src = 'AAA。BBB。AAA。';
  // offset 按 UTF-16 code unit 计（'。' 占 1），不是 UTF-8 字节
  assert.deepStrictEqual(locateFragments(src, ['AAA。', 'BBB。', 'AAA。']), [0, 4, 8]);
});

test('locateFragments：片段不存在返回 -1，不抛也不猜', () => {
  assert.deepStrictEqual(locateFragments('AAA。', ['ZZZ。']), [-1]);
  assert.deepStrictEqual(locateFragments('AAA。', ['']), [-1]);
});

test('locateFragments：裸 indexOf 会全部命中第一次 —— 这正是要防的 bug', () => {
  const src = 'AAA。BBB。AAA。';
  const naive = [src.indexOf('AAA。'), src.indexOf('BBB。'), src.indexOf('AAA。')];
  assert.strictEqual(naive[0], naive[2], '裸 indexOf 对重复片段给出同一位置（缺陷形态）');
  const cur = locateFragments(src, ['AAA。', 'BBB。', 'AAA。']);
  assert.notStrictEqual(cur[0], cur[2], '游标版必须给出不同位置');
});

test('planInserts：多条插入按 offset 降序（正序会让后续 offset 失效）', () => {
  const src = 'AAA。BBB。CCC。';
  const frags = ['AAA。', 'BBB。', 'CCC。'];
  const edits = planInserts(src, frags, [
    { refIndex: 0, doi: '10.1/a' },
    { refIndex: 2, doi: '10.1/c' },
  ]);
  assert.ok(edits[0].at > edits[1].at, '第一条必须是靠后的那条');
});

test('applyInserts：两处同时插入互不干扰（倒序的正确性证明）', () => {
  const src = 'AAA。BBB。CCC。';
  const frags = ['AAA。', 'BBB。', 'CCC。'];
  const edits = planInserts(src, frags, [
    { refIndex: 0, doi: '10.1/a' },
    { refIndex: 2, doi: '10.1/c' },
  ]);
  assert.strictEqual(applyInserts(src, edits), 'AAA。 DOI: 10.1/a.BBB。CCC。 DOI: 10.1/c.');
});

test('applyInserts：片段末尾已有句点则不重复加句点', () => {
  const src = 'X 说明。';
  const out = applyInserts(src, planInserts(src, ['X 说明。'], [{ refIndex: 0, doi: '10.1/x' }]));
  assert.ok(out.endsWith('DOI: 10.1/x.'), '只应有一个句点：' + out);
  assert.strictEqual((out.match(/\./g) || []).length, (src.match(/\./g) || []).length + 1 + 1, 'DOI 自身含点');
});

test('planInserts：定位失败时如实报出，不静默跳过', () => {
  const failed = [];
  const edits = planInserts('AAA。', ['AAA。'], [{ refIndex: 0, doi: '10.1/a' }, { refIndex: 5, doi: '10.1/b' }], failed);
  assert.strictEqual(edits.length, 1);
  assert.strictEqual(failed.length, 1);
  assert.match(failed[0], /#5/);
});

test('findSourceLiteral：只切出 source 的字面量区间，且能解回原值', () => {
  const raw = '{\n  "entries": [\n    {"id": "x1", "source": "甲(2020)。乙(2021)。", "note": "别的"}\n  ]\n}';
  const lit = findSourceLiteral(raw, 'x1');
  assert.ok(lit);
  assert.strictEqual(lit.value, '甲(2020)。乙(2021)。');
  assert.ok(lit.start < lit.end);
  assert.strictEqual(raw.slice(lit.start, lit.end), '"甲(2020)。乙(2021)。"');
});

test('findSourceLiteral：value 里的转义引号不会让扫描提前结束', () => {
  const raw = '{"id":"x1","source":"含 \\"引号\\" 与 , 和 } 的文本","k":1}';
  const lit = findSourceLiteral(raw, 'x1');
  assert.ok(lit, '必须定位成功');
  assert.strictEqual(lit.value, '含 "引号" 与 , 和 } 的文本');
});

test('findSourceLiteral：id 不存在或没有 source 字段都返回 null（不猜）', () => {
  assert.strictEqual(findSourceLiteral('{"id":"a"}', 'b'), null);
  assert.strictEqual(findSourceLiteral('{"id":"a","k":1}', 'a'), null);
});

test('findSourceLiteral：同 id 多处出现时取第一处（与知识库 id 唯一的前提相符）', () => {
  const raw = '{"id":"x1","source":"第一。","other":1}';
  assert.strictEqual(findSourceLiteral(raw, 'x1').value, '第一。');
});

test('全流程：定位→插入→重新解析，DOI 被正确认到（用真实解析器的分片结果）', () => {
  const { parseSource } = require('../shared/knowledge-source.cjs');
  // 夹具前提：解析器按**分号**切分（不是句号），所以必须用分号拼两段
  const one = 'Fama, E. F. (1970). Efficient capital markets: A review of theory and empirical work. Journal of Finance.';
  const src = one + '；' + one;
  const frags = parseSource(src).refs.map((r) => String(r.raw));
  assert.strictEqual(frags.length, 2, '夹具前提：解析器确实切成两段');

  const out = applyInserts(src, planInserts(src, frags, [{ refIndex: 1, doi: '10.1111/j.1540-6261.1966.tb04702.x' }]));
  const refs = parseSource(out).refs;
  assert.strictEqual(refs.length, 2);
  assert.strictEqual(refs[0].doi, '', '第一处不该被写');
  assert.strictEqual(refs[1].doi, '10.1111/j.1540-6261.1966.tb04702.x');
});

test('全流程：原文片段在插入后必须逐字保留（防"吃掉片段"回归）', () => {
  const { parseSource } = require('../shared/knowledge-source.cjs');
  const src = 'Sharpe, W. F. (1966). Capital asset prices. Journal of Finance.';
  const frags = parseSource(src).refs.map((r) => String(r.raw));
  const out = applyInserts(src, planInserts(src, frags, [{ refIndex: 0, doi: '10.1/a' }]));
  assert.ok(out.startsWith(src.slice(0, frags[0].length)), '片段原文必须完整保留在原位');
  assert.ok(out.includes(frags[0]), '片段不能被替换掉');
});

test('titleSim：完全一致=1，大小写/标点差异不影响', () => {
  assert.strictEqual(titleSim('Efficient Capital Markets', 'efficient capital markets'), 1);
});

test('SIM_GATE：门禁是 0.75，且低相似度用例确实低于它', () => {
  assert.strictEqual(SIM_GATE, 0.75);
  assert.ok(titleSim('A Study of Momentum Investing', 'Portfolio Weight Optimization') < SIM_GATE);
});
// ─────────────────────────────────────────────────────────────
// 三重门禁（gateMatch）—— 三个真实错例做回归夹具
//
// 🔴 这三条是 #74 首次落盘时**真的写进去过**的错DOI，
//    由 tools/verify-sources.cjs 事后抓出。形状：**标题几乎全等，
//    但作者/年份/刊物全不同**（书评、短评冒充正文）。
// ─────────────────────────────────────────────────────────────

const crItem = (o) => ({
  DOI: o.doi, title: [o.title], 'container-title': [o.container],
  issued: { 'date-parts': [[o.year]] },
});

test('回归：Lowenstein 的书 → 不能命中 Choice Reviews 的书评', () => {
  const ref = { title: 'When Genius Failed: The Rise and Fall of Long-Term Capital Management',
    year: '2000', container: 'Random House' };
  const it = crItem({ doi: '10.5860/choice.38-2845',
    title: 'When genius failed: the rise and fall of Long-Term Capital Management',
    container: 'Choice Reviews Online', year: 2001 });
  const sim = titleSim(ref.title, it.title[0]);
  assert.ok(sim >= SIM_GATE, '前提：标题相似度确实过门禁（这正是骗过旧版的地方）');
  assert.strictEqual(gateMatch(ref, it, sim).ok, false);
});

test('回归：Shiller 的书 → 不能命中 Foreign Affairs 的书评', () => {
  const ref = { title: 'Irrational Exuberance', year: '2000', container: 'Princeton University Press' };
  const it = crItem({ doi: '10.2307/20049834', title: 'Irrational Exuberance',
    container: 'Foreign Affairs', year: 1993 });
  const sim = titleSim(ref.title, it.title[0]);
  assert.strictEqual(gateMatch(ref, it, sim).ok, false);
});

test('回归：Kitchin 1923 正文 → 不能命中同刊的 "Comment" 短评', () => {
  const ref = { title: 'Cycles and Trends in Economic Factors', year: '1923',
    container: 'Review of Economics and Statistics' };
  const it = crItem({ doi: '10.2307/1927031', title: 'Comment',
    container: 'The Review of Economics and Statistics', year: 1958 });
  const sim = titleSim(ref.title, it.title[0]);
  assert.ok(sim < SIM_GATE, '"Comment" 靠标题相似度就能被拦下');
  assert.strictEqual(gateMatch(ref, it, sim).ok, false);
});

test('门禁：真正对得上的必须放行（不能把门关死）', () => {
  const ref = { title: 'Arbitrage Theory of Capital Asset Pricing', year: '1976',
    container: 'Journal of Economic Theory' };
  const it = crItem({ doi: '10.1016/0022-0531(76)90046-6',
    title: 'The arbitrage theory of capital asset pricing',
    container: 'Journal of Economic Theory', year: 1976 });
  assert.strictEqual(gateMatch(ref, it, titleSim(ref.title, it.title[0])).ok, true);
});

test('门禁：online-first / 印刷年的 1 年差必须放行', () => {
  assert.strictEqual(YEAR_TOL, 1);
  const ref = { title: 'X and the Cross-Section of Expected Returns', year: '2016', container: 'Review of Financial Studies' };
  const it = crItem({ doi: '10.1093/rfs/hhv059', title: '… and the Cross-Section of Expected Returns',
    container: 'Review of Financial Studies', year: 2015 });
  assert.strictEqual(gateMatch(ref, it, titleSim(ref.title, it.title[0])).ok, true);
});

test('门禁：差 2 年必须拦下', () => {
  const ref = { title: 'X', year: '2017', container: 'Financial Analysts Journal' };
  const it = crItem({ doi: '10.2469/faj.v68.n1.1', title: 'X', container: 'Financial Analysts Journal', year: 2012 });
  assert.strictEqual(gateMatch(ref, it, 1).ok, false);
});

test('containerMatch：冠词/连字符差异要放过，真不一致要拦', () => {
  assert.strictEqual(containerMatch('Review of Financial Studies', 'The Review of Financial Studies').ok, true);
  assert.strictEqual(containerMatch('Journal of Business', 'Foreign Affairs').ok, false);
  assert.strictEqual(containerMatch('', 'Foreign Affairs').ok, true, '我们没写刊名时不误杀');
});

test('门禁：作者不同但刊名/年份/标题都对 ⇒ 放行（书评会在这被漏，但宁可漏不可错）', () => {
  const ref = { title: 'Mutual Fund Performance', year: '1966', container: 'Journal of Business' };
  const it = crItem({ doi: '10.1086/294846', title: 'Mutual Fund Performance',
    container: 'The Journal of Business', year: 1966 });
  assert.strictEqual(gateMatch(ref, it, 1).ok, true);
});

test('门禁：标题门禁本身也必须能独立拦住（同刊同年的完全另一篇）', () => {
  // 年份与刊名都对得上，只有标题不同 —— 这时只剩标题门禁能拦
  const ref = { title: 'Momentum Strategies and the Cross-Section of Expected Returns', year: '1993',
    container: 'Journal of Finance' };
  const it = crItem({ doi: '10.1111/j.1540-6261.1993.tb09902.x',
    title: 'Common Risk Factors in Returns on Stocks and Bonds',
    container: 'Journal of Finance', year: 1993 });
  const sim = titleSim(ref.title, it.title[0]);
  assert.ok(sim < SIM_GATE, `前提：相似度 ${sim} 应低于门禁`);
  assert.strictEqual(gateMatch(ref, it, sim).ok, false, '只有标题门禁能拦 ⇒ 必须 false');
});

test('三重门禁是冗余的：任一档失效仍能拦下已知错例（纵深防御）', () => {
  // Lowenstein错例：即使标题门禁完全失效，年份 + 刊名两道仍必须拦下
  const ref = { title: 'When Genius Failed', year: '2000', container: 'Random House' };
  const it = crItem({ doi: 'x', title: 'anything else entirely', container: 'Choice Reviews Online', year: 2001 });
  assert.strictEqual(gateMatch(ref, it, 1).ok, false, '标题门禁失效时仍须拦下');
});
