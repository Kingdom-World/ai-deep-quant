// ─────────────────────────────────────────────────────────────
// BYOK 全流水线单元测试（2026-10-02 新增）
//   覆盖三件事：
//     1. server/agents/byok.cjs —— 请求级配置校验（base/key/model，防滥用上限）
//     2. server/ai/cloud.cjs overrideTarget —— BYOK 单目标解析（纯函数，不发请求）
//     3. shared/llm-direct.mjs BYOK_ROLES/rolePromptFor —— 单角色视角预设（默认向后兼容）
//   不发起任何网络请求；key 只作为测试夹具字面量，断言其不外泄。
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');

const { normalizeByokOverride } = require('../server/agents/byok.cjs');
const cloudAI = require('../server/ai/cloud.cjs');

test('normalizeByokOverride：合法 zhipu 配置归一化（base 去尾斜杠）', () => {
  const n = normalizeByokOverride({ provider: 'zhipu', base: 'https://open.bigmodel.cn/api/paas/v4/', key: ' k-test-abc ', model: ' glm-5.3-flash ' });
  assert.ok(n, '应判定合法');
  assert.equal(n.provider, 'zhipu');
  assert.equal(n.base, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(n.key, 'k-test-abc');
  assert.equal(n.model, 'glm-5.3-flash');
});

test('normalizeByokOverride：未知 provider 回落 custom', () => {
  const n = normalizeByokOverride({ provider: 'mystery', base: 'https://api.example.com/v1', key: 'k-1', model: 'm-1' });
  assert.ok(n);
  assert.equal(n.provider, 'custom');
});

test('normalizeByokOverride：非法输入一律 null', () => {
  assert.equal(normalizeByokOverride(null), null);
  assert.equal(normalizeByokOverride('x'), null);
  assert.equal(normalizeByokOverride([]), null);
  assert.equal(normalizeByokOverride({ base: 'ftp://x', key: 'k', model: 'm' }), null, '非 http(s) base 拒绝');
  assert.equal(normalizeByokOverride({ base: 'https://x.com', key: '', model: 'm' }), null, '缺 key 拒绝');
  assert.equal(normalizeByokOverride({ base: 'https://x.com', key: 'k', model: '' }), null, '缺 model 拒绝');
  assert.equal(normalizeByokOverride({ base: 'https://x.com', key: 'k'.repeat(300), model: 'm' }), null, '超长 key 拒绝');
  assert.equal(normalizeByokOverride({ base: `https://x.com/${'a'.repeat(300)}`, key: 'k', model: 'm' }), null, '超长 base 拒绝');
});

test('normalizeByokOverride：返回对象只含四个白名单字段（无多余注入面）', () => {
  const n = normalizeByokOverride({ provider: 'zhipu', base: 'https://x.com', key: 'k', model: 'm', evil: 'payload', tier: 'admin' });
  assert.deepEqual(Object.keys(n).sort(), ['base', 'key', 'model', 'provider']);
});

test('overrideTarget：BYOK 单目标解析与字段约束', () => {
  const t = cloudAI.overrideTarget({ provider: 'zhipu', base: 'https://x.com/v1/', key: 'kk', model: 'm-5' }, undefined);
  assert.ok(t);
  assert.equal(t.base, 'https://x.com/v1');
  assert.equal(t.model, 'm-5');
  assert.equal(t.byok, true, '带 byok 标记（冷却表/日志前缀隔离用）');
  assert.equal(t.local, false);
  // model 参数优先于 cfg.model（预留角色级覆盖，当前流水线不传）
  const t2 = cloudAI.overrideTarget({ base: 'https://x.com', key: 'kk', model: 'm-5' }, 'override-model');
  assert.equal(t2.model, 'override-model');
  // 字段缺失一律 null
  assert.equal(cloudAI.overrideTarget(null, undefined), null);
  assert.equal(cloudAI.overrideTarget({ base: '', key: 'k', model: 'm' }, undefined), null);
  assert.equal(cloudAI.overrideTarget({ base: 'https://x.com', key: '', model: 'm' }, undefined), null);
  assert.equal(cloudAI.overrideTarget({ base: 'https://x.com', key: 'k', model: '' }, undefined), null);
});

test('candidateChain：BYOK 覆盖走单目标且不做白名单拦截', () => {
  const chain = cloudAI.candidateChain({ cfgOverride: { provider: 'custom', base: 'https://my-endpoint.example/v1', key: 'kk', model: 'my-private-model' } });
  assert.equal(chain.length, 1, 'BYOK 单目标');
  assert.equal(chain[0].model, 'my-private-model', '白名单外模型放行（用户自担费用）');
  assert.equal(chain[0].byok, true);
  // 非法覆盖 → 空链（chat 将返回 null，由调用方回退）
  assert.equal(cloudAI.candidateChain({ cfgOverride: { base: 'https://x.com' } }).length, 0);
});

import('../shared/llm-direct.mjs').then((mod) => {
  const { T2_SYSTEM_PROMPT, BYOK_ROLES, rolePromptFor, buildUserMessage } = mod;

  test('BYOK_ROLES：五个视角且综合视角为空 focus', () => {
    assert.equal(BYOK_ROLES.length, 5);
    assert.deepEqual(BYOK_ROLES.map((r) => r.id), ['analyst', 'tech', 'fund', 'flow', 'risk']);
    assert.deepEqual(BYOK_ROLES[0].focus, []);
  });

  test('rolePromptFor：综合视角返回默认提示（向后兼容）；专业视角追加侧重段', () => {
    assert.equal(rolePromptFor('analyst'), T2_SYSTEM_PROMPT);
    assert.equal(rolePromptFor('unknown-id'), T2_SYSTEM_PROMPT, '未知名回落默认');
    const tech = rolePromptFor('tech');
    assert.ok(tech.startsWith(T2_SYSTEM_PROMPT), '专业视角必须保留铁律段');
    assert.ok(tech.includes('【本次角色侧重】'), '追加侧重段');
    assert.ok(tech.includes('支撑/阻力'), '侧重内容生效');
  });

  test('buildUserMessage：不传 role 时与旧行为一致（默认提示）', () => {
    const { rolePrompt } = buildUserMessage({ symbol: 'AAPL', name: '苹果', digest: '最新价：1' });
    assert.equal(rolePrompt, T2_SYSTEM_PROMPT);
  });
});
