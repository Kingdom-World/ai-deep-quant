#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// 出处存在性校验工具（Phase 2.5 主线 · #71）
//
//   用途：拿 Crossref（期刊 DOI 权威）核验知识库里的出处字段，把
//   "看起来有出处"变成"机器核过出处"。独立审查抽验发现 31% 出处错误率，
//   其中 Salomon(1987) 那条**检索为零且时间上不可能**—— 格式对、事实错。
//
//   🔴 为什么是**离线工具**而不是服务端接口（两条都不是洁癖）：
//     · 服务端在 Vercel Serverless，出网不稳（东财已被 502 拒）；
//       把"查文献"放进请求路径 ⇒ 外部抖动变成用户可见故障。
//     · 发布门必须**离线可判**：一条出处能否发布，不该取决于"此刻 Crossref 是否可达"。
//
//   🔴 校验结果 = **快照**，不是真相来源。
//     Crossref 明天可能改数据；条目不该因为它变了就自动"变对/变错"。
//     快照记录"何时、用哪个 DOI、得到什么字段"，可复核可重跑。
//
//   用法：
//     node tools/verify-sources.cjs                # 全量核验 + 打印报告
//     node tools/verify-sources.cjs --write        # 同时写 data/source-verification.json
//     node tools/verify-sources.cjs --only paper-  # 只核某个条目
//     node tools/verify-sources.cjs --offline      # 不联网，只跑解析层（离线自检）
//
//   退出码：0 = 无 verifiable 级问题；1 = 有（适合 CI 门禁）；2 = 网络不可用
// ─────────────────────────────────────────────────────────────
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'data', 'source-verification.json');
const { parseSource, citationStrength, REF_KINDS } = require('../shared/knowledge-source.cjs');

// ── 参数 ──
const argv = process.argv.slice(2);
const WANT_WRITE = argv.includes('--write');
const OFFLINE = argv.includes('--offline');
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : '';
})();

// ── Crossref 客户端 ──
// 🔴 polite pool：Crossref 官方要求带上可识别 UA（无 UA 会被限流甚至 403）。
//   邮箱用占位符 —— 真实邮箱不该进公开仓库。
const UA = 'ai-deep-quant-source-verify/1.0 (https://github.com/Kingdom-World/ai-deep-quant; mailto:contact@example.com)';
const TIMEOUT_MS = 20000;

/** 带超时与重试的 fetch（Node 24 有原生 AbortSignal.timeout；22 需兜底） */
async function httpJson(url, attempt = 1) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    // 退避重试一次：单次网络抖动不该让整个校验中断（否则"没核到"会被误读成"错了"）
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 800));
      return httpJson(url, attempt + 1);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 按 DOI 取 Crossref 元数据；404 返回 null（= 该 DOI 不存在，这是有效结论） */
async function byDoi(doi) {
  try {
    const j = await httpJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
    return j.message || null;
  } catch (e) {
    if (String(e.message).includes('HTTP 404')) return null;
    throw e;
  }
}

/** 按标题+作者检索（无 DOI 的条目用；取最相似的一条） */
async function byTitle(title, year) {
  const q = encodeURIComponent(`${title}${year ? ' ' + year : ''}`.slice(0, 300));
  try {
    const j = await httpJson(`https://api.crossref.org/works?query.bibliographic=${q}&rows=3&select=DOI,title,container-title,issued,volume,issue,page,author`);
    return (j.message && j.message.items) || [];
  } catch {
    return [];
  }
}

/** 标题相似度（0-1）：用于判断"检索到的这篇是不是我们引的那篇" */
function titleSim(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').trim();
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  // 词级 Jaccard：标题被期刊名/DOI 污染时仍能给出有意义的分数
  const sa = new Set(A.split(' ')), sb = new Set(B.split(' '));
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 0;
}

/**
 * 逐字段比对：返回 [{field, ours, theirs, verdict}]
 *
 * 🔴🔴 这里是本工具最容易做成"制造噪声机器"的地方，已实测踩了两次坑：
 *
 * 坑① 年份：Crossref 的 issued 是 **online-first 年**，而期刊卷期是 print 年。
 *   实证：Harvey, Liu & Zhu 的 RFS 论文 issued=2015（10-9 在线）、
 *   published-print=2016、卷期 v29(1)。两者**都是正确引用写法**
 *   （学界通行的就是 2016），工具若判不一致，就等于逼人改对的东西。
 *   ⇒ 规则：年份差 1 **且** 我们写的年等于 published-print ⇒ 判 match（并注明）。
 *
 * 坑② 页码：Crossref 的 page 常常**只存首页**（"703" 而非 "703-708"）。
 *   把我们的 "703-708" 与它的 "703" 直接比字符串 ⇒ 永远不一致。
 *   ⇒ 规则：页码**任一方是另一方的前缀**即判 match。
 *
 * 坑③ 期号：某些刊用**分册标记**（Sharpe 1966 那篇在 Journal of Business 39，
 *   Crossref 标issue="S1" = Supplement 1；而学术引用普遍写 39(1)）。
 *   实证：10.1086/294846 权威 issue="S1"，我们写"1" —— 两者都对。
 *   ⇒ 规则：期号形如 `S<n>` / `Pt<n>` 时，其数字部分与我们的纯数字等价即判 match。
 *
 * 坑④（**最险的一个**，#74 实测踩中）：只按**标题**相似度挂 DOI 会被
 *   "书评 / 短评 / 引用文献"骗过 —— 标题几乎全等，作者/年份/刊物全不同。
 *   三个真实错例：Lowenstein 的书 → 命中 Choice Reviews 的**书评**；
 *   Shiller 的书 → 命中 Foreign Affairs 的**书评**；
 *   Kitchin 1923 正文 → 命中同刊的 **"Comment"** 短评。
 *   ⇒ 已把门禁从"标题相似度"升级为**标题 + 年份 + 刊名三重**（见 tools/backfill-doi.cjs
 *     的 gateMatch）。⚠️ 本工具只负责**事后**发现，所以"verified"这一栏的前提是
 *     写入时就过了三重门禁；若你手工塞 DOI，请自行核对刊名与年份。
 *
 * 教训（值得记住）：校验器的判定规则必须先问"这是真的吗，还是我在制造噪声"，
 * 否则它会安静地把正确的引用报成错的 —— 用三次就没人信它了。
 */
function diffFields(ref, meta) {
  const out = [];
  const push = (field, ours, theirs, verdict, note) => out.push({ field, ours: String(ours), theirs: String(theirs), verdict, note: note || '' });

  const cmpi = (field, ours, theirs) => {
    if (ours === '' || ours == null) return; // 我们没写 ⇒ 无从比对
    if (theirs == null || theirs === '') return;
    const a = String(ours).replace(/[\s‐-―−]/g, '');
    const b = String(theirs).replace(/[\s‐-―−]/g, '');
    return { a, b, ok: a.toLowerCase() === b.toLowerCase() };
  };

  // 年份：容许 online-first / print 的 1 年差
  if (ref.year) {
    const issued = meta.issued?.['date-parts']?.[0]?.[0];
    const print = meta['published-print']?.['date-parts']?.[0]?.[0];
    if (issued != null) {
      if (String(ref.year) === String(issued)) push('year', ref.year, issued, 'match');
      else if (print != null && String(ref.year) === String(print)) {
        push('year', ref.year, print, 'match', `online-first ${issued} / 印刷 ${print}，两者皆通行写法`);
      } else if (Math.abs(Number(ref.year) - Number(issued)) === 1) {
        // 仍差 1 年但不等于印刷年 ⇒ 可能是真错，标注出来供人判断
        push('year', ref.year, issued, 'mismatch', `与 online-first 差 1 年，且不等于印刷年 ${print ?? '未知'}`);
      } else {
        push('year', ref.year, issued, 'mismatch');
      }
    }
  }

  const v = cmpi('volume', ref.volume, meta.volume);
  if (v) push('volume', v.a, v.b, v.ok ? 'match' : 'mismatch');

  const i = cmpi('issue', ref.issue, meta.issue);
  if (i) {
    // 坑③：分册标记等价（Crossref "S1"/"Pt2" ≡ 通行写法的 "1"/"2"）
    const stripPart = (s) => String(s).trim().replace(/^(s|pt|part|suppl|supp)\.?\s*(\d+)$/i, '$2');
    const partEq = !i.ok && stripPart(i.a) === stripPart(i.b) && stripPart(i.a) !== '';
    push('issue', i.a, i.b, i.ok || partEq ? 'match' : 'mismatch',
      partEq && !i.ok ? `分册标记差异（我们 ${i.a} ≡ 权威 ${i.b}）` : '');
  }

  // 页码：前缀等价即 match（Crossref 常只存首页）
  if (ref.pages) {
    const p = cmpi('pages', ref.pages, meta.page);
    if (p) {
      const isPrefix = p.a.startsWith(p.b) || p.b.startsWith(p.a);
      push('pages', p.a, p.b, p.ok || isPrefix ? 'match' : 'mismatch', isPrefix && !p.ok ? 'Crossref 只存首页' : '');
    }
  }

  return out;
}

// ── 主流程 ──

function loadEntries() {
  // 复用知识库自己的加载器（口径单一源：不要另写一份 JSON 读取）
  process.env.KNOWLEDGE_DIR = path.join(ROOT, 'server', 'knowledge');
  const kb = require('../server/knowledge.cjs');
  return kb.search('', { limit: 9999 }).items;
}

async function main() {
  const entries = loadEntries().filter((e) => !ONLY || e.id.includes(ONLY));
  const results = [];
  let networkDown = false;

  for (const e of entries) {
    const parsed = parseSource(e.source);
    for (let i = 0; i < parsed.refs.length; i++) {
      const ref = parsed.refs[i];
      const strength = citationStrength(ref);
      const rec = {
        entryId: e.id,
        refIndex: i,
        kind: ref.kind,
        strength,
        raw: ref.raw,
        ours: { title: ref.title, year: ref.year, container: ref.container, volume: ref.volume, issue: ref.issue, pages: ref.pages, doi: ref.doi, publisher: ref.publisher, isbn: ref.isbn },
        status: 'unchecked',
        theirs: null,
        diffs: [],
        note: ref.note || '',
      };

      // 🔴 无 DOI 且非期刊/报告 ⇒ 本轮不联网核（只能核存在性，人工判）
      if (OFFLINE || !ref.doi) {
        rec.status = ref.doi ? 'unchecked' : strength === 'structured' ? 'needs-doi' : 'existence-only';
        results.push(rec);
        continue;
      }

      try {
        const meta = await byDoi(ref.doi);
        if (!meta) {
          // 🔴 最严重的一类：DOI 在 Crossref 查无此文 ⇒ 出处不可信
          rec.status = 'doi-not-found';
          results.push(rec);
          continue;
        }
        rec.theirs = {
          doi: meta.DOI,
          title: (meta.title || [])[0] || '',
          container: (meta['container-title'] || [])[0] || '',
          year: meta.issued?.['date-parts']?.[0]?.[0] || null,
          volume: meta.volume || '',
          issue: meta.issue || '',
          pages: meta.page || '',
        };
        rec.diffs = diffFields(ref, meta);
        const mismatched = rec.diffs.filter((d) => d.verdict === 'mismatch');
        // 标题单独判：DOI 命中但标题差很远 ⇒ 极可能是"DOI 配错了文章"
        //
        // 🔴 容差：**副标题关系**（与页码"前缀等价"同构）。
        //    学术引用通行写法会带副标题，而 Crossref 常只存**主标题**：
        //    Ang《Asset Management: A Systematic Approach to Factor Investing》
        //    vs 权威「Asset Management」（10.1093/acprof…，实测）。
        //    若不放行，等于逼人把正确引用砍成残缺形式——正是"制造噪声"的老坑。
        //    规则：一方是另一方的**前缀**（去掉副标题后）即判 match。
        const titleEq = (() => {
          const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();
          const a = norm(ref.title), b = norm(rec.theirs.title);
          if (!a || !b) return false;
          return a === b || a.startsWith(b) || b.startsWith(a);
        })();
        if (ref.title && !titleEq && titleSim(ref.title, rec.theirs.title) < 0.5) {
          rec.status = 'title-mismatch';
          rec.diffs.push({ field: 'title~', ours: ref.title, theirs: rec.theirs.title, verdict: 'mismatch' });
        } else if (mismatched.length) {
          rec.status = 'field-mismatch';
        } else {
          rec.status = 'verified';
        }
      } catch (e) {
        networkDown = true;
        rec.status = 'network-error';
        rec.note = `${rec.note ? rec.note + ' | ' : ''}${String(e.message).slice(0, 60)}`;
      }
      results.push(rec);
    }
  }

  // ── 报告 ──
  const tally = {};
  for (const r of results) tally[r.status] = (tally[r.status] || 0) + 1;

  console.log(`\n══ 出处核验报告（${ONLY ? '条目含 ' + ONLY : '全量'}）══`);
  console.log(`条目 ${entries.length} | 引用 ${results.length} 条`);
  console.log('结论分布:', tally);
  console.log(`其中可机器逐字段核验（带 DOI）: ${results.filter((r) => r.ours.doi).length} 条`);

  const problems = results.filter((r) => ['doi-not-found', 'title-mismatch', 'field-mismatch'].includes(r.status));
  if (problems.length) {
    console.log(`\n🔴 需人工处理（${problems.length} 条）:`);
    for (const p of problems) {
      console.log(`\n  [${p.entryId} #${p.refIndex}] ${p.status}`);
      console.log(`    我们写的: ${p.raw.slice(0, 100)}`);
      if (p.theirs) console.log(`    权威返回: ${p.theirs.title} | ${p.theirs.container} ${p.theirs.year} v${p.theirs.volume}(${p.theirs.issue}) ${p.theirs.pages}`);
      for (const d of p.diffs.filter((x) => x.verdict === 'mismatch')) {
        console.log(`    ✗ ${d.field}: 我们「${d.ours}」 vs 权威「${d.theirs}」`);
      }
    }
  }

  const pending = results.filter((r) => r.status === 'needs-doi');
  if (pending.length) {
    console.log(`\n🟡 可加 DOI 让核验能力升级（${pending.length} 条，当前只能核到标题）:`);
    for (const p of pending) console.log(`  · ${p.entryId} #${p.refIndex}: ${(p.ours.container || p.ours.title || p.raw).slice(0, 80)}`);
  }

  if (WANT_WRITE && !networkDown) {
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    const payload = {
      generatedAt: new Date().toISOString(),
      provider: 'Crossref',
      note: '快照：Crossref 数据可能变化；本文件记录核验当时的结果，不参与发布门判定。',
      tally,
      total: results.length,
      results,
    };
    fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));
    console.log(`\n已写入 ${path.relative(ROOT, OUT_FILE)}`);
  } else if (WANT_WRITE && networkDown) {
    console.log('\n⚠️ 网络不可用，未写快照（避免把"没核到"固化成"核过了"）');
  }

  if (networkDown) return 2;
  return problems.length ? 1 : 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((e) => {
  console.error('校验工具自身失败:', (e && e.stack) || e);
  process.exitCode = 2;
});