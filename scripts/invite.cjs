#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// 邀请码管理 CLI（一码一人）
//
//   用法（在项目根目录执行）：
//     node scripts/invite.cjs new "给张三"        生成一张码，备注"给张三"
//     node scripts/invite.cjs new "给李四" 30     同上，但 30 天后过期
//     node scripts/invite.cjs list                查看全部（含谁用了）
//     node scripts/invite.cjs revoke dsh-XXXX-XXXX  吊销某张码
//
//   为什么要这个 CLI：一码一人只有 API 没有界面，管理员得能方便地发码。
//   刻意不引第三方 CLI 库——项目零依赖风格。
// ─────────────────────────────────────────────────────────────
const invites = require('../server/invites.cjs');

const [, , cmd, ...rest] = process.argv;

function usage() {
  console.log(`邀请码管理（一码一人）

  node scripts/invite.cjs new "<备注>" [有效天数]   生成一张新码
  node scripts/invite.cjs list                      列出全部码
  node scripts/invite.cjs revoke <码>               吊销一张码

存储位置：${invites.INVITES_FILE}`);
}

function pad(s, n) {
  // 中文按两格宽计算，避免表格错位
  const w = String(s).replace(/[^\x00-\xff]/g, 'xx').length;
  return String(s) + ' '.repeat(Math.max(0, n - w));
}

async function cmdNew() {
  const [note = '', ttl] = rest;
  const ttlDays = Number(ttl) > 0 ? Number(ttl) : undefined;
  const e = await invites.create({ note, ttlDays });
  console.log('✅ 已生成邀请码（一次性，用后即失效）\n');
  console.log(`   邀请码：${e.code}`);
  if (e.note) console.log(`   备注　：${e.note}`);
  console.log(`   有效至：${e.expiresAt || '不自动过期（可随时吊销）'}`);
  console.log(`\n把「邀请码」发给对方，注册时填入即可。一张码只能注册一个账号。`);
}

async function cmdList() {
  const codes = await invites.list();
  if (!codes.length) {
    console.log('（暂无邀请码。用 node scripts/invite.cjs new "给某某" 生成）');
    return;
  }
  const unused = codes.filter((c) => !c.usedBy && !c.revoked).length;
  console.log(`共 ${codes.length} 张：未用 ${unused} · 已用 ${codes.filter((c) => c.usedBy).length} · 已吊销 ${codes.filter((c) => c.revoked).length}\n`);
  console.log(`${pad('邀请码', 18)}${pad('状态', 10)}${pad('备注', 16)}使用者`);
  console.log('-'.repeat(64));
  for (const c of codes) {
    const now = Date.now();
    const expired = c.expiresAt && Date.parse(c.expiresAt) < now;
    const state = c.revoked ? '已吊销' : c.usedBy ? '已使用' : expired ? '已过期' : '可用';
    console.log(`${pad(c.code, 18)}${pad(state, 10)}${pad(c.note || '-', 16)}${c.usedBy || '-'}${c.usedAt ? ` @ ${c.usedAt.slice(0, 10)}` : ''}`);
  }
}

async function cmdRevoke() {
  const code = (rest[0] || '').trim();
  if (!code) { console.error('请提供要吊销的邀请码'); process.exit(1); }
  const r = await invites.revoke(code);
  if (!r.ok) { console.error(`❌ ${r.error}`); process.exit(1); }
  const used = r.entry.usedBy ? `（注意：它已被 ${r.entry.usedBy} 使用过，吊销不影响该账号）` : '';
  console.log(`✅ 已吊销 ${code}${used}`);
}

(async () => {
  switch (cmd) {
    case 'new': await cmdNew(); break;
    case 'list': await cmdList(); break;
    case 'revoke': await cmdRevoke(); break;
    default: usage(); process.exit(cmd ? 1 : 0);
  }
})().catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
