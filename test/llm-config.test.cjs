// ─────────────────────────────────────────────────────────────
// T2 自配 API 配置层单元测试（L1.1）
//   跨栈模块 shared/llm-config.mjs 的 Node 侧验收。
//   注入内存 store，不依赖浏览器环境。
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');

import('../shared/llm-config.mjs').then((mod) => {
  const {
    normalizeConfig,
    parseStored,
    serializeConfig,
    createConfigStore,
    maskKey,
    PROVIDERS,
    SUGGESTED_MODELS,
    STORAGE_KEY,
    TIER_NOTES,
    supportsVision,
    capabilityBadge,
  } = mod;

  /** 内存存储（模拟 localStorage） */
  const memStore = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      _dump: () => Object.fromEntries(m),
    };
  };

  const VALID = { provider: 'zhipu', model: 'glm-4.7-flash', key: 'sk-test-1234567890abcdef' };

  // ── normalizeConfig：校验与归一化 ──

  test('正常配置：补全 base、判定 ok 与 byok', () => {
    const n = normalizeConfig(VALID);
    assert.equal(n.ok, true);
    assert.equal(n.byok, true);
    assert.equal(n.base, PROVIDERS.zhipu.base, 'base 缺省应回落预设');
    assert.equal(n.provider, 'zhipu');
    assert.deepEqual(n.errors, []);
  });

  test('缺 key / 缺 model 分别报错且 ok=false', () => {
    const noKey = normalizeConfig({ provider: 'zhipu', model: 'glm-4-flash' });
    assert.equal(noKey.ok, false);
    assert.ok(noKey.errors.some((e) => e.includes('API Key')), '应提示缺 Key');

    const noModel = normalizeConfig({ provider: 'zhipu', key: 'sk-x1234567890' });
    assert.equal(noModel.ok, false);
    assert.ok(noModel.errors.some((e) => e.includes('模型名')), '应提示缺模型');
  });

  test('custom 供应商必须自带 base', () => {
    const n = normalizeConfig({ provider: 'custom', model: 'my-model', key: 'sk-abcdef123456' });
    assert.equal(n.ok, false);
    assert.ok(n.errors.some((e) => e.includes('接口地址')), '自定义端点缺 base 应报错');
  });

  test('base 非 http(s) 开头被拒（防止 typo 与危险协议）', () => {
    const n = normalizeConfig({ provider: 'custom', base: 'ftp://x.com/v1', model: 'm', key: 'sk-abcdef123456' });
    assert.equal(n.ok, false);
    assert.ok(n.errors.some((e) => e.includes('http')), '应提示协议要求');
  });

  test('未知 provider 回落 zhipu（不抛错、不产生空 provider）', () => {
    const n = normalizeConfig({ provider: 'not-exist', model: 'glm-4-flash', key: 'sk-abcdef123456' });
    assert.equal(n.provider, 'zhipu');
    assert.equal(n.ok, true);
  });

  test('空白字符串视为缺失（防止 UI 输入空格误判为已填）', () => {
    const n = normalizeConfig({ provider: 'zhipu', model: '   ', key: '  ' });
    assert.equal(n.ok, false);
    assert.equal(n.errors.length >= 2, true);
  });

  test('自定义 base 覆盖预设', () => {
    const n = normalizeConfig({ ...VALID, base: 'https://my-proxy.example.com/v1' });
    assert.equal(n.base, 'https://my-proxy.example.com/v1');
    assert.equal(n.ok, true);
  });

  // ── 序列化 / 反序列化 ──

  test('序列化只含四个字段（不夹带其它信息）', () => {
    const s = serializeConfig({ ...VALID, extra: 'should-not-persist', token: 'x' });
    const o = JSON.parse(s);
    assert.deepEqual(Object.keys(o).sort(), ['base', 'key', 'model', 'provider']);
    assert.equal(o.extra, undefined);
    assert.equal(o.token, undefined);
  });

  test('parseStored：非法 JSON / 空值 / 非对象 均返回 null 不抛', () => {
    assert.equal(parseStored('not-json{{{'), null);
    assert.equal(parseStored(''), null);
    assert.equal(parseStored(null), null);
    assert.equal(parseStored('"a string"'), null);
    assert.equal(parseStored('123'), null);
  });

  test('parseStored：合法 JSON 返回归一化结果', () => {
    const r = parseStored(serializeConfig(VALID));
    assert.ok(r);
    assert.equal(r.ok, true);
    assert.equal(r.model, 'glm-4.7-flash');
  });

  // ── createConfigStore：存取 / 清除 ──

  test('save → load 往返一致', () => {
    const s = memStore();
    const cs = createConfigStore(s);
    assert.equal(cs.save(VALID).ok, true);
    const back = cs.load();
    assert.equal(back.model, 'glm-4.7-flash');
    assert.equal(back.key, VALID.key);
    assert.equal(back.provider, 'zhipu');
  });

  test('save 非法配置被拒，且不写入存储', () => {
    const s = memStore();
    const cs = createConfigStore(s);
    const r = cs.save({ provider: 'zhipu', model: 'glm-4-flash' }); // 缺 key
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
    assert.deepEqual(s._dump(), {}, '非法配置不得落盘');
    assert.equal(cs.load(), null);
  });

  test('clear 后 load 为 null', () => {
    const s = memStore();
    const cs = createConfigStore(s);
    cs.save(VALID);
    assert.ok(cs.load());
    cs.clear();
    assert.equal(cs.load(), null);
    assert.equal(s.getItem(STORAGE_KEY), null);
  });

  test('无存储环境：load 返回 null、save 明确失败（不静默成功）', () => {
    const cs = createConfigStore(null);
    assert.equal(cs.load(), null);
    const r = cs.save(VALID);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('本地存储')), '应明确说明环境不支持');
  });

  test('存储抛异常时不崩溃（隐私模式/配额满）', () => {
    const cs = createConfigStore({
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => { throw new Error('nope'); },
    });
    assert.equal(cs.load(), null, 'getItem 抛错应吞掉返回 null');
    const r = cs.save(VALID);
    assert.equal(r.ok, false, 'setItem 抛错应返回失败而非崩溃');
    cs.clear(); // 不应抛出
  });

  // ── 掩码 ──

  test('maskKey：保留首 6 尾 4，短 key 全掩', () => {
    assert.equal(maskKey('sk-1234567890abcdef'), 'sk-123…cdef');
    assert.equal(maskKey('short'), '****');
    assert.equal(maskKey(''), '');
    assert.equal(maskKey(null), '');
  });

  test('掩码不泄露完整 key（不含中段字符）', () => {
    const key = 'sk-abcdefghijklmnopqrstuvwxyz';
    const m = maskKey(key);
    assert.equal(m.includes('ghijklmnop'), false, '掩码不得含中段明文');
  });

  test('maskedKey()：未配置返回空串，已配置返回掩码', () => {
    const cs = createConfigStore(memStore());
    assert.equal(cs.maskedKey(), '');
    cs.save(VALID);
    const m = cs.maskedKey();
    assert.ok(m.includes('…'));
    assert.equal(m.includes(VALID.key), false, '不得返回完整 key');
  });

  // ── 预设一致性（防止与后端 cloud.cjs 口径分叉） ──

  test('供应商预设与后端 cloud.cjs 同源（base 一致）', () => {
    const cloud = require('../server/ai/cloud.cjs');
    const backendProviders = cloud.PROVIDERS;
    for (const k of ['zhipu', 'siliconflow', 'dashscope']) {
      assert.equal(PROVIDERS[k].base, backendProviders[k].base, `${k} 的 base 必须与后端一致`);
    }
  });

  test('建议模型与后端免费白名单一致（仅作下拉提示，仍需同源）', () => {
    const cloud = require('../server/ai/cloud.cjs');
    const free = cloud.FREE_MODELS;
    for (const k of ['zhipu', 'siliconflow']) {
      assert.deepEqual(
        [...SUGGESTED_MODELS[k]].sort(),
        [...free[k]].sort(),
        `${k} 的建议模型应与后端白名单一致`,
      );
    }
  });

  // ── 档位文案（与方案书 11.4 同口径） ──

  test('三档文案齐备且各自点明关键约束', () => {
    assert.ok(TIER_NOTES.rule.includes('无需任何 API Key'));
    assert.ok(TIER_NOTES.byok.includes('不经过本站服务器'));
    assert.ok(TIER_NOTES.byok.includes('不保存'), 'BYOK 文案必须声明本站不保存 key');
    assert.ok(TIER_NOTES.platform.includes('仅管理员'));
  });

  // ── 能力标注（§12.6 欠账 #4） ──

  test('视觉能力：只认实测/官方的多模态型号（fail closed）', () => {
    // 实测 glm-4.7-flash 不支持（400 / code 1210）——它是默认推荐模型，绝不能误标
    assert.strictEqual(supportsVision('glm-4.7-flash'), false, '默认推荐模型不支持视觉，不得误标');
    assert.strictEqual(supportsVision('glm-4.1v-thinking-flash'), true, '官方多模态系列应识别');
    assert.strictEqual(supportsVision('glm-4.6v-flash'), true);
    // 大小写不敏感
    assert.strictEqual(supportsVision('GLM-4.6V-Flash'), true);
  });

  test('🔴 未知模型一律 false（宁可少标不误标）', () => {
    for (const m of ['unknown-model', 'gpt-4o', '', null, undefined, ' glm-4.7-flash ']) {
      assert.strictEqual(supportsVision(m), false, `未知/不支持应返回 false：${JSON.stringify(m)}`);
    }
    // 前后空格要能归一（避免 ` glm-4.6v-flash` 被误判为未知）
    assert.strictEqual(supportsVision(' glm-4.6v-flash '), true, 'trim 后应识别');
  });

  test('capabilityBadge：仅对支持视觉的模型给出徽标', () => {
    assert.strictEqual(capabilityBadge('glm-4.7-flash'), null, '不支持则不给徽标（不显示不支持）');
    const b = capabilityBadge('glm-4.6v-flash');
    assert.ok(b && b.vision === true);
    assert.ok(b.title.includes('未开放上传图片'), '文案须诚实说明当前无上传入口');
  });
});
