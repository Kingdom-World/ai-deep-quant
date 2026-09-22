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
const invites = require('./invites.cjs');
const db = require('./db.cjs');

// 认证数据目录。AUTH_DATA_DIR 供测试隔离（与 PAPER_DATA_DIR 同思路）——
//   ⚠️ 抽取时发现：本模块此前**不可隔离**，任何集成测试都会读写真实 data/auth/users.json。
//   这使项目约定「测试必须起隔离实例」对 auth 模块失效，属真实盲区。现补齐。
const DATA_DIR = process.env.AUTH_DATA_DIR || path.join(__dirname, '..', 'data', 'auth');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const COOKIE_NAME = 'pq_session';
const SECURE_COOKIE = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
const COOKIE_SECURITY = SECURE_COOKIE ? '; Secure' : '';

let users = { users: [] }; // [{username, uid, salt, hash, createdAt}]
let sessionSecret = '';
// 存储是否真的可写。只读文件系统（Vercel Serverless）上为 false。
//   🔴 为什么必须显式记录：此前 `persist()` 失败会被上层 catch 吞掉，
//   表现为「注册接口返回成功、账号却只存在于本实例内存」——
//   换一个实例即登录失败。这违反项目铁律 #4「禁止静默降级」：
//   用户会误以为注册好了，实际什么都没留下。
let persistent = false;

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
    // 写探针：mkdir 成功不代表可写（只读挂载下 mkdir 也可能"成功"或已被绕过）
    const probe = path.join(DATA_DIR, '.write-probe');
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
    persistent = true;
  } catch (e) {
    // 只读文件系统（如 Vercel Serverless）降级：会话仅存内存，进程重启后需重新登录
    persistent = false;
    console.warn('[认证] 存储不可写，降级为内存态（新注册的账号不会被保存）:', e.message);
    if (!sessionSecret) sessionSecret = crypto.randomBytes(32).toString('hex');
  }
}

/** 存储是否可写（含数据库后端）。
 *  ⚠️ 语义：只要"账号能被保存"即为 true —— 文件可写 **或** 配置了数据库。
 *  注册接口据此判断能否落盘；**数据库可用时不应再被 503 拒绝**（2026-09-21 接线）。
 *  （纯只读 FS 且无数据库时仍为 false，注册会显式失败，不假装成功。） */
function isPersistent() {
  return persistent || db.hasDb();
}

/** 幂等初始化数据库（迁移建表）。所有涉及存储的异步操作都应先 await 它 ——
 *  Serverless 下请求可能早于启动逻辑，不能依赖"启动时恰好跑完"。 */
let dbReady = null;
function ready() {
  if (!db.hasDb()) return Promise.resolve(false);
  if (!dbReady) {
    dbReady = db.ready().catch((e) => {
      dbReady = null; // 允许后续请求重试，而不是永久卡死
      throw e;
    });
  }
  return dbReady;
}

/** （仅 file 后端）写入用户表；数据库后端不走这里 */
function persist() {
  if (!persistent) {
    // 显式失败优于静默丢数据（铁律 #4）
    throw new Error('本部署的存储不可写（只读文件系统），账号无法持久化');
  }
  writeJsonAtomic(USERS_FILE, users, true);
}

/** 注册成功返回用户对象；失败抛 Error(message)
 *  opts.memoryOnly=true 时跳过落盘（只读 FS 上的**引导管理员**专用：
 *  该账号由环境变量每次冷启动重建、各实例一致，本就不需要持久化） */
async function createUser(username, password, opts = {}) {
  username = String(username || '').trim();
  if (!validateUsername(username)) throw new Error('用户名需为 2-20 位中英文/数字/下划线');
  if (!validatePassword(password)) throw new Error('密码长度需为 6-64 位');

  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    username,
    // stableUid：uid 由用户名**确定性派生**而非随机 ——
    //   供环境变量引导的管理员在无状态托管环境里跨实例保持同一 uid，
    //   否则模拟盘等按 uid 分账的数据会在每次冷启动后"换主人"。
    uid: opts.stableUid
      ? 'u' + crypto.createHash('sha256').update(`stable:${username}`).digest('hex').slice(0, 20)
      : crypto.randomUUID(),
    salt,
    hash: hashPassword(password, salt),
    createdAt: new Date().toISOString(),
  };

  // ── 数据库后端：唯一约束在**数据库层**保证用户名不重复（无"先查后插"的竞态窗口）──
  if (db.hasDb()) {
    await ready();
    try {
      await db.query(`INSERT INTO app_users (username, uid, salt, hash) VALUES ($1, $2, $3, $4)`, [
        user.username,
        user.uid,
        user.salt,
        user.hash,
      ]);
    } catch (e) {
      if (e.code === '23505') throw new Error('用户名已被注册'); // unique_violation
      throw e;
    }
    users.users.push(user); // 同步进内存：同实例后续校验无需再查库
    return { username: user.username, uid: user.uid };
  }

  // ── file 后端 ──
  if (users.users.some((u) => u.username === username)) throw new Error('用户名已被注册');
  users.users.push(user);
  if (opts.memoryOnly) {
    // 显式告知，不静默：该账号不进磁盘，靠环境变量在每次冷启动重建
    console.warn('[认证] 存储不可写 → 引导管理员仅创建于内存（每次冷启动重建，各实例一致）');
  } else {
    persist();
  }
  return { username: user.username, uid: user.uid };
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

/** 同步版校验：**只查内存表**。仅用于 Basic 认证分支 ——
 *  它是同步中间件路径，不能 await。⚠️ 线上冷启动后内存表为空，
 *  故 Basic 认证在线上可能失败；线上请使用 Cookie/Bearer 会话令牌。 */
function verifyUserSync(username, password) {
  const u = users.users.find((x) => x.username === String(username || '').trim());
  if (!u) return null;
  const ok = safeEqual(hashPassword(password, u.salt), u.hash);
  return ok ? { username: u.username, uid: u.uid } : null;
}

/** 校验账号密码：**内存优先，未命中再查数据库**。成功返回 {username, uid}，失败返回 null */
async function verifyUser(username, password) {
  const name = String(username || '').trim();
  let u = users.users.find((x) => x.username === name);
  if (!u && db.hasDb()) {
    await ready();
    const r = await db.query(`SELECT username, uid, salt, hash FROM app_users WHERE username = $1`, [name]);
    if (r.rows[0]) {
      u = r.rows[0];
      users.users.push(u); // 缓存进内存，后续同实例校验不再查库
    }
  }
  if (!u) return null;
  const ok = safeEqual(hashPassword(password, u.salt), u.hash);
  return ok ? { username: u.username, uid: u.uid } : null;
}

/** 修改密码：验证旧密码 → 生成新盐和哈希 → 更新内存与用户表（uid 不变，模拟盘等数据全保留） */
async function changePassword(username, oldPassword, newPassword) {
  const name = String(username || '').trim();
  let u = users.users.find((x) => x.username === name);
  if (!u && db.hasDb()) {
    await ready();
    const r = await db.query(`SELECT username, uid, salt, hash FROM app_users WHERE username = $1`, [name]);
    u = r.rows[0];
  }
  if (!u) throw new Error('用户不存在');
  if (!safeEqual(hashPassword(oldPassword, u.salt), u.hash)) throw new Error('旧密码不正确');
  if (!validatePassword(newPassword)) throw new Error('新密码长度需为 6-64 位');
  if (safeEqual(hashPassword(newPassword, u.salt), u.hash)) throw new Error('新密码不能与旧密码相同');

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(newPassword, salt);
  u.salt = salt;
  u.hash = hash;
  u.passwordChangedAt = new Date().toISOString();

  if (db.hasDb()) {
    await db.query(`UPDATE app_users SET salt = $1, hash = $2 WHERE username = $3`, [salt, hash, name]);
  } else {
    persist();
  }
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
      // 用**同步**版（只查内存表）：本函数是同步中间件路径，不能 await
      return verifyUserSync(username, password);
    } catch {
      return null;
    }
  }
  return null;
}

/** 首次启动引导：用户表为空时，用 .env 的站点账号创建管理员（保证运维脚本可用）
 *  ⚠️ 只读 FS（Vercel）且无数据库时走 memoryOnly：账号由环境变量在**每次冷启动重建**，
 *     因此各实例一致、登录稳定 —— 这是"没有数据库也能用自己的账号登录"的原因。
 *  有数据库时：先查库里是否已有账号，**有就不再造**（避免覆盖用户自己注册的同名账号）。 */
async function ensureBootstrapAdmin(username, password) {
  if (users.users.length > 0) return false;
  if (!username || !password) return false;
  try {
    if (db.hasDb()) {
      await ready();
      const r = await db.query(`SELECT count(*)::int AS n FROM app_users`);
      if (r.rows[0]?.n > 0) {
        console.log('👤 [认证] 数据库中已有账号，跳过引导管理员创建');
        return false;
      }
    }
    // stableUid：引导管理员（环境变量派生）的 uid 必须跨实例稳定，
    // 否则模拟盘等按 uid 分账的数据会在冷启动后"换主人"
    await createUser(username, password, { memoryOnly: !persistent, stableUid: true });
    console.log(
      `👤 [认证] 已创建引导管理员: ${username}` +
        (isPersistent() ? '' : '（内存态：只读 FS，每次冷启动按环境变量重建）'),
    );
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
  // 后端是否启用了鉴权（由 index.cjs 传入）。必须外露给前端：
  //   2026-09-21 线上实测的死锁 —— Vercel 上未配 SITE_PASSWORD ⇒ AUTH_ENABLED=false
  //   ⇒ 后端 /api/* 全开、且**没有也不会创建任何账号**；但前端 App.tsx 只看 `ok`
  //   就判定"未登录"，于是整站被挡在登录页后、而登录**永远不可能成功**。
  //   外露本字段后，前端得知"本部署不需要登录"即可正常进入。
  const authEnabled = opts.authEnabled !== false;
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

  r.post('/register', async (req, res) => {
    // 🔴 存储不可写时**明确拒绝**，而不是让注册"成功"后再蒸发（铁律 #4）。
    //    ⚠️ 配了数据库时 isPersistent() 为 true —— 线上正是靠它才允许注册。
    if (!isPersistent()) {
      return res.status(503).json({
        ok: false,
        error: '本部署的存储不可写（只读文件系统）且未配置数据库，注册暂不可用。请联系站点管理员。',
      });
    }
    let claimedCode = null;
    try {
      const { username, password, invite } = req.body || {};
      // 邀请码两种模式：
      //   · 一码一人（invites.enabled()）—— 优先；码在数据库或 data/auth/invites.json
      //   · 共享码（.env 的 INVITE_CODE）—— 未启用一码一人时回落，保持向后兼容
      const oneByOne = await invites.enabled();
      if (oneByOne) {
        // 先占码、后建号。占码是**单条原子 UPDATE**（数据库行锁），天然免疫并发 ——
        // 这比原来"先 check 再 consume 且中间不许 await"的做法可靠得多。
        // 代价是要处理回滚：若建号失败，必须把码归还，不能白烧一张。
        const c = await invites.claim(invite, username);
        if (!c.ok) return res.status(403).json({ ok: false, error: c.error });
        claimedCode = c.entry.code;
      } else if (inviteCode() && String(invite || '').trim() !== inviteCode()) {
        return res.status(403).json({ ok: false, error: '邀请码不正确，请向站点管理员索取' });
      }

      const user = await createUser(username, password);

      const token = issueSession(user);
      res.setHeader('Set-Cookie', sessionCookie(token));
      res.json({ ok: true, username: user.username, token });
    } catch (e) {
      // 建号失败（重名等）→ 归还已占用的邀请码，否则这张码就废了
      if (claimedCode) {
        try {
          const rb = await invites.release(claimedCode, String((req.body || {}).username || ''));
          console.warn(`🎫 [邀请码] 注册失败，已归还 ${claimedCode}（${rb.ok ? '成功' : rb.error}）`);
        } catch (e2) {
          console.error(`🎫 [邀请码] 归还 ${claimedCode} 失败: ${e2.message}`);
        }
      }
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  r.post('/login', loginGate, async (req, res) => {
    const { username, password } = req.body || {};
    const user = await verifyUser(username, password);
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
    // `persistent` 外露给运维/自查：为 false 时说明本部署注册不可用。
    // 用 isPersistent() 而非文件可写性 —— **配了数据库即为 true**（2026-09-21）。
    // 属于"显式降级"信号，不是错误——前端/运维据此提示，而不是静默失败。
    if (!user) return res.json({ ok: false, username: null, isAdmin: false, authEnabled, persistent: isPersistent() });
    res.json({
      ok: true,
      username: user.username,
      uid: user.uid,
      isAdmin: !!adminName && user.username === adminName,
      authEnabled,
      persistent: isPersistent(),
    });
  });

  // ── 邀请码管理（仅管理员；一码一人模式）──────────────────────
  //   为何放在 /api/auth 下：本路由段在鉴权中间件之前挂载（注册/登录必须免鉴权），
  //   故这里**自行校验管理员身份**。管理员判定与会话一致 =
  //   用户名等于 .env 的 SITE_USERNAME（见 adminName）。
  //   ⚠️ 非管理员一律 403，且错误信息不透露"是否存在邀请码"这类信息。
  const requireAdmin = (req, res) => {
    const user = getUserFromRequest(req);
    if (!user || !adminName || user.username !== adminName) {
      res.status(403).json({ ok: false, error: '仅管理员可管理邀请码' });
      return null;
    }
    return user;
  };

  r.get('/invites', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const codes = await invites.list();
    res.json({
      ok: true,
      enabled: await invites.enabled(),
      codes,
      // 汇总便于管理员一眼看清配额使用情况
      summary: {
        total: codes.length,
        unused: codes.filter((c) => !c.usedBy && !c.revoked).length,
        used: codes.filter((c) => c.usedBy).length,
        revoked: codes.filter((c) => c.revoked).length,
      },
    });
  });

  r.post('/invites', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { note, ttlDays } = req.body || {};
      const ttl = Number(ttlDays) > 0 ? Number(ttlDays) : undefined;
      const entry = await invites.create({ note, ttlDays: ttl });
      res.json({ ok: true, entry });
    } catch (e) {
      res.status(500).json({ ok: false, error: `生成失败：${e.message}` });
    }
  });

  r.post('/invites/revoke', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { code } = req.body || {};
    const r2 = await invites.revoke(String(code || '').trim());
    res.status(r2.ok ? 200 : 404).json(r2);
  });

  // 改密接口：/api/auth/* 不走鉴权中间件，这里自行校验登录态
  r.post('/change-password', async (req, res) => {
    const user = getUserFromRequest(req);
    if (!user) return res.status(401).json({ ok: false, error: '未登录或会话已过期，请重新登录' });
    const { oldPassword, newPassword } = req.body || {};
    try {
      const updated = await changePassword(user.username, oldPassword, newPassword);
      res.json({ ok: true, username: updated.username });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  return r;
}

module.exports = {
  init,
  ready,
  createUser,
  verifyUser,
  verifyUserSync,
  changePassword,
  ensureBootstrapAdmin,
  middleware,
  router,
  getUserFromRequest,
  isPersistent,
  hasDb: () => db.hasDb(),
};
