const test = require('node:test');
const assert = require('node:assert/strict');
const { prune } = require('../server/newsstore.cjs');

const now = Date.parse('2026-09-07T12:00:00.000Z');

test('资讯快照只保留最近72小时且丢弃缺少原文链接的条目', () => {
  const rows = prune([
    { title: '新资讯', media: '新浪财经', url: 'https://finance.sina.com.cn/roll/', publishedAt: '2026-09-07T10:00:00Z' },
    { title: '过期资讯', media: '新浪财经', url: 'https://finance.sina.com.cn/roll/old', publishedAt: '2026-09-03T11:59:59Z' },
    { title: '缺少链接', media: '新浪财经', publishedAt: '2026-09-07T09:00:00Z' },
  ], now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '新资讯');
});

test('资讯快照按来源和链接去重并限制字段长度', () => {
  const rows = prune([
    { title: '同一条', media: '来源', url: 'https://example.com/a', publishedAt: '2026-09-07T10:00:00Z', snippet: 'x'.repeat(500) },
    { title: '后来的同一条', media: '来源', url: 'https://example.com/a', publishedAt: '2026-09-07T11:00:00Z' },
  ], now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '后来的同一条');
  assert.ok(rows[0].id.length <= 500);
});
