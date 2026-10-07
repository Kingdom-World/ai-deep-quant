// ─────────────────────────────────────────────────────────────
// 出处解析测试（Phase 2.5 · #71）
//
//   为什么这些断言必须这么写（都是实测踩出来的坑，不是防御性编程）：
//
//   ① 正/负对照必须都在。只测"能解析"的话，把解析器改成永远返回空对象也能全绿；
//      只测"不解析"的话，把解析器改成全文塞进 raw 也能全绿。两者都要。
//   ② 断言打在**具体字段值**上，不打"字段存在" ——
//      "存在但恒为空"和"存在且正确"在存在性断言下无法区分。
//   ③ 每个曾经修过的缺陷都留一条回归（DOI 吞中文、作者名含缩写、
//      container 装说明文字、indexOf 定位截断切片）。删掉任何一条，
//      对应缺陷都会静默回来。
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');

const S = require('../shared/knowledge-source.cjs');

// ═══ 一、正对照：真实引用的解析结果 ═══════════════════════════

test('期刊论文：作者/年份/标题/期刊/卷期页 全部就位', () => {
  const r = S.parseRef('Jegadeesh, N. & Titman, S. (1993). Returns to Buying Winners and Selling Losers: Implications for Stock Market Efficiency. Journal of Finance, 48(1), 65-91.');
  assert.strictEqual(r.kind, 'journal');
  assert.deepStrictEqual(r.authors, ['Jegadeesh', 'Titman']);
  assert.strictEqual(r.year, 1993);
  assert.match(r.title, /Returns to Buying Winners/);
  assert.strictEqual(r.container, 'Journal of Finance');
  assert.strictEqual(r.volume, '48');
  assert.strictEqual(r.issue, '1');
  assert.strictEqual(r.pages, '65-91');
  // ⚠️ 本例**故意不给 DOI** ⇒ 最高只能到 structured。
  //   （曾在这里写成 verifiable，是测试自己错了 —— 断言必须与给定输入相符，
  //     否则就会把"该报的错"改成"改代码到通过"，那是在自欺。）
  assert.strictEqual(r.doi, '');
  assert.strictEqual(S.citationStrength(r), 'structured');
});

test('🔴 回归 #1：DOI 不得吞掉后随的中文说明', () => {
  // 真实数据：'10.1111/…tb04702.x。中国市场对照：Cheema…'
  // 原实现按 [^\\s,;，；]+ 取，会把中文一起吞掉 ⇒ DOI 对不上 Crossref，
  // 校验就成了一句谎话（而且很难被发现，因为它看起来"有 DOI"）。
  const r = S.parseRef('Jegadeesh, N. & Titman, S. (1993). Returns to Buying Winners and Selling Losers. Journal of Finance, 48(1), 65-91. DOI: 10.1111/j.1540-6261.1993.tb04702.x。中国市场对照见 Cheema & Haaretza。');
  assert.strictEqual(r.doi, '10.1111/j.1540-6261.1993.tb04702.x');
  assert.ok(!/[\u4e00-\u9fff]/.test(r.doi), 'DOI 字段里不得含中文');
});

test('🔴 回归 #2：作者名不得把首字母缩写当姓', () => {
  // 原实现按逗号裸切 → ['Fama','E. F.','French','K. R.']
  // 这不是"多几个字段"的问题：拿它去比对 Crossref 作者会全盘对不上。
  const r = S.parseRef('Fama, E. F. & French, K. R. (1993). Common Risk Factors in the Returns on Stocks and Bonds. Journal of Financial Economics, 33(1), 3-56.');
  assert.deepStrictEqual(r.authors, ['Fama', 'French']);
  assert.ok(!r.authors.some((a) => /^[A-Z]\.$/.test(a)), `缩写混进了姓氏：${JSON.stringify(r.authors)}`);
});

test('🔴 回归 #3：复姓/前缀必须完整保留', () => {
  const r = S.parseRef('López de Prado, M. (2018). Advances in Financial Machine Learning. John Wiley & Sons.');
  assert.ok(r.authors.includes('López de Prado'), `复姓被截断：${JSON.stringify(r.authors)}`);
});

test('🔴 回归 #4：DOI 里的合法圆括号不得被截断', () => {
  // 10.1016/0304-405X(93)90023-5 —— 原实现 `[（(].*$` 会从 ASCII 括号处砍掉后半截
  const r = S.parseRef('Fama, E.F. & French, K.R. (1993). Common Risk Factors in the Returns on Stocks and Bonds. Journal of Financial Economics, 33(1), 3-56. https://doi.org/10.1016/0304-405X(93)90023-5');
  assert.strictEqual(r.doi, '10.1016/0304-405X(93)90023-5');
});

test('🔴 回归 #5：container 不得装说明文字（indexOf 定位截断切片的坑）', () => {
  // 出处里混着中文说明；且 title 是截断切片，不能用 raw.indexOf(title) 定位
  const r = S.parseRef('Brady, N. F. (1990). Report of the Presidential Task Force on Market Mechanisms（主席 Nicholas F. Brady 时任美国财政部长，该委员会专为此事设立）. U.S. Department of the Treasury.');
  assert.ok(!/[\u4e00-\u9fff]/.test(r.container), `container 混进了中文说明：${r.container}`);
  assert.strictEqual(r.year, 1990);
  assert.strictEqual(S.citationStrength(r), 'structured');
});

// ═══ 二、负对照：不可解析的形态必须显式降级 ═══════════════════

test('负对照：毫无结构的文本判 parsed=false，但原文必须保留', () => {
  const raw = '见某教材';
  const r = S.parseRef(raw);
  assert.strictEqual(r.parsed, false, '不该把乱文本判为可结构化');
  assert.strictEqual(r.raw, raw, '原文必须原样保留（降级不等于丢信息）');
  assert.strictEqual(S.citationStrength(r), 'existential');
});

test('负对照：parsed=false 时字段不得靠猜填出来', () => {
  const r = S.parseRef('见某教材');
  assert.strictEqual(r.year, null, '没写年份却填了一个 ⇒ 臆造');
  assert.deepStrictEqual(r.authors, []);
  assert.strictEqual(r.doi, '');
});

test('负对照：强度分级必须区分三档，不可一律同判', () => {
  const withDoi = S.parseRef('X, Y. (2020). T. Journal, 1(1), 1-10. DOI: 10.1234/abc');
  const withMeta = S.parseRef('X, Y. (2020). Some Title Here. Journal of Finance, 1(1), 1-10.');
  const bare = S.parseRef('见某教材');
  assert.strictEqual(S.citationStrength(withDoi), 'verifiable');
  assert.strictEqual(S.citationStrength(withMeta), 'structured');
  assert.strictEqual(S.citationStrength(bare), 'existential');
  assert.strictEqual(S.citationStrength(null), 'none');
  assert.strictEqual(S.citationStrength({ raw: '' }), 'none');
});

// ═══ 三、真实数据上的批量性质 ═══════════════════════════════

test('教材章节形态：书名与章节号必须抽出来（这类占引用总数的多数）', () => {
  const r = S.parseRef('教材：Grinold & Kahn《Active Portfolio Management》第 7 章');
  assert.strictEqual(r.kind, 'chapter');
  assert.strictEqual(r.container, 'Active Portfolio Management');
  assert.ok(/第7章/.test(r.pages), `章节号没抽出来：${r.pages}`);
});

test('带前缀的出处（工程实现/官方依据）必须保留前缀性质', () => {
  const r = S.parseRef('工程实现：本项目 server/crosssect.cjs（T-1 收盘排名、T 开盘成交）');
  assert.strictEqual(r.parsed, true);
  assert.strictEqual(r.note, '工程实现');
});

test('多条出处按分号拆分，且不得把中文字号拆坏', () => {
  const src = 'Jegadeesh, N. & Titman, S. (1993). Title. Journal of Finance, 48(1), 65-91.；另见 Fama (1970). Title. Journal of Finance, 25(2), 383-417.';
  const refs = S.splitRefs(src);
  assert.strictEqual(refs.length, 2, `应拆成 2 条，实得 ${refs.length}`);
  assert.ok(refs[0].includes('Jegadeesh'));
  assert.ok(refs[1].includes('Fama'));
});

test('真实全库：解析层不得抛异常（每条 source 都必须能安全处理）', () => {
  const path = require('path');
  process.env.KNOWLEDGE_DIR = path.join(__dirname, '..', 'server', 'knowledge');
  const kb = require('../server/knowledge.cjs');
  const all = kb.search('', { limit: 9999 }).items;
  assert.ok(all.length > 0, '真实库应有条目');
  let refs = 0, parsed = 0;
  for (const e of all) {
    const p = S.parseSource(e.source); // 不得抛
    assert.ok(p.refs.length >= 1, `${e.id} 拆不出任何引用`);
    refs += p.refs.length;
    parsed += p.parsedCount;
  }
  // 🔴 结构化率下限：低于此值说明解析器退化了（当前实测 90%）
  //   断言阈值而不是断言具体数字：内容增删会让数字漂，但"解析能力整体塌了"必须被抓住。
  const rate = parsed / refs;
  assert.ok(rate >= 0.85, `结构化率 ${(rate * 100).toFixed(0)}% < 85%，解析器可能退化`);
});

test('真实全库：任何条目的 source 都不得解析出空的 kind（分类必须闭合）', () => {
  const path = require('path');
  process.env.KNOWLEDGE_DIR = path.join(__dirname, '..', 'server', 'knowledge');
  const kb = require('../server/knowledge.cjs');
  const all = kb.search('', { limit: 9999 }).items;
  const valid = new Set(Object.keys(S.REF_KINDS));
  for (const e of all) {
    for (const r of S.parseSource(e.source).refs) {
      assert.ok(valid.has(r.kind), `${e.id} 的 kind「${r.kind}」不在 REF_KINDS 内`);
    }
  }
});