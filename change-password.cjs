#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// 命令行改密工具：node change-password.cjs <用户名> <新密码>
//   · 与 server/auth.cjs 完全一致的加盐 scrypt 算法，改完即可用新密码登录
//   · ⚠️ 必须先停止网站服务再执行：服务把用户表缓存在内存里，
//     运行中改文件不但不生效，服务下次保存时还会把内存里的旧数据覆盖回去
//   · 只更新目标用户的 salt/hash，uid、模拟盘数据、其他账号均不受影响
// ─────────────────────────────────────────────────────────────
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./server/atomic-write.cjs');

const USERS_FILE = path.join(__dirname, 'data', 'auth', 'users.json');
const PORT = process.env.PORT || 3001;

/** 与 server/auth.cjs 的 hashPassword 保持一致（scryptSync 64 字节 hex） */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

async function serviceRunning() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const [username, password] = process.argv.slice(2);
  if (!username || !password) {
    console.log('用法: node change-password.cjs <用户名> <新密码>');
    console.log('示例: node change-password.cjs admin MyNewPass2026');
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/.test(username.trim())) {
    console.error('✗ 用户名需为 2-20 位中英文/数字/下划线');
    process.exit(1);
  }
  if (password.length < 6 || password.length > 64) {
    console.error('✗ 密码长度需为 6-64 位');
    process.exit(1);
  }
  if (await serviceRunning()) {
    console.error(`✗ 检测到网站服务正在运行（端口 ${PORT}）。请先停止服务再改密码：`);
    console.error('  · 关闭服务窗口，或在任务管理器结束 node.exe 进程');
    console.error('  · 改完密码后再重新启动服务');
    process.exit(1);
  }
  if (!fs.existsSync(USERS_FILE)) {
    console.error('✗ 未找到用户表 data/auth/users.json');
    process.exit(1);
  }
  let db;
  try {
    db = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (!Array.isArray(db.users)) throw new Error('格式错误');
  } catch {
    console.error('✗ 用户表损坏或格式不对，未做任何修改');
    process.exit(1);
  }
  const user = db.users.find((x) => x.username === username.trim());
  if (!user) {
    console.error(`✗ 用户「${username}」不存在。现有账号: ${db.users.map((x) => x.username).join('、') || '（空）'}`);
    process.exit(1);
  }
  const salt = crypto.randomBytes(16).toString('hex');
  user.salt = salt;
  user.hash = hashPassword(password, salt);
  user.passwordChangedAt = new Date().toISOString();
  if (writeJsonAtomic(USERS_FILE, db, true)) {
    console.log(`✓ 用户「${user.username}」密码已更新，启动服务后即可用新密码登录。`);
    console.log('  uid 未变：该账号的模拟盘数据、收藏、报告全部保留。');
  } else {
    console.error('✗ 写入失败，用户表未改动');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('✗ 执行失败:', e.message);
  process.exit(1);
});
