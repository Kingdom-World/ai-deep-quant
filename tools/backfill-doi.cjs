#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// 补 DOI 工具（#74 · 还债）
//
//   用途：把「期刊论文」类出处补上 DOI，让它们从 structured 升到 verifiable
//   （能被 Crossref 逐字段机器核验）。
//
//   🔴 **只处理期刊论文，刻意不碰书籍/教材/工作论文**：
//   Crossref **不收录专著与教材**（只收期刊、会议录、学位论文的部分）。
//   给《Advances in Financial Machine Learning》这种书硬编一个 DOI 是**伪造**——
//   比"没有 DOI"糟糕得多：格式对的假信息最难被发现。
//   ⇒ 书籍类的正确做法是 ISBN 级核验（另有 2 条已有 ISBN），不是 DOI。
//
//   ── 三条安全纪律 ──
//   ① **只写"查到了且对得上"的结果**，绝不猜测/构造 DOI。
//      Crossref 查不到 ⇒ 跳过并报出来，让人去人工处理。
//   ② 写入前必须做**标题相似度门禁**（≥0.75）：相似度不够说明检索命中的
//      是别的论文（同名不同刊/不同作者），写进去就是错的。
//   ③ **dry-run 默认**：`--write` 才落盘。避免手一抖污染知识库。
//
//   用法：
//     node tools/backfill-doi.cjs                 # 预览（dry-run）
//     node tools/backfill-doi.cjs --write         # 落盘
//     node tools/backfill-doi.cjs --only paper-   # 只处理 id 含该串的条目
// ─────────────────────────────────────────────────────────────
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
process.env.KNOWLEDGE_DIR = path.join(ROOT, 'server', 'knowledge');
const { parseSource } = require('../shared/knowledge-source.cjs');
const kb = require('../server/knowledge.cjs');

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : '';
})();

const UA = 'ai-deep-quant-doi-backfill/1.0 (https://github.com/Kingdom-World/ai-deep-quant; mailto:contact@example.com)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 标题相似度（Jaccard 词级）—— 与 verify-sources.cjs 同口径 */
function titleSim(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').trim();
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const sa = new Set(A.split(' ')), sb = new Set(B.split(' '));
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 0;
}

/** 门禁：标题相似度阈值。低于它 ⇒ 检索命中的是别的论文，不写 */
const SIM_GATE = 0.75;

// 🔴 实测教训（#74 落盘后由 verify-sources 抓出，19 条里3 条是错的）：
//   **只比标题会被"书评 / 短评 / 引用文献"骗过**。三个真实错例：
//     · When Genius Failed（Lowenstein 1998 的书）
//        → 命中 Choice Reviews Online 的**书评** 10.5860/choice.38-2845（标题几乎全等）
//     · Irrational Exuberance（Shiller 2000 的书）
//        → 命中 Foreign Affairs 的**书评** 10.2307/20049834
//     · Cycles and Trends in Economic Factors（Kitchin 1923 正文）
//        → 命中同刊同期的 **"Comment"** 短评 10.2307/1927031
//   共同形态：**Crossref 的标题与我们几乎一致，但作者/年份/刊物全不同**。
//   ⇒ 追加两道交叉核验（各查得到才写）：
//      ① **年份**：|权威年 − 我们年| ≤ 1（跨年印刷/online-first 已在 verify 侧容差）
//      ② **容器**：权威刊名与我们的刊名必须**同名或一方包含另一方**
//         （"Review of Financial Studies" vs "The Review of Financial Studies" 这类
//          冠词差异要放过；"Foreign Affairs" vs "Random House" 那种必须拦下）

/** 年份容差（年） */
const YEAR_TOL = 1;

/** 从解析结果里取年份（可能是字符串或数字） */
function refYear(ref) {
  const y = Number(String(ref?.year ?? '').slice(0, 4));
  return Number.isFinite(y) && y > 1800 ? y : null;
}

/** 从 Crossref item 取年份 */
function crYear(it) {
  const dp = it?.issued?.['date-parts']?.[0]?.[0];
  return Number.isFinite(dp) ? dp : null;
}

/** 刊名归一（去冠词/空白/大小写差异） */
function normContainer(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\bthe\b/g, ' ')
    .replace(/[^a-z0-9一-鿿]+/g, '');
}

/**
 * 容器匹配：同名或一方包含另一方（allow Crossref 侧带 "The"/复数/连字符变体）。
 * @returns {{ok:boolean, why?:string}}
 */
function containerMatch(ours, theirs) {
  const a = normContainer(ours), b = normContainer(theirs);
  if (!a || !b) return { ok: true, why: '容器未知，跳过此项' };   // 不因为缺字段误杀
  if (a === b || a.includes(b) || b.includes(a)) return { ok: true };
  return { ok: false, why: `刊名不符（我们「${ours}」vs 权威「${theirs}」）` };
}

/**
 * 三重门禁：标题相似度 + 年份 + 刊名。
 * @returns {{ok:boolean, why?:string}}
 */
function gateMatch(ref, it, sim) {
  if (sim < SIM_GATE) return { ok: false, why: `标题相似度不足（${sim.toFixed(2)} < ${SIM_GATE}）` };
  const oy = refYear(ref), ty = crYear(it);
  if (oy && ty && Math.abs(oy - ty) > YEAR_TOL) {
    return { ok: false, why: `年份不符（我们 ${oy} vs 权威 ${ty}）` };
  }
  return containerMatch(ref.container, (it['container-title'] || [])[0]);
}

// ── 纯函数区（可被 test/backfill-doi.test.cjs 直接考核）──────────────────────

/**
 * 顺序定位所有片段的起始 offset。
 * 🔴 用游标而非裸 indexOf：同一文献在一个条目的 source 里可能出现多次，
 *    裸 indexOf 永远命中第一次 ⇒ DOI 会插到错误的那一处，且**不报错**。
 * 🔴 片段在 `ref.raw`，不在 ref 本身 —— refs 是对象数组。
 *    传对象给 indexOf 会变成查 "[object Object]" ⇒ 静默全部定位失败。
 * @returns {number[]} 每个片段的 offset；-1 表示定位不到
 */
function locateFragments(src, frags) {
  const cursor = { at: 0 };
  return frags.map((frag) => {
    const f = String(frag || '');
    if (!f) return -1;
    const at = src.indexOf(f, cursor.at);
    if (at < 0) return -1;
    cursor.at = at + f.length;
    return at;
  });
}

/**
 * 生成插入计划：**纯插入**（start === end），按 offset 降序。
 * 降序是必需的 —— 正序插入会让后续 offset 全部失效。
 * @param {string} src 原始 source 文本
 * @param {string[]} frags parseSource 得到的片段原文（ref.raw）
 * @param {{refIndex:number, doi:string}[]} inserts
 * @param {string[]} [failed] 失败明细收集器（可选）
 */
function planInserts(src, frags, inserts, failed) {
  const positions = locateFragments(src, frags);
  const edits = [];
  for (const ins of inserts) {
    const frag = frags[ins.refIndex];
    const at = positions[ins.refIndex];
    if (at === undefined || at < 0 || !frag) {
      if (failed) failed.push(`#${ins.refIndex}: 片段定位失败`);
      continue;
    }
    const end = at + frag.length;
    const after = src[end];
    // 🔴 start 与 at 都取**片段末尾**：纯插入。
    //    若把 at 当替换起点就会把片段本身吃掉（实测踩过：AAA。 被整段替换掉）。
    // 分隔符规则：原文片段末尾已带 '.' 就不重复加，否则补一个保证句子闭合
    edits.push({ at: end, start: end, text: ` DOI: ${ins.doi}${after === '.' ? '' : '.'}` });
  }
  return edits.sort((a, b) => b.at - a.at);
}

/** 按计划应用插入，返回新字符串（不改动入参） */
function applyInserts(src, edits) {
  let out = String(src);
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.start);
  return out;
}

/**
 * 在原始 JSON 文本里定位某条目的 source 字符串字面量区间（含两端引号）。
 * 🔴 目的：只替换这一个字面量，其余字节原样保留 —— 整份
 *    JSON.parse→stringify 会重排全文件，产生上百行与本次改动无关的噪声 diff。
 * 🔴 锚点必须容忍冒号后有无空格（`{"id":"x1"}` 与 `{"id": "x1"}` 都合法）——
 *    写死空格会让紧凑 JSON 整个查不到，且**静默**返回 null。
 * @returns {{start:number,end:number,value:string}|null}
 */
function findSourceLiteral(raw, entryId) {
  const m = new RegExp(`"id"\\s*:\\s*"${entryId}"`).exec(raw);
  if (!m) return null;
  const keyAt = raw.indexOf('"source"', m.index);
  if (keyAt < 0 || keyAt > m.index + 4096) return null;
  const q1 = raw.indexOf('"', raw.indexOf(':', keyAt) + 1);
  if (q1 < 0) return null;
  let q2 = q1 + 1;
  while (q2 < raw.length) {                       // 手工扫过 JSON 字符串（处理转义）
    const ch = raw[q2];
    if (ch === '\\') { q2 += 2; continue; }
    if (ch === '"') break;
    q2++;
  }
  if (q2 >= raw.length) return null;
  const start = q1, end = q2 + 1;                 // 含两端引号
  let value;
  try { value = JSON.parse(raw.slice(start, end)); } catch { return null; }
  return typeof value === 'string' ? { start, end, value } : null;
}

// ── 网络区 ────────────────────────────────────────────────────────────────

async function crossrefLookup(title, author, year) {
  const q = encodeURIComponent(`${title}${author ? ' ' + author : ''}${year ? ' ' + year : ''}`.slice(0, 400));
  const url = `https://api.crossref.org/works?query.bibliographic=${q}&rows=5&select=DOI,title,container-title,issued,volume,issue,page,author`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
      clearTimeout(timer);
      if (r.status === 429) { await sleep(2500); continue; }
      if (!r.ok) return null;
      const j = await r.json();
      return j.message?.items || [];
    } catch {
      await sleep(1200);
    }
  }
  return null;
}

async function main() {
  const all = kb.search('', { limit: 9999 }).items.filter((e) => !ONLY || e.id.includes(ONLY));

  // 1) 收集待补的期刊类出处
  const targets = [];
  for (const e of all) {
    const parsed = parseSource(e.source);
    parsed.refs.forEach((r, i) => {
      if (r.doi) return;                       // 已有
      if (r.kind !== 'journal') return;       // 🔴 只处理期刊
      if (!r.title || r.title.length < 8) return;
      targets.push({ entryId: e.id, refIndex: i, ref: r });
    });
  }

  console.log(`\n══ DOI 补全（${WRITE ? '落盘' : '预览'}）══`);
  console.log(`条目 ${all.length} | 待查期刊类出处 ${targets.length} 条`);
  console.log(`（书籍/教材/工作论文**刻意不查** —— Crossref 不收录专著，DOI 对它们是伪造）\n`);

  const found = [];   // {entryId, refIndex, doi, sim, title}
  const skipped = [];

  for (const t of targets) {
    const items = await crossrefLookup(t.ref.title, (t.ref.authors || [])[0], t.ref.year);
    await sleep(350); // 礼貌间隔，避免被限流
    if (!items || !items.length) { skipped.push({ ...t, why: 'Crossref 无结果' }); continue; }

    // 三重门禁：标题相似度 + 年份 + 刊名（见上方注释里的三个真实错例）
    let best = null, bestSim = -1, gate = null;
    for (const it of items) {
      const sim = titleSim(t.ref.title, (it.title || [])[0]);
      if (sim <= bestSim) continue;
      const g = gateMatch(t.ref, it, sim);
      if (!g.ok) { if (!best) { bestSim = sim; gate = g; } continue; }
      best = { sim, doi: it.DOI, title: (it.title || [])[0], container: (it['container-title'] || [])[0], year: crYear(it) };
      bestSim = sim;
      gate = null;
    }
    if (!best) {
      skipped.push({ ...t, why: gate ? gate.why : '无通过门禁的候选', cand: (items[0]?.title || [])[0] });
      continue;
    }
    found.push({ ...t, doi: best.doi, sim: best.sim, matched: best.title });
    console.log(`✅ ${t.entryId} #${t.refIndex}  ${best.doi}`);
    console.log(`   相似度 ${best.sim.toFixed(2)} | ${(t.ref.title || '').slice(0, 50)}`);
    console.log(`   容器 ${best.container || '—'} ${best.year || ''}`);
  }

  console.log(`\n── 汇总 ──`);
  console.log(`找到 ${found.length} 条 / 跳过 ${skipped.length} 条`);
  if (skipped.length) {
    console.log(`\n跳过明细（需人工处理，不要硬塞 DOI）：`);
    for (const s of skipped) console.log(`  · ${s.entryId} #${s.refIndex}：${s.why}`);
  }
  if (!found.length) return 0;

  if (!WRITE) {
    console.log('\n（预览模式。加 --write 落盘。）');
    return 0;
  }

  // 2) 落盘：把 DOI 插到原 source 文本中对应位置。
  //    精确定位/倒序插入/只替换目标字面量 三件事都在纯函数里（见上方纯函数区），
  //    由 test/backfill-doi.test.cjs 考核；这里只负责 IO。
  let written = 0;
  const failed = [];
  const byEntry = new Map();
  for (const f of found) {
    if (!byEntry.has(f.entryId)) byEntry.set(f.entryId, []);
    byEntry.get(f.entryId).push(f);
  }

  const kbDir = path.join(ROOT, 'server', 'knowledge');
  const files = fs.readdirSync(kbDir).filter((f) => f.endsWith('.json'));

  for (const [entryId, list] of byEntry) {
    let hit = null;
    const idProbe = new RegExp(`"id"\\s*:\\s*"${entryId}"`);
    for (const fn of files) {
      const raw = fs.readFileSync(path.join(kbDir, fn), 'utf8');
      if (!idProbe.test(raw)) continue;
      const doc = JSON.parse(raw);                    // 合法性与结构由它把关
      if (!(doc.entries || []).some((x) => x.id === entryId)) continue;
      hit = { fn, raw };
      break;
    }
    if (!hit) { failed.push(`${entryId}: 未在 JSON 中找到条目`); continue; }

    const lit = findSourceLiteral(hit.raw, entryId);
    if (!lit) { failed.push(`${entryId}: 原文里定位不到 source 字段`); continue; }

    const frags = parseSource(lit.value).refs.map((r) => String(r.raw || ''));
    const localFail = [];
    const edits = planInserts(lit.value, frags, list, localFail);
    for (const m of localFail) failed.push(`${entryId} ${m}`);
    if (!edits.length) continue;

    written += edits.length;
    const newValue = applyInserts(lit.value, edits);
    const nextRaw = hit.raw.slice(0, lit.start) + JSON.stringify(newValue) + hit.raw.slice(lit.end);
    JSON.parse(nextRaw);                           // 写前最后一次合法性确认
    fs.writeFileSync(path.join(kbDir, hit.fn), nextRaw, 'utf8');
  }

  console.log(`\n已写入 ${written} 处 DOI（${byEntry.size} 个条目）`);
  if (failed.length) {
    console.log(`⚠️ 失败 ${failed.length} 处：`);
    for (const f of failed) console.log('   · ' + f);
  }
  console.log('\n⚠️ 写后必须验证：① JSON 仍合法 ② 跑 tools/verify-sources.cjs ③ 跑知识库测试');
  return 0;
}

// ── 出口（给测试用；直接执行时跑 CLI）─────────────────────────────────────
if (require.main === module) {
  main().then((c) => { process.exitCode = c; }).catch((e) => {
    console.error('工具自身失败:', (e && e.stack) || e);
    process.exitCode = 2;
  });
} else {
  module.exports = {
    titleSim, SIM_GATE, YEAR_TOL, gateMatch, containerMatch,
    locateFragments, planInserts, applyInserts, findSourceLiteral,
  };
}