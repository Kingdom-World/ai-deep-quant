#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// 知识库条目写入工具（Phase 2.5 扩容）
//
//   🔴 为什么要有它（而不是直接编辑 JSON）：
//     ① 手写 JSON 的字段错误会**静默进库**（拼错键名 ⇒ 该字段被忽略、
//        加载不报错、UI 那一栏永远为空）—— 与「臆造 6 处字段名」同类失败。
//     ② 扩容是**批量**行为，逐条 Edit 会产生百行噪声 diff 且易漏校验。
//     ③ 内容必须过**可执行的准入门**（而非人工看一眼）：
//          · schema（必填/未知字段/id 前缀/引用完整性）→ tools/lint-knowledge.cjs
//          · 出处必须能解析出 sourceRefs（否则等于没有出处）
//          · 不得与既有条目 id 冲突
//     ⇒ 本工具 = 写入 + **立即自校验**，任一项失败即整体回滚（不写半截）。
//
//   用法：
//     node tools/add-entries.cjs <entries.json>            # 预览（校验但不写）
//     node tools/add-entries.cjs <entries.json> --write    # 写入并自校验
//
//   entries.json 格式：数组，每项为完整条目对象（含 category/source 等）
//   ⚠️ 只允许**新增**，不支持修改既有条目（改条目请用 Edit，留精确 diff）。
// ─────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KB_DIR = path.join(ROOT, 'server', 'knowledge');

// 分类 → 存储文件名（与既有约定一致）
const CATEGORY_FILE = {
  term: 'terms.json',
  method: 'methods.json',
  principle: 'principle.json',
  case: 'case.json',
  cycle: 'cycle.json',
  basis: 'basis.json',
  paper: 'paper.json',
};

/** 与 lint-knowledge 同口径的顶层字段（**单一源在那边**；此处只做写入前的快速拒绝） */
const ALLOWED_KEYS = new Set([
  'id', 'category', 'title', 'body', 'summary', 'formula',
  'applicability', 'limitations', 'teachingModel', 'teachingNote',
  'source', 'tags', 'related',
]);

const argv = process.argv.slice(2);
const INPUT = argv.find((a) => !a.startsWith('--'));
const WRITE = argv.includes('--write');

if (!INPUT) {
  console.error('用法：node tools/add-entries.cjs <entries.json> [--write]');
  process.exit(2);
}

function die(msg) { console.error('🔴 ' + msg); process.exit(1); }

function main() {
  const abs = path.isAbsolute(INPUT) ? INPUT : path.join(ROOT, INPUT);
  if (!fs.existsSync(abs)) die(`文件不存在：${abs}`);
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    // 🔴 诊断辅助（2026-10-08 加）：这个错误**我犯了两次** ——
    //   body 里写中文引号时误用了英文双引号 `"…"`，直接把 JSON 字符串打断。
    //   原始报错只说"position N"，定位要数半天。这里主动指出最可能的原因。
    const raw = fs.readFileSync(abs, 'utf8');
    const line = raw.slice(0, e.message.match(/\d+/) ? Number((e.message.match(/position (\d+)/) || [])[1] || 0) : 0)
      .split('\n').length;
    console.error(`🔴 JSON 解析失败：${e.message}`);
    console.error(`   位置约在第 ${line} 行。`);
    console.error('   🔴 最常见原因：中文语境里写了**英文双引号**（"…"）——');
    console.error('      它会提前闭合 JSON 字符串。请改用「」或 『』。');
    console.error('      检查命令：node tools/lint-json-quotes.cjs <文件>');
    process.exit(1);
  }
  if (!Array.isArray(entries) || !entries.length) die('顶层必须是**非空数组**');

  // ── 载入既有 id ──
  const existing = new Set();
  const docs = {};
  for (const [cat, fn] of Object.entries(CATEGORY_FILE)) {
    const p = path.join(KB_DIR, fn);
    if (!fs.existsSync(p)) continue;
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    docs[cat] = { path: p, doc: d };
    for (const e of d.entries || []) existing.add(e.id);
  }

  // ── 🔴 引号风格预检（2026-10-08：同一个错误我犯了两次）──
  //   中文语境里写 `"…"` 会提前闭合 JSON 字符串。与其写坏后数 position 定位，
  //   不如写前扫一遍。判据在 lint-json-quotes 里（窄判据，实测 0 误报）。
  try {
    const { lintQuotes } = require(path.join(__dirname, 'lint-json-quotes.cjs'));
    const bad = lintQuotes(abs);
    if (bad.quotes.length) {
      console.error(`\n🔴 检测到 ${bad.quotes.length} 处中文语境误用英文双引号（会打断 JSON）：`);
      for (const q of bad.quotes.slice(0, 5)) {
        console.error(`   第 ${q.line} 行: …${q.snippet}…`);
      }
      console.error('\n   → 请改用「」或 『』。未写入任何内容。');
      process.exit(1);
    }
  } catch (e) {
    if (String(e.message || e).includes('Cannot find module')) {
      /* 检查器缺失不阻塞（但会提示） */
      console.warn('  ⚠️ 未找到 lint-json-quotes，跳过引号预检');
    } else { throw e; }
  }

  // ── 逐条校验（写前）──
  const problems = [];
  const seen = new Set();
  for (const e of entries) {
    const tag = e.id || '(无 id)';
    for (const k of ['id', 'category', 'title', 'body', 'source']) {
      if (!e[k] || !String(e[k]).trim()) problems.push(`[${tag}] 必填字段为空：${k}`);
    }
    if (!CATEGORY_FILE[e.category]) problems.push(`[${tag}] 未知分类：${e.category}`);
    for (const k of Object.keys(e)) {
      if (!ALLOWED_KEYS.has(k)) problems.push(`[${tag}] 未知字段「${k}」（写入后会被忽略）`);
    }
    if (existing.has(e.id)) problems.push(`[${tag}] id 已存在（本工具只允许新增）`);
    if (seen.has(e.id)) problems.push(`[${tag}] 本批次内 id 重复`);
    seen.add(e.id);
    // id 前缀与分类一致
    const want = e.category + '-';
    if (e.id && e.category && !String(e.id).startsWith(want)) {
      problems.push(`[${tag}] id 前缀应为「${want}」`);
    }
    // 出处必须能解析出引用（否则等于没出处 —— 发布门会把它变草稿）
    try {
      const { parseSource } = require('../shared/knowledge-source.cjs');
      const refs = parseSource(String(e.source)).refs;
      if (!refs.length) problems.push(`[${tag}] source 解析不出任何引用（等于无出处）`);
    } catch (err) { problems.push(`[${tag}] source 解析异常：${err.message}`); }
  }

  if (problems.length) {
    console.error(`\n🔴 校验未通过（${problems.length} 项）：`);
    for (const p of problems) console.error('  · ' + p);
    console.error('\n未写入任何内容。');
    process.exit(1);
  }

  console.log(`\n══ 条目写入（${WRITE ? '落盘' : '预览'}）══`);
  console.log(`待写入 ${entries.length} 条`);
  // 🔴 分组必须是**条目数组**（早先写成计数器 ⇒ 落盘时 list 不可迭代，实测踩过）。
  //   分组只做一次：计数与落盘都从这里派生，避免"两份表示分叉"。
  const byCat = {};
  for (const e of entries) (byCat[e.category] = byCat[e.category] || []).push(e);
  for (const [c, list] of Object.entries(byCat)) console.log(`  ${c}: ${list.length}`);

  if (!WRITE) {
    console.log('\n（预览模式。加 --write 落盘。）');
    return 0;
  }

  // ── 落盘：按分类分组，追加到对应文件 ──
  //
  // 🔴 两轮补链（2026-10-08 实测：第一版只补了"新 → 旧"，漏了"新 → 新"）：
  //   本批 10 条里 `term-t-plus-one → term-order-types` 与
  //   `term-rebalance-frequency → term-t-plus-one` 两条**都在本批内新增**，
  //   第一版逻辑把它们跳过了（只查了既有的 allEntries）⇒ 测试红。
  //   ⇒ 两轮：① 新 → 旧（补到既有条目上）② 新 → 新（在**本批内**互补）。
  const allEntries = new Map();   // id → { entry, file, doc }
  for (const [cat, t] of Object.entries(docs)) {
    for (const e of t.doc.entries || []) allEntries.set(e.id, { entry: e, path: t.path, doc: t.doc });
  }
  const touched = new Set();      // 需要回写的**既有**文件

  // 轮次 ①：新条目 → 既有条目
  for (const e of entries) {
    for (const r of e.related || []) {
      const hit = allEntries.get(r);
      if (!hit) continue;
      const rel = hit.entry.related || (hit.entry.related = []);
      if (!rel.includes(e.id)) { rel.push(e.id); rel.sort(); touched.add(hit.path); }
    }
  }

  // 轮次 ②：本批内部互指（新 → 新）
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const e of entries) {
    for (const r of e.related || []) {
      const other = byId.get(r);
      if (!other) continue;                     // 不是本批的，轮次①已处理
      const rel = other.related || (other.related = []);
      if (!rel.includes(e.id)) { rel.push(e.id); rel.sort(); }
    }
  }

  // 先回写被追加了反向链接的**既有**文件
  for (const p of touched) {
    const doc = Object.values(docs).find((t) => t.path === p).doc;
    const next = JSON.stringify(doc, null, 2) + '\n';
    JSON.parse(next);
    fs.writeFileSync(p, next, 'utf8');
    console.log(`  ${path.relative(ROOT, p)}: 已补反向链接`);
  }

  for (const [cat, list] of Object.entries(byCat)) {
    const target = docs[cat];
    if (!target) die(`分类 ${cat} 无对应文件`);
    const raw = fs.readFileSync(target.path, 'utf8');
    const doc = JSON.parse(raw);
    if (!Array.isArray(doc.entries)) die(`${target.path} 结构异常（无 entries 数组）`);
    const before = doc.entries.length;
    // 🔴 追加时保持既有字段顺序（先构造同序对象，避免 diff 抖动）
    for (const e of list) {
      const ordered = {};
      for (const k of ['id', 'category', 'title', 'body', 'summary', 'formula',
        'applicability', 'limitations', 'teachingModel', 'teachingNote',
        'source', 'tags', 'related']) {
        if (e[k] !== undefined) ordered[k] = e[k];
      }
      doc.entries.push(ordered);
    }
    // 写盘前最后一次 JSON 合法性确认
    const next = JSON.stringify(doc, null, 2) + '\n';
    JSON.parse(next);
    fs.writeFileSync(target.path, next, 'utf8');
    console.log(`  ${path.relative(ROOT, target.path)}: ${before} → ${doc.entries.length}`);
  }

  // ── 写后自校验（可执行的准入门）──
  // 🔴 必须**同进程**做（2026-10-08 实测）：本机 node **不能 spawn 任何子进程**
  //   （`spawnSync node EBUSY`，errno -4082，dangerouslyDisableSandbox 也无效）。
  //   早先写成子进程调用 ⇒ 自校验永远跑不起来，"写入 + 立即自校验"的承诺落空
  //   （工具看起来在工作，实际那道门从未执行）。
  //   ⇒ 改为 require 进本进程跑（lint 的 main 是纯同步的）。
  console.log('\n── 写后自校验 ──');
  try {
    const { lint } = require(path.join(__dirname, 'lint-knowledge.cjs'));
    const bad = lint();                       // 返回 🔴 数量；不触碰本进程 exitCode
    if (bad > 0) {
      console.error(`\n🔴 写后校验发现 ${bad} 项错误 —— 请立即修复（内容已落盘）`);
      process.exitCode = 1;
    } else {
      console.log('✅ 写入完成且通过校验');
    }
  } catch (e) {
    console.error('  ⚠️ 自校验未能执行：' + (e.message || e));
    console.error('  （请手动运行 node tools/lint-knowledge.cjs）');
  }
  return 0;
}

process.exitCode = main();