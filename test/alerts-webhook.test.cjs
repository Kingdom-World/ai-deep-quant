// ─────────────────────────────────────────────────────────────
// 告警外发 webhook 单元测试（评审 P1-6）：文案格式 + 渠道报文适配
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const { buildAlertText, buildWebhookPayload } = require('../server/paper/alerts.cjs');

const fired = [
  { name: '贵州茅台', symbol: 'sh600519', condition: 'above', price: 1900, triggeredPrice: 1999 },
  { name: '宁德时代', symbol: 'sz300750', condition: 'below', price: 200, triggeredPrice: 195.5 },
];

test('buildAlertText：人类可读、含阈值方向与现价', () => {
  const text = buildAlertText(fired);
  assert.ok(text.includes('贵州茅台(sh600519) 现价 1999 ≥ 阈值 1900'), text);
  assert.ok(text.includes('宁德时代(sz300750) 现价 195.5 ≤ 阈值 200'), text);
});

test('企业微信/钉钉：msgtype=text 报文', () => {
  for (const url of ['https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x', 'https://oapi.dingtalk.com/robot/send?access_token=y']) {
    const p = buildWebhookPayload(url, 'A 触发');
    assert.equal(p.msgtype, 'text');
    assert.ok(p.text.content.includes('[AI量化平台]'));
    assert.ok(p.text.content.includes('A 触发'));
  }
});

test('Server酱：title/desp 报文', () => {
  const p = buildWebhookPayload('https://sctapi.ftqq.com/SCT123.send', 'A 触发');
  assert.ok(p.title.includes('告警'));
  assert.equal(p.desp, 'A 触发');
  assert.equal(p.msgtype, undefined);
});

test('未知渠道：通用 {text} 报文', () => {
  const p = buildWebhookPayload('https://example.com/hook', 'A 触发');
  assert.ok(p.text.includes('A 触发'));
});
