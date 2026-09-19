// ─────────────────────────────────────────────────────────────
// 用户认证系统：注册 / 登录 / 会话管理（零第三方依赖）
//   · 密码哈希：node:crypto scrypt（随机盐，恒定时间比较）
//   · 会话：HMAC-SHA256 签名令牌，HttpOnly Cookie（7 天），兼容 Bearer / Basic
//   · 持久化：data/auth/users.json 原子写入；签名密钥 data/auth/secret.key
//   · 首次启动引导：若用户表为空，用 .env 的 SITE_USERNAME/SITE_PASSWORD 创建管理员
//   · 注册门禁：.env 配置 INVITE_CODE 后注册需填邀请码（未配置=开放注册，本地自用时免填）
//   · 登录限速：每 IP 每分钟 8 次失败即锁 10 分钟（防暴力破解，与全局限流独立）
// ─────────────────────────────────────────────────────────────
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic-write.cjs');

const DATA_DIR = path.join(__dirname, '..', 'data', 'auth');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const COOKIE_NAME = 'pq_session';
const SECURE_COOKIE = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
const COOKIE_SECURITY = SECURE_COOKIE ? '; Secure' : '';

let users = { users: [] }; // [{username, uid, salt, hash, createdAt}]
let sessionSecret = '';

function init() {
  try {
    const configuredSecret = String(process.env.SESSION_SECRET || '').trim();
    if (configuredSecret) sessionSecret = configuredSecret;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!sessionSecret && fs.existsSync(SECRET_FILE)) {
      sessionSecret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    } else if (!sessionSecret) {
      sessionSecret = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(SECRET_FILE, sessionSecret, { mode: 0o600 });
    }
    if (fs.existsSync(USERS_FILE)) {
      try {
        users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        if (!Array.isArray(users.users)) users = { users: [] };
      } catch {
        users = { users: [] };
      }
    }
  } catch (e) {
    // 只读文件系统（如 Vercel Serverless）降级：会话仅存内存，进程重启后需重新登录
    console.warn('[认证] 持久化不可用，降级为内存会话:', e.message);
    if (!sessionSecret) sessionSecret = crypto.randomBytes(32).toString('hex');
  }
}

/** 原子写入（临时文件 + rename，含 Windows EPERM 重试），防止写入中途崩溃损坏用户表 */
function persist() {
  writeJsonAtomic(USERS_FILE, users, true);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** 用户名：2-20 位，中英文/数字/下划线 */
function validateUsername(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/.test(u.trim());
}
/** 密码：6-64 位 */
function validatePassword(p) {
  return typeof p === 'string' && p.length >= 6 && p.length <= 64;
}

/** 注册成功返回用户对象；失败抛 Error(message) */
function createUser(username, password) {
  username = String(username || '').trim();
  if (!validateUsername(username)) throw new Error('用户名需为 2-20 位中英文/数字/下划线');
  if (!validatePassword(password)) throw new Error('密码长度需为 6-64 位');
  if (users.users.some((u) => u.username === username)) throw new Error('用户名已被注册');
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    username,
    uid: crypto.randomUUID(),
    salt,
    hash: hashPassword(password, salt),
    createdAt: new Date().toISOString(),
  };
  users.users.push(user);
  persist();
  return { username: user.username, uid: user.uid };
}

/** 校验账号密码，成功返回 {username, uid}，失败返回 null */
function verifyUser(username, password) {
  const u = users.users.find((x) => x.username === String(username || '').trim());
  if (!u) return null;
  const ok = safeEqual(hashPassword(password, u.salt), u.hash);
  return ok ? { username: u.username, uid: u.uid } : null;
}

/** 修改密码：验证旧密码 → 生成新盐和哈希 → 更新内存与用户表（uid 不变，模拟盘等数据全保留） */
function changePassword(username, oldPassword, newPassword) {
  const u = users.users.find((x) => x.username === String(username || '').trim());
  if (!u) throw new Error('用户不存在');
  if (!safeEqual(hashPassword(oldPassword, u.salt), u.hash)) throw new Error('旧密码不正确');
  if (!validatePassword(newPassword)) throw new Error('新密码长度需为 6-64 位');
  if (safeEqual(hashPassword(newPassword, u.salt), u.hash)) throw new Error('新密码不能与旧密码相同');
  u.salt = crypto.randomBytes(16).toString('hex');
  u.hash = hashPassword(newPassword, u.salt);
  u.passwordChangedAt = new Date().toISOString();
  persist();
  return { username: u.username, uid: u.uid };
}

// ───────────── 会话令牌：base64url(payload).hmac ─────────────
function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function signToken(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', sessionSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', sessionSecret).update(body).digest('base64url');
  if (!safeEqual(sig, expect)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload.uid !== 'string') return null;
    if (Date.now() > payload.exp) return null; // 过期
    return payload;
  } catch {
    return null;
  }
}

function issueSession(user) {
  return signToken({ u: user.username, uid: user.uid, exp: Date.now() + SESSION_TTL_MS });
}

function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax${COOKIE_SECURITY}`;
}
const CLEAR_COOKIE = `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${COOKIE_SECURITY}`;

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * 从请求中解析用户身份，优先级：Cookie 会话 > Bearer 令牌 > Basic（对照用户表，
 * 兼容 vite 开发代理与运维冒烟脚本）。未登录返回 null。
 */
function getUserFromRequest(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token) {
    const p = verifyToken(token);
    if (p) return { username: p.u, uid: p.uid };
  }
  const authz = String(req.headers.authorization || '');
  const bearer = authz.match(/^Bearer (.+)$/i);
  if (bearer) {
    const p = verifyToken(bearer[1]);
    if (p) return { username: p.u, uid: p.uid };
  }
  const basic = authz.match(/^Basic (.+)$/i);
  if (basic) {
    try {
      const [username, password] = Buffer.from(basic[1], 'base64').toString('utf8').split(/:(.*)/s);
      return verifyUser(username, password);
    } catch {
      return null;
    }
  }
  return null;
}

/** 首次启动引导：用户表为空时，用 .env 的站点账号创建管理员（保证运维脚本可用） */
function ensureBootstrapAdmin(username, password) {
  if (users.users.length > 0) return false;
  if (!username || !password) return false;
  try {
    createUser(username, password);
    console.log(`👤 [认证] 已创建引导管理员: ${username}（请尽快在网站内注册个人账号）`);
    return true;
  } catch (e) {
    console.warn(`👤 [认证] 引导管理员创建失败: ${e.message}`);
    return false;
  }
}

/** Express 中间件：保护 /api/*（放行 /api/auth/* 与 /api/health），附加 req.user */
function middleware() {
  return (req, res, next) => {
    const p = req.path || '';
    if (p.startsWith('/api/auth/') || p === '/api/health') return next();
    const user = getUserFromRequest(req);
    if (user) {
      req.user = user;
      return next();
    }
    // 不返回 WWW-Authenticate（避免浏览器原生弹窗），由前端登录页接管
    return res.status(401).json({ error: '未登录或会话已过期，请重新登录' });
  };
}

/** /api/auth 路由：register / login / logout / me */
function router(opts = {}) {
  const express = require('express');
  const r = express.Router();
  const adminName = opts.adminUsername || '';
  // 邀请码每次请求实时读取：改 .env 免重启即生效
  const inviteCode = () => (process.env.INVITE_CODE || '').trim();

  // 登录失败限速：每 IP 每分钟最多 8 次失败，超限锁 10 分钟
  const loginFails = new Map(); // ip -> { count, windowStart, lockedUntil }
  const loginGate = (req, res, next) => {
    const ip = req.ip || 'unknown';
    const rec = loginFails.get(ip);
    if (rec?.lockedUntil && Date.now() < rec.lockedUntil) {
      const mins = Math.ceil((rec.lockedUntil - Date.now()) / 60000);
      return res.status(429).json({ ok: false, error: `登录失败次数过多，已临时锁定，请 ${mins} 分钟后再试` });
    }
    next();
  };
  const recordLoginFail = (req) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    // 容量保护：失败表按 IP 累积且从不清理，公网被扫描时会长期驻留内存
    if (loginFails.size > 1000) {
      for (const [k, v] of loginFails) {
        if ((!v.lockedUntil || v.lockedUntil < now) && now - (v.windowStart || 0) > 10 * 60_000) loginFails.delete(k);
      }
    }
    const rec = loginFails.get(ip);
    if (!rec || now - rec.windowStart > 60_000) loginFails.set(ip, { count: 1, windowStart: now, lockedUntil: 0 });
    else {
      rec.count += 1;
      if (rec.count >= 8) rec.lockedUntil = now + 10 * 60_000;
    }
  };

  r.post('/register', (req, res) => {
    try {
      const { username, password, invite } = req.body || {};
      if (inviteCode() && String(invite || '').trim() !== inviteCode()) {
        return res.status(403).json({ ok: false, error: '邀请码不正确，请向站点管理员索取' });
      }
      const user = createUser(username, password);
      const token = issueSession(user);
      res.setHeader('Set-Cookie', sessionCookie(token));
      res.json({ ok: true, username: user.username, token });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  r.post('/login', loginGate, (req, res) => {
    const { username, password } = req.body || {};
    const user = verifyUser(username, password);
    if (!user) {
      recordLoginFail(req);
      return res.status(200).json({ ok: false, error: '用户名或密码错误' });
    }
    loginFails.delete(req.ip || 'unknown'); // 登录成功清零失败计数
    const token = issueSession(user);
    res.setHeader('Set-Cookie', sessionCookie(token));
    res.json({ ok: true, username: user.username, token });
  });

  r.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', CLEAR_COOKIE);
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    const user = getUserFromRequest(req);
    if (!user) return res.json({ ok: false, username: null, isAdmin: false });
    res.json({ ok: true, username: user.username, uid: user.uid, isAdmin: !!adminName && user.username === adminName });
  });

  // 改密接口：/api/auth/* 不走鉴权中间件，这里自行校验登录态
  r.post('/change-password', (req, res) => {
    const user = getUserFromRequest(req);
    if (!user) return res.status(401).json({ ok: false, error: '未登录或会话已过期，请重新登录' });
    const { oldPassword, newPassword } = req.body || {};
    try {
      const updated = changePassword(user.username, oldPassword, newPassword);
      res.json({ ok: true, username: updated.username });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  return r;
}

module.exports = { init, createUser, verifyUser, changePassword, ensureBootstrapAdmin, middleware, router, getUserFromRequest };
