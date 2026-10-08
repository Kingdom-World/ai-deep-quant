#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// 知识库条目校验器（Phase 2.5 扩容前置）
//
//   🔴 为什么扩容前必须先有它：
//     知识库原本**没有任何条目级 schema 校验** —— 约束散在测试里、只覆盖
//     部分字段。条目从 70 扩到 300+ 时，手写 JSON 的字段错误（拼错的键名、
//     漏掉的必填项、跨文件引用悬空）会**静默进库**：加载不报错、检索照常，
//     只是那一栏永远为空 —— 与「产出 6 处臆造字段名」是同一类失败。
//     ⇒ 校验必须**在写入之前**卡住，而不是发到线上靠肉眼发现。
//
//   本工具是**可执行的门**（不是文档）：`node tools/lint-knowledge.cjs`
//   退出码非 0 即失败，可直接进 CI。
//
//   用法：
//     node tools/lint-knowledge.cjs            # 全量校验，有问题则退出码 1
//     node tools/lint-knowledge.cjs --verbose  # 逐条列出
// ─────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.env.KNOWLEDGE_DIR = path.join(ROOT, 'server', 'knowledge');
const kb = require('../server/knowledge.cjs');

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');

// ── 规范（单一源：字段清单/必填/类型都在这里）────────────────────

/** 允许的顶层字段（多出的字段说明拼错了键名） */
const ALLOWED_KEYS = new Set([
  'id', 'category', 'title', 'body', 'summary', 'formula',
  'applicability', 'limitations', 'teachingModel', 'teachingNote',
  'source', 'tags', 'related',
]);

/** 必填字段（非空字符串） */
const REQUIRED_TEXT = ['id', 'category', 'title', 'body', 'source'];

/** 允许的分类（与 shared/knowledge-layers.cjs 对照后可扩展，但必须显式登记） */
const KNOWN_CATEGORIES = new Set(['term', 'method', 'principle', 'case', 'cycle', 'basis', 'paper']);

/** id 前缀必须与 category 一致（防复制粘贴时忘改 id） */
const ID_PREFIX = {
  term: 'term-', method: 'method-', principle: 'principle-',
  case: 'case-', cycle: 'cycle-', basis: 'basis-', paper: 'paper-',
};

/** 正文长度下限（太短说明没写实质内容；实测现有条目最短约 80 字） */
const MIN_BODY = 60;

const problems = [];
const add = (level, id, msg) => problems.push({ level, id, msg });

function main() {
  const items = kb.search('', { limit: 9999, includeDraft: true }).items;
  const idSet = new Set(items.map((e) => e.id));

  // ── 逐条校验 ──
  for (const e of items) {
    const tag = e.id || '(无 id)';

    // ① 必填非空
    for (const k of REQUIRED_TEXT) {
      if (!e[k] || !String(e[k]).trim()) add('🔴', tag, `必填字段为空：${k}`);
    }
    // ② 未知字段（拼错的键名）
    for (const k of Object.keys(e)) {
      // 运行时派生字段（由 knowledge.cjs 计算，不应出现在 JSON 里）
      if (['categoryLabel', 'isTeachingLayer', 'sourceRefs', 'citationStrength', 'draft', 'score', 'matched'].includes(k)) continue;
      if (!ALLOWED_KEYS.has(k)) add('🔴', tag, `未知字段「${k}」—— 可能是键名拼错（写入后该字段会被忽略）`);
    }
    // ③ 分类合法 + id 前缀一致
    if (e.category && !KNOWN_CATEGORIES.has(e.category)) {
      add('🔴', tag, `未知分类「${e.category}」`);
    } else if (e.category && e.id) {
      const want = ID_PREFIX[e.category];
      if (want && !String(e.id).startsWith(want)) {
        add('🔴', tag, `id 前缀与分类不符：分类 ${e.category} 要求以「${want}」开头`);
      }
    }
    // ④ 正文长度
    if (e.body && String(e.body).trim().length < MIN_BODY) {
      add('🟡', tag, `正文过短（${String(e.body).trim().length} < ${MIN_BODY} 字）—— 是否没写实质内容？`);
    }
    // ⑤ related 悬空
    for (const r of e.related || []) {
      if (!idSet.has(r)) add('🔴', tag, `related 指向不存在的 id：${r}`);
    }
    // ⑥ 自引用（无害但通常是复制粘贴残留）
    if ((e.related || []).includes(e.id)) add('🟡', tag, 'related 包含自身');
    // ⑦ teachingModel 与 teachingNote 必须成对
    if (e.teachingModel && !e.teachingNote) {
      add('🔴', tag, '有 teachingModel 但无 teachingNote（学生不知道要观察什么）');
    }
    if (!e.teachingModel && e.teachingNote) {
      // 🔴 "故意不挂"是**既定的正确设计**，不是遗漏（本项目明令：
      //   不适配时置 null 并说明理由，不得硬凑一个模型）。
      //    实测 case-ltcm-1998 的 note 开头就是「🔴 故意不挂教学模型：…」。
      //    ⇒ 只有**没有说明理由**的才提醒；有理由的视为合规。
      const explained = /故意不挂|不挂教学模型|无可挂|不适用|暂不挂/.test(String(e.teachingNote));
      if (!explained) {
        add('🟡', tag, '有 teachingNote 但无 teachingModel（且未说明理由 —— 是忘了还是不适配？）');
      }
    }
    // ⑧ tags 非空且无重复
    if (!Array.isArray(e.tags) || !e.tags.length) add('🟡', tag, 'tags 为空（影响检索召回）');
    if (Array.isArray(e.tags) && new Set(e.tags).size !== e.tags.length) {
      add('🟡', tag, 'tags 有重复项');
    }
    // ⑨ sourceRefs 解析健康度
    const refs = e.sourceRefs || [];
    if (!refs.length) add('🔴', tag, 'source 无法解析出任何引用（sourceRefs 为空）');
    if (refs.some((r) => !r.kind)) add('🟡', tag, '有 sourceRefs 缺 kind');
  }

  // ── 全局约束 ──
  const ids = items.map((e) => e.id);
  const dup = ids.filter((v, i, a) => a.indexOf(v) !== i);
  for (const d of new Set(dup)) add('🔴', d, 'id 重复');

  // 🔴 双向闭合（2026-10-08 加）：`related` 必须**互相**指向。
  //   这条门原来只在 test/knowledge.test.cjs 里，而测试是**事后**才发现；
  //   放进 lint 后变成**写前/写后**可查（add-entries 会调用 lint）。
  //   实测教训：本批 10 条里漏了 2 处"新条目之间互指"——工具只补了"新→旧"。
  const idSet2 = new Set(ids);
  for (const e of items) {
    for (const r of e.related || []) {
      if (!idSet2.has(r)) continue;                      // 悬空另测
      const other = items.find((x) => x.id === r);
      if (other && !(other.related || []).includes(e.id)) {
        add('🔴', e.id, `单向关联（${r} 未回指 ${e.id}）—— related 必须双向闭合`);
      }
    }
  }

  // 文献不得是孤岛（paper 必须被至少一条非 paper 条目引用）
  const papers = items.filter((e) => e.category === 'paper');
  for (const p of papers) {
    const cited = items.some((e) => e.category !== 'paper' && (e.related || []).includes(p.id));
    if (!cited) add('🟡', p.id, 'paper 是孤岛（无任何条目引用它）');
  }

  // teachingNote 互异（既有纪律：不得多条共用同一说明）
  const notes = new Map();
  for (const e of items) {
    if (!e.teachingNote) continue;
    const k = String(e.teachingNote);
    notes.set(k, [...(notes.get(k) || []), e.id]);
  }
  for (const [n, v] of notes) {
    if (v.length > 1) add('🔴', v.join('+'), `teachingNote 重复（${v.length} 条共用同一说明）：${n.slice(0, 40)}…`);
  }

  // ── 报告 ──
  const byLevel = { '🔴': [], '🟡': [] };
  for (const p of problems) byLevel[p.level].push(p);

  console.log(`\n══ 知识库条目校验 ══`);
  console.log(`条目 ${items.length} 条（含草稿）`);
  console.log(`🔴 错误 ${byLevel['🔴'].length} / 🟡 提醒 ${byLevel['🟡'].length}\n`);

  for (const lv of ['🔴', '🟡']) {
    const list = byLevel[lv];
    if (!list.length) continue;
    console.log(`${lv} ${lv === '🔴' ? '错误（必须修）' : '提醒（建议修）'}：`);
    for (const p of list.slice(0, VERBOSE ? 999 : 25)) {
      console.log(`  · [${p.id}] ${p.msg}`);
    }
    if (!VERBOSE && list.length > 25) console.log(`  … 其余 ${list.length - 25} 条（加 --verbose 看全部）`);
    console.log('');
  }

  if (!problems.length) console.log('✅ 全部通过\n');
  return byLevel['🔴'].length ? 1 : 0;
}

// 🔴 出口分两态（2026-10-08 修）：直接运行 → 设 exitCode 并结束；
//   被 require（如 add-entries 的写后自校验）→ **只返回结果，不碰 exitCode**。
//   早先无条件 `process.exitCode = code` ⇒ 被 require 时会污染调用方的退出码，
//   让「写入成功」变成「写入失败」的假象（本机不能 spawn 子进程，只能 require，
//   所以这个分态是必须的）。
if (require.main === module) {
  process.exitCode = main();
} else {
  module.exports = { lint: main, lintOnce: () => main() };
}