#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// JSON 里的「中文语境误用英文双引号」检查器
//
//   🔴 为什么需要它（2026-10-08：同一个错误我犯了**两次**）：
//     写中文条目时习惯性用 `"……"` 引中文短语，而 JSON 字符串**也是**双引号
//     定界 ⇒ 提前闭合、文件损坏。报错只说 "position N"，定位要数半天；
//     而**修复成本远低于排查成本**（改全角引号即可）。
//     ⇒ 做成工具：写条目**之前**扫一遍，把"写坏才发现"变成"写前就知道"。
//
//   判据（只报**高置信度**的，避免噪声机器）：
//     一个 JSON 字符串内部出现了**未被转义的英文双引号**，
//     且其**两侧都是中文/全角字符**（典型形态：中文短语被英文引号包住）。
//     ⚠️ 不报「JSON 结构本身的引号」与「已正确转义的 \"」——
//        误报会让这个门被习惯性忽略（比没有门更糟）。
//
//   用法：
//     node tools/lint-json-quotes.cjs <file.json> [more.json ...]
//     退出码 1 = 发现问题
// ─────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

/** 中日韩字符 + 全角标点（用于判断"引号两侧是中文语境"） */
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef\u2018\u2019\u201c\u201d\u300c\u300d\u300e\u300f]/;

/**
 * 扫描原始文本，找出「中文短语被英文双引号包住」的形态。
 *
 * 🔴 判据必须**窄**（2026-10-08 实测教训）：第一版写"引号紧邻 CJK"就报，
 *   结果在真实库上报了 **221 处** —— 因为 JSON 值的边界引号天生就挨着中文
 *   （`"title": "前复权与后复权…"`）。噪声机器比没有门更糟：用三次就没人信。
 *
 * 真正的误用形态有三个特征，必须**同时**满足：
 *   ① 行内**且**在同一个 JSON 字符串值内部（不是值边界）
 *   ② 引号对**两侧都是 CJK**（左侧是中文、右侧也是中文 —— 值边界不会这样：
 *      左边界前是 `: ` 或 `[`，右边界后是 `,` 或 `}`）
 *   ③ 中间**不含 JSON 结构字符**（`:`, `,`, `{`, `}`）—— 排除跨字段的假配对
 * @returns {{line:number, col:number, snippet:string}[]}
 */
function scanText(raw) {
  const hits = [];
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.includes('"')) return;
    // 收集未转义的引号位置
    const pos = [];
    for (let k = 0; k < line.length; k++) {
      if (line[k] !== '"') continue;
      let bs = 0;
      for (let j = k - 1; j >= 0 && line[j] === '\\'; j--) bs++;
      if (bs % 2 === 1) continue;
      pos.push(k);
    }
    // 逐对检查：形态必须是 中文 " …中文… " 中文
    for (let a = 0; a < pos.length - 1; a++) {
      const p = pos[a], q = pos[a + 1];
      const before = line[p - 1] || '';
      const after = line[q + 1] || '';
      const inner = line.slice(p + 1, q);
      // ① 两侧都必须是 CJK（值边界的左引号前是冒号/空格，右引号后是逗号/括号）
      if (!CJK.test(before) || !CJK.test(after)) continue;
      // ② 中间必须有实义内容且不含 JSON 结构字符
      if (!inner.trim()) continue;
      if (/[:{},]/.test(inner)) continue;
      if (!CJK.test(inner) && !/[A-Za-z0-9]/.test(inner)) continue;
      hits.push({
        line: i + 1,
        col: p + 1,
        snippet: line.slice(Math.max(0, p - 10), q + 11),
      });
    }
  });
  return hits;
}

/**
 * 供其他工具调用（如 add-entries 的写前预检）。
 * @param {string} absPath 绝对路径
 * @returns {{legal:boolean, error:string, quotes:{line,col,snippet}[]}}
 */
function lintQuotes(absPath) {
  const raw = fs.readFileSync(absPath, 'utf8');
  let legal = true, error = '';
  try { JSON.parse(raw); } catch (e) { legal = false; error = e.message; }
  return { legal, error, quotes: scanText(raw) };
}

// 🔴 出口分两态（同 lint-knowledge）：直接运行 → 报告并设 exitCode；
//   被 require → 只返回结果，不碰调用方的 exitCode。
if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('用法：node tools/lint-json-quotes.cjs <file.json> [...]');
    process.exit(2);
  }

  let total = 0;
  for (const f of files) {
    const abs = path.isAbsolute(f) ? f : path.join(process.cwd(), f);
    if (!fs.existsSync(abs)) { console.error(`⚠️ 不存在：${f}`); continue; }
    const { legal, error, quotes: hits } = lintQuotes(abs);

    console.log(`\n══ ${path.basename(abs)} ══`);
    console.log(legal ? '  ✅ JSON 合法' : `  🔴 JSON 非法：${error}`);

    if (!legal) {
      const m = error.match(/position (\d+)/);
      if (m) {
        const ln = fs.readFileSync(abs, 'utf8').slice(0, Number(m[1])).split('\n').length;
        console.log(`  ↳ 问题约在第 ${ln} 行`);
      }
      total++;
    }

    if (hits.length) {
      console.log(`  🟡 疑似中文语境误用英文双引号 ${hits.length} 处（建议改「」）：`);
      for (const h of hits.slice(0, 8)) console.log(`     第 ${h.line} 行: …${h.snippet}…`);
      if (hits.length > 8) console.log(`     … 其余 ${hits.length - 8} 处`);
      if (!legal) total++;
    } else if (legal) {
      console.log('  ✅ 未发现中文语境误用英文双引号');
    }
  }

  console.log(`\n${total ? `🔴 ${total} 个文件有问题` : '✅ 全部通过'}`);
  process.exitCode = total ? 1 : 0;
} else {
  module.exports = { lintQuotes };
}