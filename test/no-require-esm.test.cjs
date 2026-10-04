// ─────────────────────────────────────────────────────────────
// 平台兼容回归锁：服务端严禁 require 任何 .mjs
//
//   🔴 为什么必须有这道锁（两次真实线上事故）：
//     本项目是 `"type": "module"`，shared/ 下的共享模块最初写成 .mjs，
//     服务端用 `require('../shared/xxx.mjs')` 加载 —— 这依赖 Node 的
//     `require(ESM)` 特性。**本地 Node 22/24 默认开启，所以本地永远正常**；
//     但线上 Vercel 运行时禁用该特性，抛：
//         [ERR_REQUIRE_ESM] require() of ES Module …/xxx.mjs not supported
//     该异常发生在**模块加载期**，直接让整个 Serverless 函数初始化失败：
//     /api/* 全量 500、登录页也进不去（站点级故障）。
//
//     第一次：shared/rsi.mjs（2026-09-20，见 shared/rsi.cjs 文件头）
//     第二次：shared/modelspec.mjs（2026-10-04，本站上线后 1 小时暴露）
//     —— 同类问题复发，说明"写在注释里的纪律"不成立，必须由测试守住。
//
//   约定（三条同时成立才算合规）：
//     ① shared/ 的实现一律 `.cjs`（后端/测试 require 是 CommonJS 原生行为）；
//     ② 同名 `.mjs` 只做**转发壳**（`export { … } from './xxx.cjs'`），零逻辑；
//     ③ 前端 import 走 `.mjs`，后端 require 走 `.cjs`，各自用最稳的用法。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SHARED = path.join(ROOT, 'shared');
const SELF = path.basename(__filename);

/** 递归收集 .cjs 文件（跳过 node_modules / 构建产物） */
function walkCjs(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 目录不存在：视为无违规
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkCjs(full, out);
    else if (e.name.endsWith('.cjs')) out.push(full);
  }
  return out;
}

/** 逐行找 require('….mjs')，跳过注释行（本仓注释里大量引用文件名，会误报） */
function findMjsRequires(file) {
  const hits = [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    const m = line.match(/require\(\s*['"]([^'"]+\.mjs)['"]\s*\)/);
    if (m) hits.push({ file: path.relative(ROOT, file), line: i + 1, spec: m[1], src: t });
  });
  return hits;
}

test('服务端与测试代码不得 require 任何 .mjs（ERR_REQUIRE_ESM 会拖垮整个函数）', () => {
  const files = [
    ...walkCjs(path.join(ROOT, 'server')),
    ...walkCjs(path.join(ROOT, 'test')),
  ].filter((f) => path.basename(f) !== SELF);

  const offenders = files.flatMap(findMjsRequires);

  assert.deepStrictEqual(
    offenders,
    [],
    offenders.length
      ? `发现 ${offenders.length} 处 require(.mjs)：\n` +
        offenders.map((o) => `  · ${o.file}:${o.line} → ${o.spec}\n    ${o.src}`).join('\n') +
        '\n\n修法：shared/ 下提供同名 .cjs 实现（.mjs 保留为转发壳），' +
        '把这里的 require 指向 .cjs。\n理由：require(ESM) 在本地 Node 默认开启、' +
        '线上运行时禁用，本地测不出来但会整站 500。'
      : '',
  );
});

test('shared/*.mjs 与同名 .cjs 并存时，.mjs 必须是零逻辑的转发壳', () => {
  const mjsFiles = fs.readdirSync(SHARED).filter((f) => f.endsWith('.mjs'));
  const problems = [];

  for (const name of mjsFiles) {
    const stem = name.slice(0, -4);
    const implPath = path.join(SHARED, `${stem}.cjs`);
    if (!fs.existsSync(implPath)) continue; // 纯前端模块（无 .cjs 孪生）：不约束

    // 去掉注释行后看还有没有"实现"痕迹
    const code = fs
      .readFileSync(path.join(SHARED, name), 'utf8')
      .split(/\r?\n/)
      .filter((l) => {
        const t = l.trim();
        return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');

    for (const bad of ['export const', 'export function', 'export default', 'export class', 'export let']) {
      if (code.includes(bad)) problems.push(`${name}：转发壳里出现实现痕迹 \`${bad}\``);
    }
    if (!code.includes(`from './${stem}.cjs'`)) {
      problems.push(`${name}：未指向同名实现 \`./${stem}.cjs\``);
    }
  }

  assert.deepStrictEqual(problems, [], problems.length ? `转发壳不合规：\n  · ${problems.join('\n  · ')}` : '');
});

test('平台兼容现状：三个共享实现均为 .cjs，且可被 CommonJS 直接加载', () => {
  for (const stem of ['rsi', 'modelspec', 'experiments']) {
    const impl = path.join(SHARED, `${stem}.cjs`);
    assert.ok(fs.existsSync(impl), `缺实现 ${stem}.cjs`);
    const mod = require(impl); // 在"禁用 require(ESM)"的运行时同样成立
    assert.strictEqual(typeof mod, 'object', `${stem}.cjs 应导出对象`);
    assert.ok(Object.keys(mod).length > 0, `${stem}.cjs 导出不得为空`);
  }
});
