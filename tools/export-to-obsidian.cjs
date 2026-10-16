#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// 知识库 → Obsidian 导出器
//
// 用途：把 `server/knowledge/*.json` 的 106 条结构化知识导出为 Obsidian 笔记，
//   让它们进入「第二大脑」（D:\Obsidian\我的知识库\20-Knowledge\）。
//
// 🔴 为什么不直接把 JSON 拷过去：
//   知识条目的 `related` 字段存的是**条目 id**（如 `method-lookahead`），
//   而 Obsidian 双链要的是**笔记名**。本脚本负责 id → 标题 的映射，
//   把 606 条引用边转成可用的 [[双链]] ⇒ 一次导入即形成知识图谱。
//
// 🔴 三条安全约束（用户明令，违反即失败）：
//   ① **只新增，不覆盖**：目标文件已存在则**跳过**（除非显式 --force）。
//      用户的规则是「对知识库只允许新增笔记」。
//   ② **写入前自检**：用与用户 `tools/scan-secrets.sh` **同一套判据**扫描
//      将要写入的内容，命中则**拒绝写入该条**并报告。
//      宁可不导入，也不让敏感模式进库（他的备份会离开本机）。
//   ③ **不碰任何非目标路径**：只写 20-Knowledge/ 下的 .md，不碰 .obsidian/、
//      不执行 git 命令、不删除任何文件。
//
// 用法：
//   node tools/export-to-obsidian.cjs --dry-run          # 只报告，不写任何文件
//   node tools/export-to-obsidian.cjs --limit 5          # 样板（只导出前 5 条）
//   node tools/export-to-obsidian.cjs                    # 全量导出
//   node tools/export-to-obsidian.cjs --layer terms      # 只导出某一层
// ─────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'server', 'knowledge');
// 🔴 目标库路径**不写死在仓库里**：本仓库是公开的，不宜含本机目录结构。
//   通过环境变量 OBSIDIAN_VAULT 指定（设一次即可，见 main 里的提示）。
const VAULT = (process.env.OBSIDIAN_VAULT || '').trim();
const OUT_DIR = path.join(VAULT, '20-Knowledge');

/** 分层中文名（用于标签与展示） */
const LAYER_LABEL = {
  terms: '术语',
  methods: '方法',
  principle: '原理',
  basis: '本项目实现',
  paper: '文献',
  case: '案例',
  cycle: '周期',
};

/** 与用户 tools/scan-secrets.sh 保持同源的敏感判据（读该文件可核对） */
const SECRET_PATTERNS = [
  /sk-[a-z0-9]{10,}/i,
  /ghp_[a-z0-9]{20,}/i,
  /AKIA[0-9A-Z]{16}/,
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /(api[_-]?key|secret|passwd|password|token)[ ]*[:=][ ]*[^ ]{8,}/i,
];

/**
 * 把标题转成合法的 Obsidian 文件名 / 双链目标。
 *
 * 🔴 为什么必须做：Obsidian 文件名不能含 `\ / : * ? " < > |`。
 *   实测 106 条里有 **8 条标题含 `/`**（如「佣金 / 印花税 / 过户费」），
 *   不处理会写到错误路径或直接失败。
 *   替换为**全角字符**而非删除 —— 保持可读性，且全角在这些位置是合法的。
 * ⚠️ 双链的显示文本也必须用同一函数处理，否则 [[名]] 对不上文件名。
 */
function safeName(title) {
  const map = {
    '/': '／', '\\': '＼', ':': '：', '*': '＊',
    '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜',
  };
  return String(title).trim().replace(/[/\\:*?"<>|]/g, (m) => map[m]);
}

/**
 * 把标签转成 Obsidian 可识别的形式。
 *
 * 🔴 与 safeName 的**关键区别**（2026-10-13 首次生成样板时踩到）：
 *   Obsidian 标签**必须保留 `/` 做层级**（`#知识/术语`），且**不允许含空格**。
 *   我起初复用了 safeName 把 `/` 也替换成空格 ⇒ 生成 `知识 本项目实现`
 *   ⇒ 在 Obsidian 里**不是有效标签**（会被当普通词忽略）。
 *   ⇒ 标签只替换真正非法的字符，`/` 原样保留。
 */
function safeTag(tag) {
  return String(tag)
    .trim()
    .replace(/[\\:*?"<>|#^[\]]/g, ' ')   // 保留 / 做层级
    .replace(/\s+/g, ' ')                 // 折叠多余空格
    .trim();
}

/** 读取全部知识条目 */
function loadAll() {
  const items = [];
  for (const f of fs.readdirSync(SRC_DIR).filter((x) => x.endsWith('.json')).sort()) {
    const doc = JSON.parse(fs.readFileSync(path.join(SRC_DIR, f), 'utf8'));
    const layer = f.replace('.json', '');
    for (const e of doc.entries || []) {
      if (!e || !e.id || !e.title) continue;
      items.push({ ...e, layer });
    }
  }
  return items;
}

/** 敏感自检：命中即拒绝写入该条 */
function findSecret(text) {
  for (const re of SECRET_PATTERNS) {
    const m = String(text).match(re);
    if (m) return m[0].slice(0, 20) + '…';
  }
  return null;
}

/** 读取已存在笔记的 created 值（沿用首次归档日期）。
 *  🔴 见 archive 脚本同名函数的注释：`created` 若每次写 new Date()，
 *    会让每次 --force 更新都把全部笔记的日期改成当天（丢首次日期 + git diff 全量污染）。 */
function readCreated(dest) {
  try {
    if (!fs.existsSync(dest)) return null;
    const m = fs.readFileSync(dest, 'utf8').match(/^created:\s*(\S+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** 生成一条笔记的 markdown */
function render(item, titleById, createdAt) {
  const title = safeName(item.title);
  const label = LAYER_LABEL[item.layer] || item.layer;
  const tags = [
    // 🔴 统一项目标签（2026-10-16 方案A）：见 archive 脚本同名注释。
    //   ⚠️ 标签表示「关联」而非「独占」—— Obsidian 标签可多值，
    //   将来若这些知识也服务别的项目，再加一个项目标签即可，不会绑死。
    '项目/AI深度量化平台',
    `知识/${label}`,
    ...(Array.isArray(item.tags) ? item.tags : []),
  ].map((t) => `  - ${safeTag(t)}`).filter((line, i, arr) => arr.indexOf(line) === i);

  // id → 标题 双链（跳过无法解析的，避免死链）
  const rel = (Array.isArray(item.related) ? item.related : [])
    .map((rid) => titleById.get(rid))
    .filter(Boolean)
    .map((t) => `- [[${t}]]`);

  const parts = [
    '---',
    'type: note',
    `created: ${createdAt || new Date().toISOString().slice(0, 10)}`,
    `source_id: ${item.id}`,
    `layer: ${label}`,
    'tags:',
    ...tags,
    '---',
    '',
    `# ${title}`,
    '',
    String(item.body || '').trim(),
    '',
  ];

  if (rel.length) {
    parts.push('## 关联', '', ...rel, '');
  }
  if (item.source) {
    parts.push('## 来源', '', String(item.source).trim(), '');
  }
  parts.push(
    '---',
    '',
    `> 由「AI深度量化平台」知识库导出 · 来源 id：\`${item.id}\` · 分层：${label}`,
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
  const lyi = argv.indexOf('--layer');
  const layerFilter = lyi >= 0 ? argv[lyi + 1] : null;

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

  let items = loadAll();
  console.log(`读入 ${items.length} 条知识（${new Set(items.map((i) => i.layer)).size} 个分层）`);

  // id → 安全标题 映射（双链与文件名共用，保证一致）
  const titleById = new Map(items.map((i) => [i.id, safeName(i.title)]));

  if (layerFilter) {
    items = items.filter((i) => i.layer === layerFilter);
    console.log(`按 --layer ${layerFilter} 过滤后：${items.length} 条`);
  }
  if (limit > 0) {
    items = items.slice(0, limit);
    console.log(`按 --limit ${limit} 截取：${items.length} 条`);
  }

  if (dryRun) {
    console.log('\n=== DRY RUN（不写任何文件）===');
    for (const it of items) {
      const secret = findSecret(it.body + it.source + it.title);
      console.log(`  ${secret ? '⛔' : '✅'} ${safeName(it.title)}` +
        (secret ? `  ← 敏感命中：${secret}` : ''));
    }
    console.log(`\n将写入：${OUT_DIR}`);
    return;
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  let written = 0, skipped = 0, blocked = 0;
  for (const it of items) {
    const name = safeName(it.title) + '.md';
    const dest = path.join(OUT_DIR, name);

    // 约束②：敏感自检（宁可不导入）
    const secret = findSecret(it.body + it.source + it.title);
    if (secret) {
      console.log(`  ⛔ 拒绝写入（敏感命中 ${secret}）：${name}`);
      blocked += 1;
      continue;
    }
    // 约束①：只新增不覆盖
    if (fs.existsSync(dest) && !force) {
      console.log(`  ⏭ 已存在，跳过：${name}`);
      skipped += 1;
      continue;
    }
    fs.writeFileSync(dest, render(it, titleById, readCreated(dest)), 'utf8');
    written += 1;
  }

  console.log(`\n✅ 新增 ${written} 条 · 跳过（已存在）${skipped} 条 · 拒绝 ${blocked} 条`);
  console.log(`   目标：${OUT_DIR}`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('导出失败：', e.message); process.exitCode = 1; }
} else {
  module.exports = { safeName, safeTag, loadAll, render, findSecret, LAYER_LABEL };
}