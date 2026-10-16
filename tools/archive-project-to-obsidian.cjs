#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// 项目 → Obsidian 归档器（第二大脑 / 永久记忆）
//
// 用途：把整个项目的源文件归档为 Obsidian 模块笔记，
//   使「日后审查某个模块 / 调取某段实现」可以在知识库里完成。
//
// 🔴 与 export-to-obsidian.cjs 的分工：
//   · export-to-obsidian.cjs —— 导出「知识库条目」（server/knowledge/*.json，106 条）
//   · 本脚本 —— 归档「项目源码模块」（185 个源文件）
//
// 🔴 核心设计：**不写模块说明，只提取既有事实**
//   实测 185 个文件里 **91% 有规范的文件头注释**（`// ───` 包裹，
//   写明职责、设计要点、甚至历史事故）。这些注释是作者深思的产物 ——
//   由脚本原文提取，比 AI 转述**准确且无臆造风险**。
//   ⇒ 本脚本只做四件事：提取注释 / 列出导出 / 建依赖双链 / 附元信息。
//
// 🔴 命名方案：**相对路径转中划线**
//   实测有 4 组同名文件（experiments.cjs 在 server 与 shared 各一份、
//   index.cjs 在 server 与 server/news 各一份、matcher.cjs、index.ts），
//   只用文件名会造成双链歧义 ⇒
//   `server/knowledge.cjs` → `server-knowledge.cjs`（保留扩展名，唯一且可读）
//
// 🔴 安全约束（与用户规则同源）：
//   ① 只新增不覆盖（已存在则跳过，除非 --force）
//   ② 写入前用与 scan-secrets.sh 同源的判据自检，命中即拒绝该条
//   ③ 只写目标路径，不碰 .obsidian/、不执行 git 命令、不删除任何文件
//
// 用法：
//   node tools/archive-project-to-obsidian.cjs --dry-run
//   node tools/archive-project-to-obsidian.cjs --limit 5
//   node tools/archive-project-to-obsidian.cjs
//   node tools/archive-project-to-obsidian.cjs --dir server
// ─────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// 🔴 目标库路径**不写死在仓库里**：本仓库是公开的，不宜含本机目录结构。
//   通过环境变量 OBSIDIAN_VAULT 指定（设一次即可，见 main 里的提示）。
const VAULT = (process.env.OBSIDIAN_VAULT || '').trim();
const BASE = path.join(VAULT, '10-Projects', 'AI深度量化平台', '模块档案');

/** 归档范围（目录 → 中文分类名） */
const SCOPE = {
  server: '后端',
  src: '前端',
  shared: '共享层',
  tools: '工具',
  scripts: '脚本',
};

/** 与 scan-secrets.sh 同源的敏感判据（带名称，便于定位而不回显内容） */
const SECRET_PATTERNS = [
  ['api-key 形态', /sk-[a-z0-9]{10,}/i],
  ['github token 形态', /ghp_[a-z0-9]{20,}/i],
  ['AWS key 形态', /AKIA[0-9A-Z]{16}/],
  ['私钥头', /BEGIN [A-Z ]*PRIVATE KEY/],
  ['凭据赋值形态', /(api[_-]?key|secret|passwd|password|token)[ ]*[:=][ ]*[^ ]{8,}/i],
];

/**
 * 敏感自检 —— **只返回模式名与行号，绝不回显匹配到的内容**。
 * 🔴 用户的规则明确要求扫描器"只输出文件:行号，不回显内容本身"——
 *   我起初返回截断的匹配文本，那等于把敏感内容打进了日志（已改）。
 */
function findSecret(text) {
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    for (const [name, re] of SECRET_PATTERNS) {
      if (re.test(lines[i])) return { name, line: i + 1 };
    }
  }
  return null;
}

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.name === 'node_modules' || f.name.startsWith('.')) continue;
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out);
    else if (/\.(cjs|mjs|ts|tsx)$/.test(f.name)) out.push(p);
  }
  return out;
}

/** 相对路径 → 笔记名（同时用作双链目标） */
function noteName(rel) {
  return rel.split(path.sep).join('/').replace(/[/]/g, '-');
}

/**
 * 提取文件头注释块。
 * 识别的形态：以 `// ───` 或 `/* ───` 开头的说明块，取到匹配的结束线。
 */
function extractHeader(src) {
  const lines = src.split('\n');
  // 跳过 shebang 与紧邻的空行
  let i = 0;
  while (i < lines.length && (lines[i].startsWith('#!') || lines[i].trim() === '')) i += 1;
  if (i >= lines.length) return '';
  const first = lines[i].trim();
  if (!/^(\/\/|\/\*)\s*─{5,}/.test(first)) return '';   // 非规范头注释

  const isBlock = first.startsWith('/*');
  const stop = isBlock ? /─{5,}\s*\*\/\s*$/ : /^(\/\/)?\s*─{5,}\s*$/;
  const out = [];
  for (let j = i; j < lines.length; j += 1) {
    const raw = lines[j];
    if (j > i && stop.test(raw.trim())) break;
    // 跳过首行分隔线（`// ─────` 只是框线，不是内容）
    if (j === i) continue;
    out.push(raw.replace(/^\s*\/\/\s?/, '').replace(/^\s*\*\/?\s?/, '').trimEnd());
    if (out.length > 80) break;                          // 防失控
  }
  return out.join('\n').trim();
}

/** 提取导出符号（近似：CJS 的 module.exports 与 ESM 的 export） */
function extractExports(src) {
  const names = new Set();
  const m = src.match(/module\.exports\s*=\s*\{([\s\S]{0,3000}?)\}\s*;?/);
  if (m) {
    for (const seg of m[1].split(',')) {
      const n = seg.split(':')[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
    }
  }
  for (const mm of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class|type|interface)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(mm[1]);
  }
  if (/export\s+default/.test(src)) names.add('(default)');
  return [...names];
}

/** 提取项目内相对依赖（→ 笔记名） */
function extractDeps(src) {
  const deps = new Set();
  const re = /(?:require\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"])/g;
  for (const m of src.matchAll(re)) {
    const spec = m[1] || m[2];
    if (!spec || !spec.startsWith('.')) continue;        // 只留相对路径
    deps.add(spec);
  }
  return [...deps];
}

/** 把相对依赖解析为项目内文件的相对路径 */
function resolveDep(fromRel, spec) {
  const base = path.join(ROOT, path.dirname(fromRel), spec);
  const cands = [
    base, `${base}.cjs`, `${base}.mjs`, `${base}.ts`, `${base}.tsx`,
    path.join(base, 'index.cjs'), path.join(base, 'index.ts'), path.join(base, 'index.tsx'),
  ];
  for (const c of cands) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      return path.relative(ROOT, c);
    }
  }
  return null;
}

/**
 * 读取已存在笔记的 created 值（沿用首次归档日期）。
 *
 * 🔴 为什么需要（2026-10-16 修）：`created` 原本每次都写 new Date()，
 *   于是**每次 --force 更新都会把所有笔记的日期改成当天** ——
 *   既丢失"这篇是什么时候首次归档的"，又让 git diff 全量污染
 *   （186 个文件全部变更，真实改动被淹没）。
 *   ⚠️ 这条在"要频繁更新第二大脑"的工作流下会反复触发，故必须修。
 *   ⇒ 只有在**首次创建**时写入今天；更新时沿用原值。
 */
function readCreated(dest) {
  try {
    if (!fs.existsSync(dest)) return null;
    const m = fs.readFileSync(dest, 'utf8').match(/^created:\s*(\S+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function render(rec, createdAt) {
  const header = extractHeader(rec.src);
  const exports = extractExports(rec.src);
  const parts = [
    '---',
    'type: module',
    `created: ${createdAt || new Date().toISOString().slice(0, 10)}`,
    `path: ${rec.rel.split(path.sep).join('/')}`,
    `layer: ${rec.layer}`,
    `lines: ${rec.lines}`,
    'tags:',
    // 🔴 统一项目标签（2026-10-16 方案A）：让"项目全貌"可跨文件夹聚合 ——
    //   模块档案在 10-Projects、知识笔记在 20-Knowledge，靠文件夹永远看不全，
    //   靠标签 + Dataview 才能"从一个入口看到项目全部资产"。
    `  - 项目/AI深度量化平台`,
    `  - 模块/${rec.layer}`,
    `  - ${rec.base}`,
    '---',
    '',
    `# ${rec.rel.split(path.sep).join('/')}`,
    '',
  ];
  if (header) parts.push(header, '');
  if (exports.length) {
    parts.push('## 导出', '', ...exports.map((e) => `- \`${e}\``), '');
  }
  if (rec.deps.length) {
    parts.push('## 依赖（上游）', '', ...rec.deps.map((d) => `- [[${d}]]`), '');
  }
  if (rec.usedBy.length) {
    parts.push('## 被依赖（下游）', '', ...rec.usedBy.map((d) => `- [[${d}]]`), '');
  }
  parts.push(
    '## 元信息',
    '',
    `- 行数：${rec.lines}`,
    `- 归档时间：${new Date().toISOString().slice(0, 10)}`,
    `- 仓库路径：\`${rec.rel.split(path.sep).join('/')}\``,
    '',
  );
  return parts.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  const li = argv.indexOf('--limit');
  const limit = li >= 0 ? Number(argv[li + 1]) : 0;
  const di = argv.indexOf('--dir');
  const dirFilter = di >= 0 ? argv[di + 1] : null;

  if (!VAULT) {
    console.error('✗ 未指定目标库路径。本脚本不硬编码本机路径（仓库是公开的）。');
    console.error('  请先设置环境变量 OBSIDIAN_VAULT，二选一：');
    console.error('    · 永久（Windows，设一次、重开终端生效）：');
    console.error('        setx OBSIDIAN_VAULT "<你的 Obsidian 库绝对路径>"');
    console.error('    · 临时（本次会话）：');
    console.error('        OBSIDIAN_VAULT="<路径>" node <本脚本>');
    process.exit(1);
  }
  if (!fs.existsSync(VAULT)) {
    console.error(`✗ 目标库不存在：${VAULT}`);
    console.error('  （请检查 OBSIDIAN_VAULT 是否指向正确的库目录）');
    process.exit(1);
  }

  // 收集全部源文件
  let files = [];
  for (const d of Object.keys(SCOPE)) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    if (dirFilter && d !== dirFilter) continue;
    files = files.concat(walk(abs));
  }
  console.log(`扫描到 ${files.length} 个源文件`);

  // 第一遍：建 id→笔记名 与 反向依赖图
  const nameOf = new Map();      // rel → 笔记名
  const usedBy = new Map();      // rel → Set(rel)
  const depsOf = new Map();      // rel → [rel]
  for (const abs of files) {
    const rel = path.relative(ROOT, abs);
    nameOf.set(rel, noteName(rel));
  }
  for (const abs of files) {
    const rel = path.relative(ROOT, abs);
    const src = fs.readFileSync(abs, 'utf8');
    const resolved = extractDeps(src).map((s) => resolveDep(rel, s)).filter(Boolean);
    depsOf.set(rel, resolved);
    for (const r of resolved) {
      if (!usedBy.has(r)) usedBy.set(r, new Set());
      usedBy.get(r).add(rel);
    }
  }

  // 第二遍：渲染
  const recs = files.map((abs) => {
    const rel = path.relative(ROOT, abs);
    const src = fs.readFileSync(abs, 'utf8');
    return {
      rel,
      base: path.basename(rel).split('.')[0],
      layer: SCOPE[rel.split(path.sep)[0]] || '其他',
      lines: src.split('\n').length,
      src,
      deps: (depsOf.get(rel) || []).map((r) => nameOf.get(r)).filter(Boolean),
      usedBy: [...(usedBy.get(rel) || [])].map((r) => nameOf.get(r)).filter(Boolean),
    };
  });

  const sliced = limit > 0 ? recs.slice(0, limit) : recs;
  if (limit > 0) console.log(`按 --limit 截取 ${sliced.length} 条`);

  if (dryRun) {
    console.log('\n=== DRY RUN（不写文件）===');
    for (const r of sliced) {
      const secret = findSecret(render(r));   // 🔴 扫的是**将写入的 md**，非原始源码
      console.log(`  ${secret ? '⛔' : '✅'} ${nameOf.get(r.rel)}.md  ` +
        `(依赖 ${r.deps.length} / 被依赖 ${r.usedBy.length})` +
        (secret ? ` ← 命中【${secret.name}】于第 ${secret.line} 行` : ''));
    }
    return;
  }

  let written = 0, skipped = 0, blocked = 0;
  for (const r of sliced) {
    const dir = path.join(BASE, r.layer);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${nameOf.get(r.rel)}.md`);

    const md = render(r, readCreated(dest));   // 沿用首次归档日期（见 readCreated 注释）
    const secret = findSecret(md);   // 🔴 与 scan-secrets.sh 口径一致：扫 md 内容
    if (secret) {
      console.log(`  ⛔ 拒绝：${nameOf.get(r.rel)} —— 命中【${secret.name}】于第 ${secret.line} 行（不回显内容）`);
      blocked += 1;
      continue;
    }
    if (fs.existsSync(dest) && !force) { skipped += 1; continue; }

    fs.writeFileSync(dest, md, 'utf8');
    written += 1;
  }
  console.log(`\n✅ 新增 ${written} · 跳过 ${skipped} · 拒绝 ${blocked}`);
  console.log(`   目标：${BASE}`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('归档失败：', e.message); process.exitCode = 1; }
} else {
  module.exports = { noteName, extractHeader, extractExports, extractDeps, findSecret };
}