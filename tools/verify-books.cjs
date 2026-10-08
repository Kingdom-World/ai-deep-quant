#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// 书籍出处核验工具（阶段 2 · B）
//
//   ⚠️ 先说清**这个工具的定位，避免它变成"看起来在工作"的装饰**：
//   书籍**不像期刊论文那样能被普遍机器核验**。实测（2026-10-08，4 本书）：
//     · OpenLibrary / Google Books **本机不可达**（大陆网络，三源全 000）
//     · Crossref 只覆盖**注册了 DOI 的专著** —— 学术出版社（OUP/Wiley 部分）会注册，
//       商业出版社（McGraw-Hill / Random House）**不注册**。
//       实测 4 本里**只有 1 本**（Ang《Asset Management》，OUP）能查到。
//   ⇒ 本工具做的是「**能查就查、查不到就如实说不覆盖**」，
//     而不是"给每本书补一个标识"——后者必然退化成伪造。
//
//   🔴 三条纪律（与 tools/backfill-doi.cjs 同口径）：
//     ① 只报"查到了且对得上"的，查不到就如实说"此源不覆盖"
//     ② ISBN 必须**精确命中**（不许靠标题相似度蒙）
//     ③ dry-run 默认；--write 才落盘
//
//   用法：
//     node tools/verify-books.cjs            # 只核验并报告（不写）
//     node tools/verify-books.cjs --write    # 把核对上的 ISBN/DOI 补进 source
// ─────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.env.KNOWLEDGE_DIR = path.join(ROOT, 'server', 'knowledge');
const { parseSource } = require('../shared/knowledge-source.cjs');
const kb = require('../server/knowledge.cjs');

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');

const UA = 'ai-deep-quant-bookcheck/1.0 (mailto:contact@example.com)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ISBN 归一（去连字符/空格，大写 X） */
function normIsbn(s) {
  return String(s || '').replace(/[-\s]/g, '').toUpperCase();
}

/**
 * 按 ISBN 精确查 Crossref。
 * @returns {{ok:true, item:object} | {ok:false, why:string}}
 */
async function crossrefByIsbn(isbn) {
  const clean = normIsbn(isbn);
  if (clean.length < 10) return { ok: false, why: 'ISBN 位数不足' };
  const url = `https://api.crossref.org/works?filter=isbn:${clean}&rows=5&select=DOI,title,type,ISBN,publisher,issued,author`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
      clearTimeout(timer);
      if (r.status === 429) { await sleep(2500); continue; }
      if (!r.ok) return { ok: false, why: `HTTP ${r.status}` };
      const items = (await r.json()).message?.items || [];
      // 🔴 必须精确命中：Crossref 的 isbn filter 理论上已过滤，但仍逐条核对（防 filter 行为变化）
      const hit = items.find((m) => (m.ISBN || []).map(normIsbn).includes(clean));
      if (!hit) return { ok: false, why: '此源无收录（Crossref 只覆盖注册 DOI 的专著）' };
      return { ok: true, item: hit };
    } catch {
      await sleep(1200);
    }
  }
  return { ok: false, why: '网络失败' };
}

async function main() {
  const items = kb.search('', { limit: 9999 }).items;
  const targets = [];
  for (const e of items) {
    parseSource(e.source).refs.forEach((r, i) => {
      if (r.kind !== 'book' && !r.isbn) return;   // 只处理书籍
      targets.push({ entryId: e.id, refIndex: i, ref: r });
    });
  }

  console.log(`\n══ 书籍出处核验（${WRITE ? '落盘' : '报告'}）══`);
  console.log(`书籍类出处 ${targets.length} 条\n`);

  const verified = [], uncovered = [];
  for (const t of targets) {
    const label = `${t.entryId} #${t.refIndex}`;
    const isbn = t.ref.isbn || '';
    const title = String(t.ref.title || t.ref.container || '').slice(0, 46);
    if (!isbn) {
      uncovered.push({ ...t, why: '出处未写 ISBN（无法核验）' });
      console.log(`— ${label}  ${title}`);
      console.log(`    未写 ISBN ⇒ 无法机器核验（书籍核验的唯一可靠入口是 ISBN）`);
      continue;
    }
    const res = await crossrefByIsbn(isbn);
    await sleep(400);
    if (res.ok) {
      const m = res.item;
      const year = (m.issued || {})['date-parts']?.[0]?.[0];
      const authors = (m.author || []).slice(0, 3).map((a) => a.family).join(', ');
      console.log(`✅ ${label}  ${title}`);
      console.log(`    ISBN ${isbn} 精确命中 → ${m.DOI} [${m.type}]`);
      console.log(`    ${String((m.title || [])[0]).slice(0, 70)}`);
      console.log(`    ${m.publisher} | ${year} | ${authors}`);
      verified.push({ ...t, doi: m.DOI, publisher: m.publisher, year });
    } else {
      uncovered.push({ ...t, why: res.why });
      console.log(`▫️ ${label}  ${title}`);
      console.log(`    ISBN ${isbn}：${res.why}`);
    }
  }

  console.log(`\n── 汇总 ──`);
  console.log(`可机器核验 ${verified.length} / 不覆盖或未写 ISBN ${uncovered.length}（共 ${targets.length}）`);
  if (uncovered.length) {
    console.log('\n未覆盖明细（**如实标注，不硬补**）：');
    for (const u of uncovered) console.log(`  · ${u.entryId} #${u.refIndex}：${u.why}`);
  }

  if (!WRITE || !verified.length) {
    if (!WRITE) console.log('\n（报告模式。加 --write 把核验到的 DOI 补进 source。）');
    return 0;
  }
  console.log('\n⚠️ 落盘前须知：书籍的 DOI 指向的是**专著整体**（monograph），');
  console.log('   而我们引的常是其中某章节 ⇒ 补 DOI 必须同时说明"DOI 指向书本身"。');

  let written = 0;
  const byEntry = new Map();
  for (const v of verified) {
    if (!byEntry.has(v.entryId)) byEntry.set(v.entryId, []);
    byEntry.get(v.entryId).push(v);
  }
  const kbDir = path.join(ROOT, 'server', 'knowledge');
  const files = fs.readdirSync(kbDir).filter((f) => f.endsWith('.json'));
  for (const [entryId, list] of byEntry) {
    let hit = null;
    for (const fn of files) {
      const raw = fs.readFileSync(path.join(kbDir, fn), 'utf8');
      if (!new RegExp(`"id"\\s*:\\s*"${entryId}"`).test(raw)) continue;
      hit = { fn, raw };
      break;
    }
    if (!hit) { console.log(`⚠️ ${entryId}: 未找到文件`); continue; }
    let raw = hit.raw;
    for (const v of list) {
      const frag = v.ref.raw;
      const at = raw.indexOf(frag);
      if (at < 0) { console.log(`⚠️ ${entryId} #${v.refIndex}: 定位失败`); continue; }
      const end = at + frag.length;
      const insert = ` DOI: ${v.doi}（该 DOI 指向专著整体）`;
      const after = raw[end];
      raw = raw.slice(0, end) + insert + (after === '.' ? '' : '.') + raw.slice(end);
      written++;
    }
    JSON.parse(raw);
    fs.writeFileSync(path.join(kbDir, hit.fn), raw, 'utf8');
  }
  console.log(`\n已写入 ${written} 处`);
  console.log('⚠️ 写后必须验证：① JSON 合法 ② node tools/verify-sources.cjs ③ 跑知识库测试');
  return 0;
}

if (require.main === module) {
  main().then((c) => { process.exitCode = c; }).catch((e) => {
    console.error('工具自身失败:', (e && e.stack) || e);
    process.exitCode = 2;
  });
} else {
  module.exports = { normIsbn, crossrefByIsbn };
}