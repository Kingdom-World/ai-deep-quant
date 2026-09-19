// ─────────────────────────────────────────────────────────────
// 知识库 · 关联条目契约测试（防回归，2026-09-19 新增）
//
//   背景：前端 KnowledgeTab「查看关联条目」点了没反应。
//   根因是**纯前端**状态键错位（展开标记按目标 id 写、渲染按自身 id 读），
//   后端接口一直是对的。本文件锁死**后端契约**，防止后续改动引入断链——
//   断链在前端同样表现为"永远加载中"，症状与本次 bug 无法区分。
//
//   不变量：
//   ① 所有 related 引用都能被 byIds 解析（无断链）
//   ② byIds 多 id 批量查询返回全部命中项
//   ③ byIds 对空数组 / 不存在 id 安全返回，不抛错
//   ④ 所有条目的 related 字段都是数组（前端 .map 依赖此形状）
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

process.env.KNOWLEDGE_DIR = path.join(__dirname, '..', 'server', 'knowledge');
const kb = require('../server/knowledge.cjs');

test('【防回归】byIds 能解析所有条目的 related 引用（无断链）', () => {
  const all = kb.search('', { limit: 1000 }).items;
  const broken = [];
  for (const e of all) {
    for (const rid of e.related || []) {
      if (!kb.byIds([rid]).length) broken.push(e.id + ' → ' + rid);
    }
  }
  assert.equal(broken.length, 0, '关联断链：' + broken.join(', '));
});

test('【防回归】byIds 多 id 批量查询返回全部命中项', () => {
  const all = kb.search('', { limit: 1000 }).items;
  const withRel = all.find((e) => (e.related || []).length >= 2);
  assert.ok(withRel, '应存在至少一条含 2 个以上关联的条目');
  const got = kb.byIds(withRel.related);
  assert.equal(got.length, withRel.related.length, '批量查询应返回全部关联条目');
  assert.deepEqual(
    got.map((e) => e.id).sort(),
    [...withRel.related].sort(),
    '返回的 id 集合应与请求一致',
  );
});

test('【防回归】byIds 对空数组与不存在的 id 安全返回，不抛错', () => {
  assert.deepEqual(kb.byIds([]), []);
  assert.deepEqual(kb.byIds(['__not_exist__']), []);
  // 混合场景：存在的应返回，不存在的静默忽略
  const one = kb.search('', { limit: 1 }).items[0];
  const mixed = kb.byIds([one.id, '__not_exist__']);
  assert.equal(mixed.length, 1, '混合查询应只返回存在的条目');
  assert.equal(mixed[0].id, one.id);
});

test('【防回归】所有条目都带 related 字段且为数组（前端 .map 依赖此形状）', () => {
  const bad = kb.search('', { limit: 1000 }).items.filter((e) => !Array.isArray(e.related));
  assert.equal(bad.length, 0, 'related 非数组的条目：' + bad.map((e) => e.id).join(', '));
});

test('【防回归】byIds 返回的条目形状与检索一致（含 categoryLabel，前端直接渲染）', () => {
  const all = kb.search('', { limit: 1000 }).items;
  const withRel = all.find((e) => (e.related || []).length > 0);
  const got = kb.byIds([withRel.related[0]])[0];
  assert.ok(got, '应能取到关联条目');
  // 前端 EntryCard 直接读这两个字段做颜色与标题渲染
  assert.ok(typeof got.categoryLabel === 'string' && got.categoryLabel.length > 0, 'categoryLabel 必须存在');
  assert.ok(typeof got.body === 'string', 'body 必须存在（前端做 slice 截断）');
});
