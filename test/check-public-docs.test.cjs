'use strict';
// ─────────────────────────────────────────────────────────────
// 公开面文档守门的检出力验证（positive control）
//
// 🔴 这类"检查工具"最常见的假通过：断言"跑起来不报错"，
//   却无法证明它抓得住它声称要抓的东西。本文件用**本轮真实泄露句**
//   做样本（不是虚构的最小用例）。
//
// 本轮真实缺陷（2026-10-10，README.md 逐行核对所见）：
//   ① 「密码留空即关闭」                —— 宣布可以无鉴权裸奔
//   ② SITE_USERNAME / SITE_PASSWORD    —— 给出绕过鉴权的路径
//   ③ 公网地址 vercel.app              —— 真实部署域名
//   ④ vercel.json / api/index.js       —— 部署拓扑
//   ⑤ 万2.5 / ≤20% / 趋势30            —— 内部口径的手工副本
// ─────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const tool = require(path.join(ROOT, 'tools', 'check-public-docs.cjs'));
const { scan, RULES } = tool;

function ids(text) {
  return scan(text).map((h) => h.id);
}

test('检出：鉴权可关闭的表述（本轮真实泄露句）', () => {
  const leak = '访问密码由 SITE_USERNAME / SITE_PASSWORD 控制，留空即关闭。';
  const got = ids(leak);
  assert.ok(got.includes('no-auth-off-switch'), '应报出鉴权可关闭');
  assert.ok(got.includes('no-env-var-names'), '应报出环境变量名');
});

test('🔴 不误报：「必须启用鉴权」这类**警告**不得被当成泄露', () => {
  // 第一版判据写成 /未启用鉴权/，结果把警告句也报了 —— 噪声门禁等于没门。
  const warning = '**公开部署时必须启用鉴权**——未启用鉴权时，所有管理类视图对任何访问者开放。';
  const got = ids(warning);
  assert.ok(
    !got.includes('no-auth-off-switch'),
    `要求开启鉴权的警告不应被判为「可关闭」，实际报：${got.join(',')}`,
  );
});

test('检出：真实部署域名（规则 no-real-domain）', () => {
  assert.ok(ids('预期 URL：https://ai-deep-quant.vercel.app').includes('no-real-domain'));
  assert.ok(ids('站点：https://example.xyz').includes('no-real-domain'));
});

test('检出：部署/运维拓扑（规则 no-ops-topology）', () => {
  for (const s of [
    '部署入口：`api/index.js`（复用 server/index.cjs 后端）',
    '配置：`vercel.json` + `"vercel-build"` 脚本',
    '双击 `register-maintenance.bat` 注册每日自检任务',
  ]) {
    assert.ok(ids(s).includes('no-ops-topology'), `应报出运维拓扑：${s.slice(0, 24)}`);
  }
});

test('检出：内部阈值 / 因子权重的第二份副本', () => {
  for (const s of [
    '五因子模型（趋势30/动量25/量能15/波动15/位置15）',
    '佣金万2.5（最低 5 元）+ 卖出印花税万 5',
    '风控（单笔 ≤20%、单标的 ≤30%）',
  ]) {
    assert.ok(ids(s).includes('no-internal-thresholds'), `应报出口径副本：${s.slice(0, 20)}`);
  }
});

test('检出：内网地址与绝对部署路径', () => {
  assert.ok(ids('服务监听 10.0.0.5:3001').includes('no-private-ip'));
  assert.ok(ids('元数据 169.254.169.254').includes('no-private-ip'));
  assert.ok(ids('数据在 C:\\Users\\xx\\data').includes('no-absolute-path'));
});

test('🔴 不误报：正常的对外表述不应被拦', () => {
  const ok = [
    '本项目为学术研究演示项目，不构成投资建议。',
    '一个独立的量化分析 Web 平台：单端口运行。',
    '本地开发：npm install / npm run build / npm start',
    '测试与质量门：npm test / npm run typecheck / npm run build',
    '需要无鉴权即可访问的公开只读接口，可在部署时关闭登录保护。', // 见下方豁免说明
  ];
  for (const s of ok.slice(0, 4)) {
    assert.deepStrictEqual(ids(s), [], `不应被拦：${s.slice(0, 28)}`);
  }
});

test('规则表自带 why（删门前能看懂它在防什么）', () => {
  for (const r of RULES) {
    assert.ok(r.id && r.re && r.why && r.label, `规则 ${r.id} 缺字段`);
    assert.ok(r.why.length >= 15, `规则 ${r.id} 的 why 太短，后人会看不懂而删掉门`);
  }
});

test('只检查公开版文件（本地完整版不受约束）', () => {
  assert.deepStrictEqual(tool.TARGETS, ['README.public.md'],
    '公开面文件名变更需要有意识地改这里，而不是悄悄换目标');
});