// ─────────────────────────────────────────────────────────────
// 可写存储抽象（Postgres / Neon）
//
//   为什么需要它：Vercel 的函数文件系统是**只读**的，`data/*.json` 写不进去。
//   于是"注册账号"这类写操作在线上要么失败、要么只活在单个实例的内存里 ——
//   用户以为注册成功了，换个请求就查无此人。
//
//   启用条件（重要）：**只有检测到连接串时才启用数据库**。
//   本地开发与测试环境没有这些变量 ⇒ 自动回落原来的文件存储，行为完全不变。
//   连接的变量名按 Vercel + Neon 集成注入的实际名字取值（2026-09-21 实测）：
//     DATABASE_URL（连接池版，应用用它）/ POSTGRES_URL / DATABASE_URL_UNPOOLED（直连）
//
//   ⚠️ 不要在代码里打印连接串 —— 它含密码，且明确标记为 Sensitive。
// ─────────────────────────────────────────────────────────────
const CONN_KEYS = ['DATABASE_URL', 'POSTGRES_URL', 'DATABASE_URL_UNPOOLED'];

function connString() {
  for (const k of CONN_KEYS) {
    const v = String(process.env[k] || '').trim();
    if (v) return { url: v, key: k };
  }
  return null;
}

/** 是否配置了数据库（决定整个认证子系统走 SQL 还是走文件） */
function hasDb() {
  return Boolean(connString());
}

let pool = null;
let booting = null;
let lastError = null;

function makePool(url) {
  // pg 会解析连接串里的 sslmode；只有当 URL 未显式指定时才补默认 SSL，
  // 避免与 Neon 自带参数冲突。
  const opts = {
    connectionString: url,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
  };
  if (!/sslmode=/i.test(url)) opts.ssl = { rejectUnauthorized: false };
  // eslint-disable-next-line global-require
  const { Pool } = require('pg');
  return new Pool(opts);
}

/** 建表（幂等）。用唯一约束在数据库层保证"用户名不重复"与"一码一人"。 */
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      username   text PRIMARY KEY,
      uid        text NOT NULL,
      salt       text NOT NULL,
      hash       text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invite_codes (
      code       text PRIMARY KEY,
      note       text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      used_by    text,
      used_at    timestamptz,
      revoked    boolean NOT NULL DEFAULT false,
      expires_at timestamptz
    )`);
  // 模拟盘状态镜像（托管环境唯一可行的持久化通道）
  //   · 一行 = 一个 uid 的全部模拟盘数据（accounts/positions/orders/equity/dailyPnl）
  //   · jsonb 而非拆列：PaperStore 是整体文档模型，行级拆解收益低、迁移成本高
  await pool.query(`
    CREATE TABLE IF NOT EXISTS paper_state (
      uid        text PRIMARY KEY,
      data       jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
}

/**
 * 幂等初始化。所有涉及存储的操作都先 await 它，
 * 这样就不依赖"启动时恰好跑完"——Serverless 下请求可能早于启动逻辑。
 */
async function ready() {
  if (!hasDb()) return false;
  if (!booting) {
    booting = (async () => {
      pool = makePool(connString().url);
      await migrate();
      return true;
    })();
    // 失败要能被后续调用重试，而不是永久卡住
    booting.catch((e) => {
      lastError = e;
      booting = null;
      pool = null;
    });
  }
  return booting;
}

async function query(text, params) {
  if (!hasDb()) throw new Error('未配置数据库连接串');
  await ready();
  return pool.query(text, params);
}

/** 诊断用：报告连接状态与表是否存在（不泄露连接串） */
async function health() {
  const c = connString();
  if (!c) return { configured: false };
  try {
    await ready();
    const r = await pool.query('SELECT 1 AS ok');
    const t = await pool.query(
      `SELECT to_regclass('public.app_users') AS users, to_regclass('public.invite_codes') AS invites`,
    );
    return {
      configured: true,
      via: c.key,
      connected: r.rows[0]?.ok === 1,
      tables: { users: Boolean(t.rows[0]?.users), invites: Boolean(t.rows[0]?.invites) },
    };
  } catch (e) {
    return { configured: true, via: c.key, connected: false, error: e.message };
  }
}

module.exports = { hasDb, query, ready, health, migrate };
