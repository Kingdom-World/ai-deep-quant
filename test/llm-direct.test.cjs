// ─────────────────────────────────────────────────────────────
// T2 浏览器直连通道单元测试（L1.2）
//   注入 fetchImpl，不发真实网络请求 —— 测试确定性优先。
//   真实请求的可用性由 CORS 实测（方案书 11.3）覆盖，不放进单测。
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');

import('../shared/llm-direct.mjs').then((mod) => {
  const {
    T2_SYSTEM_PROMPT,
    buildUserMessage,
    callDirect,
    classifyHttpError,
    DIRECT_ERRORS,
  } = mod;

  const CFG = { base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7-flash', key: 'sk-test-abcdef123456' };

  /** 构造一个假 fetch：记录调用参数，返回预设响应 */
  const fakeFetch = (resp, capture) => async (url, init) => {
    if (capture) Object.assign(capture, { url, init });
    return resp;
  };

  const okResp = (content = '分析结论：偏多。依据：MA5 上穿 MA20。') => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }], model: 'glm-4.7-flash' }),
  });

  const errResp = (status) => ({ ok: false, status, json: async () => ({}) });

  // ── 配置缺失 ──

  test('未配置 key：返回 NO_CONFIG 且不发起请求', async () => {
    let called = false;
    const r = await callDirect({ base: CFG.base, model: CFG.model, key: '' }, 'x', {
      fetchImpl: async () => { called = true; },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NO_CONFIG');
    assert.equal(called, false, '配置不全时不得发起任何请求');
  });

  test('缺 model / 缺 base 同样被拦下', async () => {
    for (const bad of [{ key: 'k' }, { key: 'k', model: 'm' }, { key: 'k', base: 'https://x' }]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await callDirect(bad, 'x', { fetchImpl: async () => { throw new Error('不应被调用'); } });
      assert.equal(r.code, 'NO_CONFIG', `配置 ${JSON.stringify(bad)} 应被拦下`);
    }
  });

  // ── 成功路径 ──

  test('成功调用：返回 content、model、tier=byok', async () => {
    const cap = {};
    const r = await callDirect(CFG, '分析一下', { fetchImpl: fakeFetch(okResp(), cap) });
    assert.equal(r.ok, true);
    assert.ok(r.content.includes('偏多'));
    assert.equal(r.model, 'glm-4.7-flash');
    assert.equal(r.tier, 'byok');
    assert.ok(r.elapsedMs >= 0);
  });

  test('请求 URL 与鉴权头正确（Bearer + 拼接 /chat/completions）', async () => {
    const cap = {};
    await callDirect(CFG, 'x', { fetchImpl: fakeFetch(okResp(), cap) });
    assert.equal(cap.url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
    assert.equal(cap.init.method, 'POST');
    assert.equal(cap.init.headers.Authorization, `Bearer ${CFG.key}`);
    const body = JSON.parse(cap.init.body);
    assert.equal(body.model, CFG.model);
    assert.equal(body.stream, false, '必须非流式（浏览器直连的简化前提）');
    assert.equal(body.messages.length, 2, '应含 system + user 两条');
  });

  test('base 末尾斜杠不产生双斜杠', async () => {
    const cap = {};
    await callDirect({ ...CFG, base: 'https://x.com/v1/' }, 'x', { fetchImpl: fakeFetch(okResp(), cap) });
    assert.equal(cap.url, 'https://x.com/v1/chat/completions');
    assert.equal(cap.url.includes('//chat'), false);
  });

  test('system 可被覆盖（角色卡注入）', async () => {
    const cap = {};
    await callDirect(CFG, 'x', { fetchImpl: fakeFetch(okResp(), cap), system: '自定义角色' });
    const body = JSON.parse(cap.init.body);
    assert.equal(body.messages[0].content, '自定义角色');
  });

  test('默认 system 使用 T2 角色卡（含能力边界声明）', async () => {
    const cap = {};
    await callDirect(CFG, 'x', { fetchImpl: fakeFetch(okResp(), cap) });
    const body = JSON.parse(cap.init.body);
    assert.ok(body.system === undefined || body.messages[0].content === T2_SYSTEM_PROMPT);
    assert.ok(body.messages[0].content.includes('单角色模式'), '默认角色卡须声明能力边界');
  });

  // ── HTTP 错误分类 ──

  test('401/403 → UNAUTHORIZED', async () => {
    const r = await callDirect(CFG, 'x', { fetchImpl: fakeFetch(errResp(401)) });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'UNAUTHORIZED');
    assert.equal(r.status, 401);
    assert.ok(r.message.includes('无效或已过期'));
  });

  test('429 → RATE_LIMIT（提示限流而非泛化失败）', async () => {
    const r = await callDirect(CFG, 'x', { fetchImpl: fakeFetch(errResp(429)) });
    assert.equal(r.code, 'RATE_LIMIT');
    assert.ok(r.message.includes('限流'));
  });

  test('404 → NOT_FOUND（提示核对模型名与端点）', async () => {
    const r = await callDirect(CFG, 'x', { fetchImpl: fakeFetch(errResp(404)) });
    assert.equal(r.code, 'NOT_FOUND');
    assert.ok(r.message.includes('模型'));
  });

  test('5xx → SERVER', async () => {
    const r = await callDirect(CFG, 'x', { fetchImpl: fakeFetch(errResp(502)) });
    assert.equal(r.code, 'SERVER');
  });

  test('classifyHttpError 覆盖各档且不误判 4xx 其余码', () => {
    assert.equal(classifyHttpError(401).code, 'UNAUTHORIZED');
    assert.equal(classifyHttpError(403).code, 'UNAUTHORIZED');
    assert.equal(classifyHttpError(429).code, 'RATE_LIMIT');
    assert.equal(classifyHttpError(418).code, 'HTTP_418');
  });

  // ── 响应体异常 ──

  test('200 但 content 为空 → BAD_RESPONSE（不得当成成功）', async () => {
    const r = await callDirect(CFG, 'x', {
      fetchImpl: fakeFetch({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '   ' } }] }) }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BAD_RESPONSE');
  });

  test('200 但结构异常（无 choices）→ BAD_RESPONSE 不崩溃', async () => {
    const r = await callDirect(CFG, 'x', {
      fetchImpl: fakeFetch({ ok: true, status: 200, json: async () => ({ error: 'weird' }) }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BAD_RESPONSE');
  });

  // ── 网络异常与超时 ──

  test('fetch 抛 TypeError（CORS/网络）→ NETWORK 且给出可操作提示', async () => {
    const r = await callDirect(CFG, 'x', {
      fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    });
    assert.equal(r.code, 'NETWORK');
    assert.ok(r.message.includes('CORS'), '应提示可能是 CORS 拦截');
  });

  test('AbortError → TIMEOUT', async () => {
    const r = await callDirect(CFG, 'x', {
      fetchImpl: async () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      },
    });
    assert.equal(r.code, 'TIMEOUT');
    assert.ok(r.message.includes('超时'));
  });

  // ── 消息构造 ──

  test('buildUserMessage：含标的名、数据段、三项任务要求', () => {
    const m = buildUserMessage({ symbol: 'sh600519', name: '贵州茅台', digest: 'MA5=1700, RSI=55' });
    assert.ok(m.user.includes('贵州茅台（sh600519）'));
    assert.ok(m.user.includes('MA5=1700'));
    assert.ok(m.user.includes('结论'));
    assert.ok(m.user.includes('依据'));
    assert.ok(m.user.includes('局限'), '必须要求模型声明局限');
    assert.ok(m.user.includes('规则引擎'), '应声明数据由规则引擎产出（数值不由 LLM 算）');
  });

  test('buildUserMessage：无 digest 时明确写"无可用数据"，不留空', () => {
    const m = buildUserMessage({ symbol: 'sh600519', digest: '' });
    assert.ok(m.user.includes('无可用数据'));
  });

  test('buildUserMessage：仅代码无名称时格式正确', () => {
    const m = buildUserMessage({ symbol: 'sz000001' });
    assert.ok(m.user.includes('sz000001'));
    assert.equal(m.user.includes('（sz000001）'), false, '无名称时不应出现空括号');
  });

  // ── 能力边界文案（与方案书 11.2 同口径）──

  test('T2 角色卡：声明单角色边界、禁止声称做过工具取证', () => {
    assert.ok(T2_SYSTEM_PROMPT.includes('单角色模式'));
    assert.ok(T2_SYSTEM_PROMPT.includes('不做多空辩论'));
    assert.ok(T2_SYSTEM_PROMPT.includes('不调用任何工具'));
    assert.ok(T2_SYSTEM_PROMPT.includes('严禁荐股'), '铁律须与 roles.cjs 同口径');
  });

  test('错误文案齐备：每类都有可操作指引（不留空串）', () => {
    for (const [k, v] of Object.entries(DIRECT_ERRORS)) {
      assert.ok(typeof v === 'string' && v.length > 5, `${k} 的文案过短或缺失`);
    }
  });
});
