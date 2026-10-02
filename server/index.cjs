#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// AI深度量化 - 独立一体化服务（单端口 3001）
//   · RESTful API：quote / history / mkline(分钟K线) / minute(分时)
//     / indices / search / backtest(策略回测) / qa(网站AI问答) / health
//   · 生产模式：直接托管 dist/ 静态资源（单 URL 即可访问整站）
//   · 数据源：新浪/腾讯公开财经接口，无需任何 API Key，自动切换
//   · 自维护：每日 02:00–03:00 自动自检（代码扫描 + 接口冒烟测试 + 报告）
//   · 访问防护：站点密码 Basic Auth（.env: SITE_USERNAME/SITE_PASSWORD）+ 每 IP 限流
// ─────────────────────────────────────────────────────────────
// 启动方式：
//   node server/index.cjs                # 正常启动（API + dist 静态托管 + 自检调度）
//   node server/index.cjs --maintain-once  # 立即执行一次自检后退出（供计划任务调用）
//   node server/index.cjs --no-maintain  # 关闭自检调度（调试用）
// ─────────────────────────────────────────────────────────────
const express = require('express');
const axios = require('axios');
const iconv = require('iconv-lite');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const auth = require('./auth.cjs');
const brain = require('./ai/brain.cjs');
const reviewMod = require('./agents/review.cjs');
const review = require('./agents/review.cjs');
const cloudAI = require('./ai/cloud.cjs');
const llmPipeline = require('./agents/llm_pipeline.cjs');
const { normalizeByokOverride } = require('./agents/byok.cjs');
const reasoning = require('./ai/reasoning.cjs');

// 崩溃兜底：未捕获异常/Promise 拒绝只记录不退出，避免整站静默消失
// （原注为"配合 start.bat 看门狗"；start.bat 已于 2026-09-19 合并进启动脚本，看门狗取消）
process.on('uncaughtException', (e) => console.error('[兜底] 未捕获异常:', (e && e.stack) || e));
process.on('unhandledRejection', (e) => console.error('[兜底] 未处理的 Promise 拒绝:', (e && e.stack) || e));

const app = express();
// Vercel/反向代理后取真实客户端 IP（限流按 IP 计数）
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;
const ARGS = process.argv.slice(2);
const MAINTAIN_ONCE = ARGS.includes('--maintain-once');
const NO_MAINTAIN = ARGS.includes('--no-maintain');
/** Vercel Serverless 环境（由 Vercel 注入 VERCEL=1）：不监听端口、不做本地调度、收紧超时 */
const IS_VERCEL = process.env.VERCEL === '1';

const APP_NAME = 'AI深度量化';
const APP_VERSION = '2.0.0';

// 安全响应头（同源单体部署，无需放开跨域——防外站嵌套/嗅探/引用泄露）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// 跨域策略：同源单体架构下浏览器无需 CORS；仅给本地开发（Vite :5173 → :3001）留白名单
//   不再使用通配符 *——Cookie 会话场景下通配符等于向所有网站敞开 API（内网穿透公开后必须收紧）
const DEV_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && DEV_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ───────────── API 限流（每 IP 每分钟 N 次，超限 429 + Retry-After） ─────────────
const RATE_LIMIT = Math.max(Number(process.env.API_RATE_LIMIT) || 120, 1);
const rateMap = new Map(); // ip -> [请求时间戳]
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [ip, arr] of rateMap) {
    const kept = arr.filter((t) => t > cutoff);
    if (kept.length) rateMap.set(ip, kept);
    else rateMap.delete(ip);
  }
}, 60_000).unref();
app.use((req, res, next) => {
  const ip = req.ip || 'unknown';
  // 回环地址豁免（本机浏览器与每日自检冒烟使用；限流防的是外部刷接口）
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  const now = Date.now();
  const arr = (rateMap.get(ip) || []).filter((t) => t > now - 60_000);
  if (arr.length >= RATE_LIMIT) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: `请求过于频繁（每分钟上限 ${RATE_LIMIT} 次），请稍后再试` });
  }
  arr.push(now);
  rateMap.set(ip, arr);
  next();
});

// ───────────── 访问防护：用户认证系统（注册/登录/Cookie 会话，模块见 server/auth.cjs） ─────────────
/** 读取根目录 .env（无 dotenv 依赖；不覆盖已存在的环境变量，Vercel 平台变量优先） */
function loadEnvFile() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* 无 .env 时使用系统环境变量 */
  }
}
loadEnvFile();

const SITE_USERNAME = process.env.SITE_USERNAME || 'admin';
const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
// ── 鉴权开关 与「引导管理员」解耦（2026-09-21）────────────────────
//  原先 `AUTH_ENABLED = Boolean(SITE_PASSWORD)` 把两件事绑死：
//    「是否开启鉴权」 ＝ 「是否用环境变量造一个管理员账号」。
//  后果（线上实测）：要么整站无鉴权，要么必须存在一个**由环境变量定义的账号**
//  —— 用户无法"用自己的账号登录并成为管理员"，等于被迫用共享/默认账号。
//  现在：AUTH_ENABLED 可单独由 `AUTH_ENABLED=1` 打开；
//        SITE_PASSWORD 只用于**可选的**引导管理员（给了才创建）。
//  ⚠️ 向后兼容：仍设置 SITE_PASSWORD 的老部署行为完全不变
//     （BOOTSTRAP_ADMIN 等价于原来的 AUTH_ENABLED）。
const AUTH_ENABLED =
  ['1', 'true', 'on'].includes(String(process.env.AUTH_ENABLED || '').toLowerCase()) ||
  Boolean(SITE_PASSWORD);
const BOOTSTRAP_ADMIN = AUTH_ENABLED && Boolean(SITE_PASSWORD);
if (!AUTH_ENABLED) {
  console.warn(
    '⚠️ 未开启鉴权（AUTH_ENABLED 未置 1 且未配置 SITE_PASSWORD）：整站 /api/* 无访问鉴权' +
      '（仅建议本机/可信局域网使用）。模拟盘改按来源 IP 分账以避免多设备串号；' +
      '请勿在无鉴权状态下把服务暴露到公网。',
  );
}

// 用户系统初始化（会话密钥/用户表）+（可选）首次启动用环境变量账号引导创建管理员
auth.init();
if (AUTH_ENABLED && !auth.isPersistent()) {
  console.warn(
    '🔴 [认证] 已开启鉴权，但既无数据库、文件系统也不可写：\n' +
      '    · 由环境变量引导的管理员在每次冷启动重建 ⇒ 登录**可用且各实例一致**；\n' +
      '    · 但**新注册的账号不会被保存**，注册接口将显式返回 503（不假装成功）。\n' +
      '    要支持多人各自注册，请接入可写存储（本项目已支持 Postgres，配好 DATABASE_URL 即可）。',
  );
}
// 数据库探测与引导管理员创建都是**异步**的：不阻塞启动，但失败必须显式可见（不静默）。
const bootAuth = () => {
  if (BOOTSTRAP_ADMIN) return auth.ensureBootstrapAdmin(SITE_USERNAME, SITE_PASSWORD);
  if (AUTH_ENABLED) {
    console.log(
      '👤 [认证] 已开启鉴权，但未配置引导管理员（SITE_PASSWORD 为空）——' +
        `请通过注册页自行创建账号。管理员判定用户名为「${SITE_USERNAME}」，` +
        '故 SITE_USERNAME 需设为你自己的用户名。',
    );
  }
  return undefined;
};
Promise.resolve()
  .then(() => (typeof auth.ready === 'function' ? auth.ready() : null))
  .then(bootAuth)
  .catch((e) =>
    console.error('🔴 [认证] 存储初始化失败（若已配置数据库，请检查连接串是否可用）:', e.message),
  );
brain.init();

// ── AI 助手平台上下文与会话历史 ──
const PLATFORM_KNOWLEDGE = [
  '你是「AI深度量化」平台的内置AI助手，运行在平台网站上。用户提问时，你应该理解他们在问关于本平台的功能使用、量化知识或市场数据。',
  '',
  '## 平台功能全景',
  '- 量化看板（/stock/:symbol）：输入股票代码进入，K线图+MA5/10/20/60/120/250+成交量+MACD/RSI/KDJ副图切换+形态标注（突破/破位/双底/头肩顶）+五档盘口+资金流/财务面板+实时走势',
  '- 量化因子分析（/analyze）：五因子模型（趋势30/动量25/量能15/波动15/位置15）给股票打0-100综合评分',
  '- 策略回测（/backtest）：输入代码选择策略（MA双均线5-20/RSI超买超卖/买入持有），输出收益曲线/最大回撤/夏普比率/盈亏比/交易明细，含买卖点标记',
  '- 模拟交易（/paper）：100万虚拟资金真实行情撮合，市价/限价单，五档盘口联动下单，快捷仓位按钮，Agent团队自动策略（MA双均线/RSI反转/网格交易），价格告警',
  '- Agent团队（/agents）：主理人调度制五阶段流水线——数据收集（技术/基本面/公告/情绪四分析师）→多空辩论→交易决策→风险评估→终审',
  '- AI助手（当前页面）：量化知识问答，支持上下文对话',
  '- 首页（/）：市场概况+我的收藏+今日观察（因子评分Top5）+板块与资金（行业/概念/地域主力净流入+涨跌幅排行）+功能中心',
  '',
  '## 数据说明',
  '- 行情数据来自腾讯/新浪公开接口，K线默认前复权',
  '- 模拟盘手续费：佣金万2.5（最低5元）+卖出印花税万5',
  '- Agent团队风险控制：单笔≤20%、单标的≤30%、当日同标的买入≤3次',
  '',
  '## 回答要求',
  '- 用户问「XX怎么用」时，理解为问本平台的XX功能，给出具体操作步骤',
  '- 涉及投资建议时，说明本平台为学术研究演示，不构成投资建议',
  '- 可以结合实时行情数据（如大盘指数、板块资金流）回答市场相关问题',
];

// 会话历史（per-uid 内存存储，保留最近 10 轮）
const chatHistory = new Map(); // uid -> [{role, content}]
const CHAT_HISTORY_MAX_UIDS = 500; // 上限保护：默认 'ip:*' 分账后 uid 会随来源 IP 增长
function getHistory(uid) {
  if (!chatHistory.has(uid)) {
    if (chatHistory.size >= CHAT_HISTORY_MAX_UIDS) {
      // 淘汰最早写入的会话（Map 保持插入序）
      const oldest = chatHistory.keys().next().value;
      if (oldest !== undefined) chatHistory.delete(oldest);
    }
    chatHistory.set(uid, []);
  }
  return chatHistory.get(uid);
}
function pushHistory(uid, role, content) {
  const h = getHistory(uid);
  h.push({ role, content });
  if (h.length > 20) h.splice(0, h.length - 20); // 保留最近 10 轮（20 条消息）
}
// 云端模型配置观测（启动即打印实际使用的端点，方便排查）
if (cloudAI.configured()) {
  const cc = cloudAI.resolve();
  console.log(`🛰️ [AI云端] ${cc.provider} · ${cc.model} · ${cc.base}`);
} else {
  console.log('🧠 [AI云端] 未配置云端模型，AI 助手使用本地规则引擎+知识库（.env 填 AI_CLOUD_* 启用）');
}

/** 冒烟测试/内部调用的认证头（Basic 形式，auth 系统按用户表兼容校验） */
const authHeaderValue = () =>
  AUTH_ENABLED
    ? { Authorization: `Basic ${Buffer.from(`${SITE_USERNAME}:${SITE_PASSWORD}`).toString('base64')}` }
    : {};

// JSON 体解析需先于 /api/auth/* 路由
app.use(express.json({ limit: '100kb' }));

// API 鉴权（仅保护 /api/*；静态资源交由 SPA 路由守卫，深链接不碎）
// 未登录返回纯 JSON 401（不带 WWW-Authenticate，根除浏览器原生弹窗，由前端登录页接管）
//
// 公开行情白名单（2026-09-27，20 人并发优化）：纯公开市场数据的只读 GET 免登录——
//   数据本身是新浪/腾讯公开接口的再分发，无个体差异；配合 Cache-Control s-maxage，
//   无 Cookie 请求可被 Vercel CDN 边缘缓存（20 人轮询在边缘合并，不触发函数调用、
//   不烧 Active CPU）。爬虫风险由 API_RATE_LIMIT（按 IP）兜底。
//   ⚠️ 白名单端点不得引用 req.user（当前均不引用），也不得返回任何个体数据。
const PUBLIC_API_PREFIXES = [
  '/api/indices', '/api/mood', '/api/quote/', '/api/minute/', '/api/sectors/', '/api/news',
];
app.use((req, res, next) => {
  if (!AUTH_ENABLED || req.method === 'OPTIONS') return next();
  if (!req.path.startsWith('/api')) return next();
  if (req.path.startsWith('/api/auth/') || req.path === '/api/health') return next();
  const isPublicGet = req.method === 'GET' && PUBLIC_API_PREFIXES.some((p) => req.path.startsWith(p));
  if (isPublicGet) {
    // 边缘缓存 20s + 过期后 40s 内先回旧值再后台刷新（stale-while-revalidate）
    res.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=40');
    return next();
  }
  const user = auth.getUserFromRequest(req);
  if (user) {
    req.user = user; // 模拟盘按用户名分账（uid 隔离）
    return next();
  }
  return res.status(401).json({ error: '未登录或会话已过期，请重新登录' });
});

// 认证路由：注册 / 登录 / 登出 / 会话查询
app.use('/api/auth', auth.router({ adminUsername: AUTH_ENABLED ? SITE_USERNAME : '', authEnabled: AUTH_ENABLED }));


// ───────────── AI 请求保护（单实例兜底；公网部署仍需 Redis） ─────────────
const AI_QA_LIMIT = Math.max(Number(process.env.AI_QA_RATE_LIMIT) || 6, 1);
const AI_AGENT_LIMIT = Math.max(Number(process.env.AI_AGENT_RATE_LIMIT) || 2, 1);
const AI_WINDOW_MS = 60_000;
const aiRateMap = new Map();
function aiRateKey(req) {
  return req.user?.uid ? `uid:${req.user.uid}` : `ip:${req.ip || 'unknown'}`;
}
function consumeAiQuota(req, kind, limit) {
  const key = `${kind}:${aiRateKey(req)}`;
  const now = Date.now();
  const recent = (aiRateMap.get(key) || []).filter((t) => t > now - AI_WINDOW_MS);
  if (recent.length >= limit) return false;
  recent.push(now);
  aiRateMap.set(key, recent);
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - AI_WINDOW_MS;
  for (const [key, times] of aiRateMap) {
    const recent = times.filter((t) => t > cutoff);
    if (recent.length) aiRateMap.set(key, recent);
    else aiRateMap.delete(key);
  }
}, AI_WINDOW_MS).unref();

// ───────────── 内存缓存 ─────────────
const cache = new Map();
function getCached(key, ttlMs) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
  return null;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

const QUOTE_TTL = 5_000; // 实时报价 5 秒
const HISTORY_TTL = 300_000; // 历史数据 5 分钟
const INDICES_TTL = 5_000;
const SEARCH_TTL = 60_000;
const MKLINE_TTL = 60_000; // 分钟K线 1 分钟

// 缓存兜底清理：过期超 5 分钟即删 + 总量裁剪，防长期运行内存无界增长
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.ts > 300_000) cache.delete(k);
  if (cache.size > 2000) {
    for (const k of Array.from(cache.keys()).slice(0, cache.size - 2000)) cache.delete(k);
  }
}, 60_000).unref();

// ───────────── HTTP 工具 ─────────────
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

/** 带重试的 GET（GBK 解码；失败换数据源重试 1 次）。
 *  Vercel 环境函数最长执行 10s：缩短超时且不重试，避免被平台掐断。 */
async function fetchText(url, headers, retryUrl) {
  const timeout = IS_VERCEL ? 5000 : 8000;
  try {
    const res = await axios.get(url, { headers, responseType: 'arraybuffer', timeout });
    return iconv.decode(Buffer.from(res.data), 'gbk');
  } catch (e) {
    if (retryUrl && !IS_VERCEL) {
      console.warn(`⚠️ 数据源失败，切换备用: ${e.message?.slice(0, 60)}`);
      const res = await axios.get(retryUrl, { headers, responseType: 'arraybuffer', timeout });
      return iconv.decode(Buffer.from(res.data), 'gbk');
    }
    throw e;
  }
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/** 有界并发 map（保持输入顺序），用于取代串行 await 循环 */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ───────────── 代码规范 ─────────────
/** 统一为腾讯代码：sh600519 / sz000858 / hk00700 / usAAPL / usINX */
function toTencentCode(symbol) {
  const raw = String(symbol).trim();
  const lower = raw.toLowerCase();
  if (/^(sh|sz|bj|hk)/.test(lower)) return lower; // bj = 北交所（920/43/83/87/88 开头）
  if (/^us/i.test(lower)) return `us${raw.slice(2)}`;
  if (/^\d{6}$/.test(raw)) {
    if (/^(43|83|87|88|92)/.test(raw)) return `bj${raw}`; // 北交所代码段
    return /^[69]/.test(raw) ? `sh${raw}` : `sz${raw}`;
  }
  if (/^\d{5}$/.test(raw)) return `hk${raw}`;
  return `us${raw.toUpperCase()}`;
}

// ───────────── 1. 实时报价 ─────────────
/** 解析腾讯行情文本：v_sh600519="名称~代码~现价~昨收~今开~成交量~...~" */
function parseTencentQuote(text, symbol) {
  const m = text.match(/"([^"]*)"/);
  if (!m) return null;
  const parts = m[1].split('~');
  if (parts.length < 6) return null;
  const name = parts[1];
  const price = num(parts[3]);
  const prevClose = num(parts[4]);
  const open = num(parts[5]);
  // A股成交量单位为手（×100 = 股）；港股/美股直接为股
  const isCN = /^(sh|sz)/.test(String(symbol).toLowerCase());
  const volume = num(parts[6]) * (isCN ? 100 : 1);
  const changePercent = prevClose && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;

  // 五档盘口（仅 A 股）：腾讯字段 9-18 = 买一~买五价/量（手），19-28 = 卖一~卖五价/量；30 = 行情时间
  let bids = null;
  let asks = null;
  let quoteTime = null;
  if (isCN && parts.length > 30) {
    const bidsRaw = [];
    const asksRaw = [];
    for (let i = 0; i < 5; i++) {
      const bp = num(parts[9 + i * 2]);
      const bv = num(parts[10 + i * 2]);
      const ap = num(parts[19 + i * 2]);
      const av = num(parts[20 + i * 2]);
      if (bp != null && bv != null) bidsRaw.push({ price: bp, qty: bv * 100 });
      if (ap != null && av != null) asksRaw.push({ price: ap, qty: av * 100 });
    }
    bids = bidsRaw.sort((a, b) => b.price - a.price);
    asks = asksRaw.sort((a, b) => a.price - b.price);
    quoteTime = parts[30] && /^\d{14}$/.test(parts[30])
      ? `${parts[30].slice(8, 10)}:${parts[30].slice(10, 12)}:${parts[30].slice(12, 14)}`
      : null;
  }

  return {
    symbol: parts[2] || symbol,
    name,
    price,
    prevClose,
    open,
    high: num(parts[33]) ?? price,
    low: num(parts[34]) ?? price,
    volume,
    changePercent,
    timestamp: Date.now(),
    source: 'tencent',
    bids,
    asks,
    quoteTime,
  };
}

/** 获取腾讯行情文本；美股自动探测交易所后缀（usAAPL → usAAPL.OQ / usAAPL.N） */
async function fetchTencentQuoteText(code) {
  const headers = { 'User-Agent': UA, Referer: 'https://finance.qq.com' };
  let text = await fetchText(`https://qt.gtimg.cn/q=${code}`, headers);
  const isEmpty = new RegExp(`v_${code}=""`).test(text);
  if (/^us/i.test(code) && isEmpty) {
    for (const suffix of ['.OQ', '.N', '.A']) {
      const candidate = `${code}${suffix}`;
      try {
        const t = await fetchText(`https://qt.gtimg.cn/q=${candidate}`, headers);
        if (t && !new RegExp(`v_${candidate}=""`).test(t)) return t;
      } catch {
        /* 尝试下一个后缀 */
      }
    }
  }
  return text;
}

app.get('/api/quote/:symbol', async (req, res) => {
  const symbol = req.params.symbol;
  const code = toTencentCode(symbol);
  const cacheKey = `quote:${code}`;
  const cached = getCached(cacheKey, QUOTE_TTL);
  if (cached) return res.json(cached);

  try {
    const text = await fetchTencentQuoteText(code);
    const quote = parseTencentQuote(text, symbol);
    if (!quote || !quote.price) {
      return res.status(404).json({ error: `未获取到 ${symbol} 的实时报价` });
    }
    setCache(cacheKey, quote);
    res.json(quote);
  } catch (e) {
    res.status(500).json({ error: `获取报价失败: ${e.message?.slice(0, 80)}` });
  }
});

// ───────────── 2. 历史 K 线 ─────────────
/** 解析腾讯 K 线 JSON：{data:{code:{day:[[date,open,close,high,low,vol],...]}}} */
function parseTencentKlines(json, symbol, unit = 'day', adjust = 'qfq') {
  const data = json?.data?.[symbol];
  if (!data) return [];
  // 腾讯按复权模式返回不同数据键：qfqday / hfqday / day（不复权）
  const rows = (adjust !== 'none' ? data?.[`${adjust}${unit}`] : null) || data?.[`qfq${unit}`] || data?.[unit] || [];
  // A股成交量单位为手（×100 = 股），与 Baostock 等源统一为股
  const isCN = /^(sh|sz)/.test(String(symbol).toLowerCase());
  return rows.map((r) => ({
    date: String(r[0]).slice(0, 10),
    open: num(r[1]),
    close: num(r[2]),
    high: num(r[3]),
    low: num(r[4]),
    volume: isCN ? (num(r[5]) ?? 0) * 100 : num(r[5]),
  }));
}

/** 获取日 K 原始行（美股自动探测交易所后缀；供 history/backtest/qa 复用） */
async function fetchDailyRows(code, count = 500, adjust = 'qfq') {
  // 腾讯/新浪日K单次上限 2000 根，超限会导致接口返回空
  const c = Math.min(Number(count) || 500, 2000);
  const candidates = /^us/i.test(code) ? [`${code}.OQ`, `${code}.N`, code] : [code];
  let best = [];
  for (const cand of candidates) {
    try {
      if (adjust === 'none') {
        // 不复权走 kline/kline 端点（单次可给 2000 根）
        const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${cand},day,,,${c}`;
        const text = await fetchText(url, { 'User-Agent': UA, Referer: 'https://finance.qq.com' });
        const json = JSON.parse(text);
        if (json.code !== 0) continue;
        const rows = parseTencentKlines(json, cand, 'day', adjust);
        if (rows.length > 2) {
          best = rows;
          break;
        }
      } else {
        // 前复权/后复权：fqkline 单次上限 640 根 → 分页向前抓取（最多 4 页 ≈ 7.5 年）
        let collected = [];
        let end = '';
        for (let page = 0; page < 4 && collected.length < c; page++) {
          const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${cand},day,,${end},${Math.min(c - collected.length, 640)},${adjust}`;
          const text = await fetchText(url, { 'User-Agent': UA, Referer: 'https://finance.qq.com' });
          const json = JSON.parse(text);
          if (json.code !== 0) break;
          const rows = parseTencentKlines(json, cand, 'day', adjust);
          const seen = new Set(collected.map((r) => r.date));
          const fresh = rows.filter((r) => !seen.has(r.date));
          if (!fresh.length) break;
          collected = [...fresh, ...collected].sort((a, b) => a.date.localeCompare(b.date));
          end = collected[0].date; // 下一页以当前最早日期为终点向前翻
        }
        if (collected.length > 2) {
          best = collected;
          break;
        }
      }
    } catch {
      /* 尝试下一个候选 */
    }
  }
  // 新浪长历史补充：仅用于不复权模式（新浪为不复权口径，混入会破坏前/后复权连续性）
  if (best.length < 800 && adjust === 'none' && /^(sh|sz)/i.test(code) && c > 800) {
    try {
      const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${code}&scale=240&ma=no&datalen=${c}`;
      const text = await fetchText(url, {
        'User-Agent': UA,
        Referer: 'https://finance.sina.com.cn',
      });
      const data = JSON.parse(text);
      if (Array.isArray(data) && data.length > best.length) {
        const rows = data
          .map((r) => ({
            date: String(r.day).slice(0, 10),
            open: num(r.open),
            close: num(r.close),
            high: num(r.high),
            low: num(r.low),
            volume: num(r.volume),
          }))
          .filter((r) => r.close !== null && r.open !== null)
          .sort((a, b) => a.date.localeCompare(b.date));
        if (rows.length > best.length) return rows;
      }
    } catch {
      /* 新浪不可用时保持腾讯结果 */
    }
  }
  return best;
}


// ───────────── 2a. 周期可用性策略（后端按数据覆盖动态生成，新上市股票自动适配） ─────────────
app.get('/api/period-policy/:symbol', async (req, res) => {
  const symbol = req.params.symbol;
  const code = toTencentCode(symbol);
  const cacheKey = `period-policy:${code}`;
  const cached = getCached(cacheKey, HISTORY_TTL);
  if (cached) return res.json(cached);

  try {
    const klines = await fetchDailyRows(code, 2400);
    if (!klines.length) throw new Error('K 线数据为空');
    const first = klines[0].date;
    const last = klines[klines.length - 1].date;
    const spanDays = (Date.parse(last) - Date.parse(first)) / 86400000;
    const policy = {
      symbol,
      source: 'baostock-or-tencent',
      dataStart: first,
      dataEnd: last,
      barCount: klines.length,
      coverageDays: Math.round(spanDays),
      // 周期可用性：季线需 ≥1 年数据，年线需 ≥3 年数据（参考主流软件，数据不足置灰提示）
      periods: {
        day: true,
        '3day': true,
        week: true,
        month: true,
        quarter: spanDays >= 365,
        year: spanDays >= 1000,
      },
      recommended: spanDays < 365 ? 'day' : spanDays < 1000 ? 'month' : 'year',
    };
    setCache(cacheKey, policy);
    res.json(policy);
  } catch (e) {
    res.status(500).json({ error: `周期策略计算失败: ${e.message?.slice(0, 80)}` });
  }
});

const localstore = require('./localstore.cjs'); // 本地 K 线归档（Baostock 同步）兜底

app.get('/api/history/:symbol', async (req, res) => {
  const symbol = req.params.symbol;
  const code = toTencentCode(symbol);
  const frequency = req.query.frequency || '1d';
  const count = Math.min(Number(req.query.count) || 500, 2000);
  const adjust = ['qfq', 'hfq', 'none'].includes(String(req.query.adjust)) ? String(req.query.adjust) : 'qfq';
  const cacheKey = `history:${code}:${frequency}:${count}:${adjust}`;
  const cached = getCached(cacheKey, HISTORY_TTL);
  if (cached) return res.json(cached);

  // 周期映射：1d/1w/1M → 腾讯 unit
  const unitMap = { '1d': 'day', '1w': 'week', '1M': 'month' };
  const unit = unitMap[frequency] || 'day';

  try {
    const klines = await fetchDailyRows(code, count, adjust);
    if (!klines.length) throw new Error('K 线数据为空');
    // 周/月线：后端直接请求对应 unit，避免前端聚合
    let out = klines;
    if (unit === 'week' || unit === 'month') {
      const cand = /^us/i.test(code) ? `${code}.OQ` : code;
      try {
        const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${cand},${unit},,,${count}${adjust === 'none' ? '' : ',' + adjust}`;
        const text = await fetchText(url, { 'User-Agent': UA, Referer: 'https://finance.qq.com' });
        const json = JSON.parse(text);
        const rows = parseTencentKlines(json, cand, unit, adjust);
        if (rows.length > 1) out = rows;
      } catch {
        /* 保留日线回退 */
      }
    }
    const result = { symbol: code, frequency, adjust, klines: out };
    setCache(cacheKey, result);
    res.json(result);
  } catch (e) {
    // 备用：新浪日 K
    try {
      const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${code}&scale=240&ma=no&datalen=${count}`;
      const text = await fetchText(url, { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' });
      const data = JSON.parse(text);
      const klines = (Array.isArray(data) ? data : []).map((r) => ({
        date: String(r.day).slice(0, 10),
        open: num(r.open),
        close: num(r.close),
        high: num(r.high),
        low: num(r.low),
        volume: num(r.volume),
      }));
      if (!klines.length) throw new Error('新浪 K 线数据为空');
      const result = { symbol: code, frequency, adjust: adjust === 'none' ? 'none' : 'none(备用源)', klines };
      setCache(cacheKey, result);
      res.json(result);
    } catch (e2) {
      // 本地归档兜底（Baostock 每日同步）：上游全挂时返回本地不复权数据，显式标注来源与口径（禁止静默降级）
      if (unit === 'day') {
        const local = localstore.getLocalKline(code, count);
        if (local && local.length) {
          const result = {
            symbol: code,
            frequency,
            adjust: adjust === 'none' ? 'none' : 'none(本地归档)',
            source: 'local-archive',
            stale: true,
            klines: local,
          };
          setCache(cacheKey, result);
          return res.json(result);
        }
      }
      // 美股指数专属兜底：腾讯对指数不支持复权历史（fqkline/kline 均只返回最新 1 根），
      // 新浪 CN 接口不覆盖美股 ⇒ 无本地归档时上游"全败"其实是数据源固有缺失，不是瞬时故障。
      // 降级为"最新交易日快照 K 线"（1 根）并显式标注 degraded，而不是 500 ——
      // 前端 sparkline/卡片对 1 根数据的处理已兼容，500 反而会让首页持续刷错误请求。
      if (unit === 'day' && /^us(INX|IXIC|DJI)$/i.test(code)) {
        try {
          const cand = `${code}.OQ`;
          const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${cand},day,,,5,qfq`;
          const text = await fetchText(url, { 'User-Agent': UA, Referer: 'https://finance.qq.com' });
          const json = JSON.parse(text);
          const rows = parseTencentKlines(json, cand, 'day', adjust);
          if (rows.length) {
            const result = {
              symbol: code,
              frequency,
              adjust: 'none(指数快照)',
              source: 'tencent-index-snapshot',
              stale: true,
              degraded: '美股指数暂无免费历史K线数据源（腾讯指数仅提供最新交易日），已降级为快照数据',
              klines: rows,
            };
            setCache(cacheKey, result);
            return res.json(result);
          }
        } catch { /* 快照也失败则走下方 500 */ }
      }
      res.status(500).json({ error: `获取历史数据失败: ${e2.message?.slice(0, 80)}` });
    }
  }
});

// ───────────── 2b. 分钟 K 线（真实多日 OHLCV） ─────────────
/** 解析腾讯 mkline：data.<code>.<m5> = [[YYYYMMDDHHmm, open, close, high, low, vol, ...]] */
function parseTencentMkline(json, code, mKey) {
  const rows = json?.data?.[code]?.[mKey];
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => {
      const raw = String(r[0]);
      const y = raw.slice(0, 4);
      const mo = raw.slice(4, 6);
      const d = raw.slice(6, 8);
      const hh = raw.slice(8, 10);
      const mm = raw.slice(10, 12);
      return {
        date: `${y}-${mo}-${d} ${hh}:${mm}`,
        open: num(r[1]),
        close: num(r[2]),
        high: num(r[3]),
        low: num(r[4]),
        volume: num(r[5]),
      };
    })
    .filter((k) => k.open !== null && k.close !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 解析新浪美股分钟 K（JSONP: var _=([{d,o,h,l,c,v,a},...])） */
function parseSinaUSMinute(text) {
  try {
    const s = text.indexOf('([');
    const e = text.lastIndexOf('])');
    if (s < 0 || e < 0) return [];
    const arr = JSON.parse(text.slice(s + 1, e + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .map((r) => ({
        date: String(r.d).slice(0, 16),
        open: num(r.o),
        close: num(r.c),
        high: num(r.h),
        low: num(r.l),
        volume: num(r.v),
      }))
      .filter((k) => k.open !== null && k.close !== null)
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

/** 解析腾讯分时（1 分钟粒度）→ K 线点（日期按北京时间，兼容海外服务器 UTC 时区） */
function parseTencentMinuteKlines(json, symbol) {
  const rows = json?.data?.[symbol]?.data?.data;
  if (!Array.isArray(rows)) return [];
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [y, mo, d] = fmt.format(now).split('-');
  return rows
    .map((line) => {
      const parts = String(line).trim().split(/\s+/);
      if (parts.length < 2) return null;
      const t = parts[0];
      const price = num(parts[1]);
      if (price === null || price <= 0) return null;
      return {
        date: `${y}-${mo}-${d} ${t.slice(0, 2)}:${t.slice(2, 4)}`,
        open: price,
        close: price,
        high: price,
        low: price,
        volume: num(parts[2]) || 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 将 N 根 1 分钟 K 聚合为 1 根周期 K（尾部分组，OHLCV 标准聚合） */
function aggregateMinuteKlines(points, step) {
  if (step <= 1) return points;
  const out = [];
  for (let i = points.length; i > 0; i -= step) {
    const grp = points.slice(Math.max(0, i - step), i);
    if (grp.length === 0) continue;
    out.unshift({
      date: grp[grp.length - 1].date,
      open: grp[0].open,
      close: grp[grp.length - 1].close,
      high: Math.max(...grp.map((p) => p.high)),
      low: Math.min(...grp.map((p) => p.low)),
      volume: grp.reduce((a, p) => a + p.volume, 0),
    });
  }
  return out;
}

/**
 * GET /api/mkline/:symbol?period=m5&count=320
 * 真实分钟 K 线（多日）：
 *   - A股/指数：腾讯 mkline（m1/m5/m15/m30/m60）
 *   - 美股：新浪 US_MinKService（type=1/5/15/30/60）
 *   - 港股：腾讯当日分时聚合
 */
app.get('/api/mkline/:symbol', async (req, res) => {
  const symbol = req.params.symbol;
  const code = toTencentCode(symbol);
  const period = String(req.query.period || 'm5').replace(/^m/, '');
  const valid = ['1', '5', '15', '30', '60'];
  const step = valid.includes(period) ? Number(period) : 5;
  const count = Math.min(Number(req.query.count) || 320, 800);
  const cacheKey = `mkline:${code}:${step}:${count}`; // 必须含 count：120 分(640) 与 60 分(320) 同键会串味
  const cached = getCached(cacheKey, MKLINE_TTL);
  if (cached) return res.json(cached);

  try {
    let klines = [];
    let source = 'tencent-mkline';
    if (/^us/i.test(code)) {
      // ── 美股：新浪分钟 K ──
      const bare = code.replace(/^us/i, '').toLowerCase();
      const url = `https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_=/US_MinKService.getMinK?symbol=${bare}&type=${step}`;
      const text = await fetchText(url, { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' });
      klines = parseSinaUSMinute(text);
      source = 'sina-us';
    } else if (/^hk/i.test(code)) {
      // ── 港股：腾讯当日分时 → 本地聚合 ──
      const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`;
      const text = await fetchText(url, { 'User-Agent': UA, Referer: 'https://finance.qq.com' });
      const json = JSON.parse(text);
      const base = parseTencentMinuteKlines(json, code);
      klines = aggregateMinuteKlines(base, step);
      source = 'tencent-minute';
    } else {
      // ── A股：腾讯 mkline ──
      const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${code},m${step},,${count}`;
      const text = await fetchText(url, { 'User-Agent': UA, Referer: 'https://finance.qq.com' });
      const json = JSON.parse(text);
      klines = parseTencentMkline(json, code, `m${step}`);
      source = 'tencent-mkline';
    }
    if (!klines.length) {
      // 新股/北交所兜底：mkline 无数据时用当日分时聚合生成分钟 K（如 920288 上市首日）
      try {
        const mUrl = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`;
        const mText = await fetchText(mUrl, { 'User-Agent': UA, Referer: 'https://finance.qq.com' });
        const mJson = JSON.parse(mText);
        const bjDate = mJson?.data?.[code]?.data?.date;
        const bjDay = bjDate ? `${bjDate.slice(0, 4)}-${bjDate.slice(4, 6)}-${bjDate.slice(6, 8)}` : null;
        const pts = parseTencentMinute(mJson, code)
          .map((p) => ({
            date: `${bjDay ?? ''} ${p.time}`,
            open: p.price, close: p.price, high: p.price, low: p.price, volume: p.volume,
          }))
          .filter((p) => p.date.trim() !== '');
        if (pts.length) {
          klines = aggregateMinuteKlines(pts, step);
          source = 'tencent-minute-agg';
        }
      } catch { /* 兜底失败保持空 */ }
    }
    if (!klines.length) throw new Error('分钟 K 线数据为空');
    const result = { symbol: code, period: `m${step}`, source, klines: klines.slice(-count) };
    setCache(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: `获取分钟K线失败: ${e.message?.slice(0, 80)}` });
  }
});

// ───────────── 2c. 当日分时 ─────────────
/** 解析腾讯当日分时：["0930 1355.00 227 30758500.00", ...] */
function parseTencentMinute(json, symbol) {
  const rows = json?.data?.[symbol]?.data?.data;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((line) => {
      const parts = String(line).trim().split(/\s+/);
      if (parts.length < 2) return null;
      const time = parts[0];
      const price = num(parts[1]);
      if (price === null || price <= 0) return null;
      return {
        time: `${time.slice(0, 2)}:${time.slice(2, 4)}`,
        price,
        volume: num(parts[2]) || 0,
      };
    })
    .filter(Boolean);
}

/** 判断美东日期是否为夏令时（3月第2个周日 02:00 ~ 11月第1个周日 02:00） */
function isUSDST(y, m, d) {
  // 3月第二个周日
  const mar1 = new Date(Date.UTC(y, 2, 1));
  const secondSun = 8 + ((7 - mar1.getUTCDay()) % 7);
  // 11月第一个周日
  const nov1 = new Date(Date.UTC(y, 10, 1));
  const firstSun = 1 + ((7 - nov1.getUTCDay()) % 7);
  const ts = Date.UTC(y, m - 1, d);
  const dstStart = Date.UTC(y, 2, secondSun);
  const dstEnd = Date.UTC(y, 10, firstSun);
  return ts >= dstStart && ts < dstEnd;
}

/** 美东时间(EDT/EST) → 北京时间（EDT +12h / EST +13h），用于美股分时按当前时间窗口制图 */
function usTimeToBeijing(dateStr, timeStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [hh, mm] = String(timeStr).split(':').map(Number);
  const offsetHours = isUSDST(y, m, d) ? 12 : 13;
  const bj = new Date(Date.UTC(y, m - 1, d, hh, mm) + offsetHours * 3600 * 1000);
  const pad = (v) => String(v).padStart(2, '0');
  return {
    date: `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())}`,
    time: `${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`,
  };
}

app.get('/api/minute/:symbol', async (req, res) => {
  const symbol = req.params.symbol;
  const code = toTencentCode(symbol);
  const cacheKey = `minute:${code}`;
  const cached = getCached(cacheKey, QUOTE_TTL);
  if (cached) return res.json(cached);

  try {
    let points = [];
    let source = 'tencent-minute';
    if (/^us/i.test(code)) {
      // ── 美股：新浪 1 分钟 K 线（腾讯分时接口对美股仅返回当前 1 个点） ──
      const bare = code.replace(/^us/i, '').toLowerCase();
      const url = `https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_=/US_MinKService.getMinK?symbol=${bare}&type=1`;
      const text = await fetchText(url, {
        'User-Agent': UA,
        Referer: 'https://finance.sina.com.cn',
      });
      const klines = parseSinaUSMinute(text);
      points = klines.map((k) => {
        // 新浪美股时间为美东时区 → 统一转为北京时间（前端按当前时间窗口制图）
        const bj = usTimeToBeijing(String(k.date).slice(0, 10), String(k.date).slice(11, 16));
        return {
          date: bj.date,
          time: bj.time,
          price: k.close,
          volume: k.volume ?? 0,
        };
      });
      source = 'sina-us';
    } else {
      // ── A股/港股：腾讯当日分时（补北京时间日期） ──
      const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`;
      const text = await fetchText(url, { 'User-Agent': UA, Referer: 'https://finance.qq.com' });
      const json = JSON.parse(text);
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .format(new Date())
        .split('-')
        .join('-');
      points = parseTencentMinute(json, code).map((p) => ({ ...p, date: today }));
    }
    if (!points.length) throw new Error('分时数据为空');
    const result = { symbol: code, source, points };
    setCache(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: `获取分时数据失败: ${e.message?.slice(0, 80)}` });
  }
});

// ───────────── 3. 大盘指数 ─────────────
const INDEX_CODES = ['sh000001', 'sh000300', 'sz399001', 'usINX', 'usIXIC', 'usDJI'];
const INDEX_NAMES = {
  sh000001: '上证指数',
  sh000300: '沪深300',
  sz399001: '深证成指',
  usINX: '标普500',
  usIXIC: '纳斯达克',
  usDJI: '道琼斯',
};

app.get('/api/indices', async (req, res) => {
  const cacheKey = 'indices';
  const cached = getCached(cacheKey, INDICES_TTL);
  if (cached) return res.json(cached);

  try {
    const text = await fetchText(`https://qt.gtimg.cn/q=${INDEX_CODES.join(',')}`, {
      'User-Agent': UA,
      Referer: 'https://finance.qq.com',
    });
    const items = [];
    for (const code of INDEX_CODES) {
      const re = new RegExp(`v_${code}="([^"]*)"`);
      const m = text.match(re);
      if (!m) continue;
      const parts = m[1].split('~');
      if (parts.length < 6) continue;
      const price = num(parts[3]);
      const prevClose = num(parts[4]);
      items.push({
        symbol: code,
        name: INDEX_NAMES[code] || parts[1],
        price,
        changePercent: prevClose && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
      });
    }
    if (!items.length) throw new Error('指数数据为空');
    setCache(cacheKey, items);
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: `获取指数失败: ${e.message?.slice(0, 80)}` });
  }
});

// ───────────── 4. 搜索 ─────────────
/** 常见美股代码兜底名称表（新浪 suggest 不返回英文代码时使用） */
const US_FALLBACK = {
  AAPL: '苹果',
  MSFT: '微软',
  NVDA: '英伟达',
  GOOGL: '谷歌-A',
  GOOG: '谷歌-C',
  AMZN: '亚马逊',
  META: 'Meta',
  TSLA: '特斯拉',
  AMD: '超威半导体',
  NFLX: '奈飞',
  AVGO: '博通',
  INTC: '英特尔',
  IBM: 'IBM',
  ORCL: '甲骨文',
  CRM: '赛富时',
  ADBE: 'Adobe',
  DIS: '迪士尼',
  KO: '可口可乐',
  PEP: '百事可乐',
  WMT: '沃尔玛',
  MCD: '麦当劳',
  BA: '波音',
  GE: '通用电气',
  XOM: '埃克森美孚',
  JPM: '摩根大通',
  BAC: '美国银行',
  V: 'Visa',
  MA: '万事达',
  PYPL: 'PayPal',
  INX: '标普500',
  IXIC: '纳斯达克',
  DJI: '道琼斯',
};
/** 解析新浪搜索：var suggestvalue="名称1,类型1,代码1|名称2,类型2,代码2|..." */
function parseSinaSearch(text) {
  const m = text.match(/"([^"]*)"/);
  if (!m || !m[1]) return [];
  return m[1]
    .split('|')
    .filter(Boolean)
    .map((item) => {
      const parts = item.split(',');
      if (parts.length < 3) return null;
      const raw = parts[2].trim();
      let market;
      if (/^(sh|sz)/i.test(raw)) market = 'CN';
      else if (/^hk/i.test(raw)) market = 'HK';
      else if (/^us/i.test(raw)) market = 'US';
      else if (/^\d{6}$/.test(raw)) market = 'CN';
      else if (/^\d{5}$/.test(raw)) market = 'HK';
      else market = 'US';
      return { name: parts[0], code: raw, market };
    })
    .filter(Boolean);
}

app.get('/api/search/:keyword', async (req, res) => {
  const keyword = req.params.keyword;
  const cacheKey = `search:${keyword}`;
  const cached = getCached(cacheKey, SEARCH_TTL);
  if (cached) return res.json(cached);

  const items = [];

  // 源 1：新浪 sugest（沪深港美主流代码）
  try {
    const url = `https://suggest3.sinajs.cn/suggest/type=11,12,13,14,15&key=${encodeURIComponent(keyword)}`;
    const text = await fetchText(url, { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' });
    items.push(...parseSinaSearch(text));
  } catch { /* 新浪失败继续东财 */ }

  // 源 2：东财 suggest（兜底：覆盖北交所 920/43/83/87/88 等新浪缺失的代码段；名称=代码的弱结果也尝试补全）
  const isWeakName = (it) => it.name === it.code || /^(sh|sz|bj)\d{5,6}$/.test(it.name); // 名称是"交易所前缀+代码"=无效名称
  if (items.length === 0 || items.every(isWeakName)) {
    items.length = 0; // 清空"名称=代码"的弱结果，用东财补全名称
    try {
      const emUrl = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(keyword)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=8`;
      const em = (await axios.get(emUrl, { headers: { 'User-Agent': UA, Referer: 'https://www.eastmoney.com/' }, timeout: 6000 })).data;
      const list = em?.QuotationCodeTable?.Data ?? [];
      for (const d of list) {
        if (!d.Code) continue;
        const secid = String(d.QuoteID || '');
        const market = /^0\.|^1\./.test(secid) ? 'CN' : 'US';
        items.push({ name: d.Name, code: String(d.Code), market });
      }
    } catch { /* 东财也失败则走代码直填兜底 */ }
  }

  const upper = keyword.trim().toUpperCase();
  const isCodeLike = /^[A-Z0-9.]{1,10}$/.test(upper);
  if (isCodeLike) {
    const direct = US_FALLBACK[upper];
    if (direct) {
      items.length = 0;
      items.push({ name: direct, code: upper, market: 'US' });
    } else if (/^\d{6}$/.test(upper)) {
      if (items.length === 0) items.push({ name: upper, code: upper, market: 'CN' }); // 已有结果（如东财补全）不覆盖
    } else if (/^\d{5}$/.test(upper)) {
      if (items.length === 0) items.push({ name: upper, code: upper, market: 'HK' });
    } else if (/^[A-Z]{1,6}$/.test(upper) && items.every((it) => it.code.toUpperCase() !== upper)) {
      items.push({ name: upper, code: upper, market: 'US' });
    }
  }
  setCache(cacheKey, items);
  res.json(items);
});

// ───────────── 5. 策略回测 ─────────────
const { runBacktest, rsiSeries } = require('./quant.cjs');
const { marketOf } = require('./paper/fees.cjs');
const { priceLimitPct } = require('./paper/matcher.cjs');
const experiments = require('./experiments.cjs');
/** GET /api/backtest?symbol=MSFT&strategy=ma&fast=5&slow=20&capital=100000&count=500 */
app.get('/api/backtest', async (req, res) => {
  const symbol = String(req.query.symbol || 'MSFT');
  const code = toTencentCode(symbol);
  const strategy = ['ma', 'rsi', 'buyhold'].includes(String(req.query.strategy))
    ? String(req.query.strategy)
    : 'ma';
  const fast = Math.min(Math.max(Number(req.query.fast) || 5, 2), 120);
  const slow = Math.min(Math.max(Number(req.query.slow) || 20, fast + 1), 250);
  const capital = Math.min(Math.max(Number(req.query.capital) || 100000, 1000), 1e9);
  const count = Math.min(Number(req.query.count) || 500, 2000);

  try {
    const klines = await fetchDailyRows(code, count);
    if (!klines.length) throw new Error('K 线数据为空');
    // 滑点默认 0.1%（可经 query 覆盖）；A 股按板块涨跌停幅度约束开盘触板不成交（评审 P1-3）
    const slippage = Math.min(Math.max(Number(req.query.slippage ?? 0.001), 0), 0.05);
    const limitPct = marketOf(code) === 'CN' ? priceLimitPct(code, null) : null;
    const result = runBacktest(klines, strategy, fast, slow, capital, marketOf(code), { slippage, limitPct });
    result.symbol = symbol;
    // 沪深300 指数基准（评审 R3）：同区间对齐的指数收益曲线——同股买入持有之外的市场基准
    if (marketOf(code) === 'CN') {
      try {
        const idxRows = await fetchDailyRows('sh000300', count);
        if (idxRows.length) {
          const idxByDate = new Map(idxRows.map((r) => [r.date, r.close]));
          let base = null;
          const b300 = [];
          for (const e of result.equity) {
            const c = idxByDate.get(e.date);
            if (c === undefined) continue;
            if (base === null) base = c;
            b300.push({ date: e.date, value: +((capital / base) * c).toFixed(2) });
          }
          if (b300.length > 5) {
            result.benchmark300 = b300;
            result.benchmark300Return = +((b300[b300.length - 1].value / b300[0].value - 1) * 100).toFixed(2);
          }
        }
      } catch { /* 基准获取失败不影响回测主体 */ }
    }
    try {
      experiments.record(result); // 实验管理：每次回测自动留痕（参数+口径+指标，可复现可对比）
    } catch { /* 记录失败不影响回测响应 */ }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: `回测失败: ${e.message?.slice(0, 80)}` });
  }
});

/**
 * GET /api/param-scan —— 参数扫描与稳健性判定（S7）
 *   回答一个问题：这个 fast/slow 组合是「挑」出来的吗？
 *   输出：最优参数 + 孤峰判据 + 样本外验证（前段选参/后段验证）+ 成本敏感度 + 多重比较直观提示
 *   query: symbol | fastFrom/fastTo/fastStep | slowFrom/slowTo/slowStep | capital | count | slippage
 *   ⚠️ 结果用于判断参数是否稳健，不构成投资建议。
 */
app.get('/api/param-scan', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || 'sh600000');
    const code = toTencentCode(symbol);
    const count = Math.min(Number(req.query.count) || 1500, 2000);
    const klines = await fetchDailyRows(code, count);
    if (!klines.length) throw new Error('K 线数据为空');

    const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
    const mkt = marketOf(code);
    const result = require('./paramscan.cjs').scan({
      klines,
      fastRange: [num(req.query.fastFrom, 5), num(req.query.fastTo, 20), num(req.query.fastStep, 1)],
      slowRange: [num(req.query.slowFrom, 20), num(req.query.slowTo, 60), num(req.query.slowStep, 5)],
      capital: num(req.query.capital, 100000),
      market: mkt,
      slippage: num(req.query.slippage, 0.001),
      limitPct: mkt === 'CN' ? priceLimitPct(code, null) : null,
    });
    result.symbol = symbol;
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: `参数扫描失败: ${e.message?.slice(0, 80)}` });
  }
});

/**
 * POST /api/agent/research —— Agent 单角色研究（P3 试点：Alpha + 工具循环）
 *   body: { question }
 *   流程：自然语言 → Alpha（工具循环：K线/回测/参数扫描/因子评估）→ final 结论
 *   返回：answer（模型结论）+ toolData（工具原始数据——数值保真，与结论并列核对）+ trace（审计轨迹）
 *   ⚠️ 真调云端模型（实测约 5-10s）；degraded=true 表示发生模型回退，结论可靠性下降；
 *      模型复述的数字不可靠，关键数值以 toolData 为准（LLM 不做算术铁律的延伸）。
 */
app.post('/api/agent/research', async (req, res) => {
  try {
    const question = String(req.body?.question || '').trim();
    if (!question) return res.status(400).json({ ok: false, error: '缺少 question' });

    const cloudMod = require('./ai/cloud.cjs');
    if (!cloudMod.configured()) {
      return res.status(503).json({ ok: false, error: '云端模型未配置（缺少 AI_CLOUD_API_KEY）' });
    }
    // ── T3 平台 LLM 档：仅管理员（L1.4，与 /api/agents/analyze 同口径）──
    if (!isAdminReq(req)) {
      return res.status(403).json({
        ok: false,
        tier: 'platform',
        error: '平台 LLM 档位仅管理员可用；自配 API 档位请在你的浏览器中直接填写自己的 Key（不经本站服务器）。',
        availableTiers: ['byok'],
      });
    }

    const { createAlphaRunner } = require('./agent/alpha.cjs');
    const runner = createAlphaRunner({
      fetchKlines: (code, count) => fetchDailyRows(code, count, 'qfq'),
      marketOf: (code) => marketOf(code),
      priceLimitPct: (code, name) => priceLimitPct(code, name),
    });

    const r = await runner(question, (msgs, opts) => cloudMod.chat(msgs, opts));

    res.json({
      ok: r.ok,
      answer: r.answer,
      draft: r.draft,
      reason: r.reason,
      rounds: r.rounds,
      degraded: r.degraded,
      actualModel: r.actualModel,
      toolData: r.toolData,
      trace: r.trace,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: `Agent 研究失败: ${e.message?.slice(0, 80)}` });
  }
});

/** 实验历史（最近 N 条，新在前；?symbol=sh600519&strategy=ma 过滤） */
app.get('/api/experiments', (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const filters = {
      symbol: req.query.symbol ? String(req.query.symbol) : undefined,
      strategy: req.query.strategy ? String(req.query.strategy) : undefined,
    };
    res.json({ ok: true, experiments: experiments.list(limit, filters) });
  } catch (e) {
    res.status(500).json({ error: `读取实验历史失败: ${e.message?.slice(0, 80)}` });
  }
});

/**
 * GET /api/crossbacktest —— 多标的横截面回测（评审 P2-5）
 *   factor 支持三种写法（M3 起）：
 *     · 预置因子族（mom 系列 / rev 系列）—— 走 crosssect 硬编码动量口径
 *     · 自定义表达式          —— 如 `mom60 - mom20`、`-vol20`、(mom20+rev60)/2
 *     · 两者由 crosssect.resolveFactor 统一分派，下游消费同一截面，口径不会分叉
 *   ⚠️ 表达式非法或全截面为空时返回 400 + error（**不回净值**）——
 *      调用方必须走错误分支，不可把"算不出"显示成"收益 0"。
 */
app.get('/api/crossbacktest', (req, res) => {
  try {
    const result = require('./crosssect.cjs').runCrossBacktest({
      factor: String(req.query.factor || 'mom20'),
      topN: Number(req.query.topN) || 5,
      rebalanceEvery: Number(req.query.rebalanceEvery) || 20,
      capital: Number(req.query.capital) || 1_000_000,
      slippage: req.query.slippage !== undefined ? Number(req.query.slippage) : 0.001,
      // 区间裁剪（样本外验证用）：仅截断交易日轴，因子窗口仍可读前置历史
      startDate: req.query.startDate ? String(req.query.startDate) : undefined,
      endDate: req.query.endDate ? String(req.query.endDate) : undefined,
    });
    res.status(result.error ? 400 : 200).json(result);
  } catch (e) {
    res.status(500).json({ error: `横截面回测失败: ${e.message?.slice(0, 80)}` });
  }
});

/**
 * GET /api/factor-layers —— 因子分层回测（M2.1）
 *   factor 同 /api/crossbacktest，支持预置因子与自定义表达式（M3）。
 *   ⚠️ 表达式方向不定时（如 `mom60 - mom20`）mono.strategyAligned 为 **null**，
 *      表示"不可判"而非"相反"——前端必须区分显示。
 *   用途：判定因子有效性是**贯穿全截面**还是只集中在头部/尾部。
 *   单看 topN 组合净值无法区分这两种情形——后者往往是数据噪声或市值效应。
 *   query: factor | layers(2-10，默认5) | rebalanceEvery | startDate | endDate
 *   ⚠️ 口径：**不计手续费与滑点**。本接口度量因子原始预测力，成本影响由
 *      /api/crossbacktest 的净值体现；两处口径有意分离，不构成可直接比较的收益。
 *   ⚠️ 层号语义固定「layer 1 = 因子值最高」：mom* 期望 rho<0（强层跑赢），
 *      rev* 期望 rho>0。响应含 alignedWithStrategy 按因子方向分判，勿只看 rho 符号。
 */
app.get('/api/factor-layers', (req, res) => {
  try {
    const result = require('./crosssect.cjs').layerAnalysis({
      factor: String(req.query.factor || 'mom20'),
      layers: Number(req.query.layers) || 5,
      rebalanceEvery: Number(req.query.rebalanceEvery) || 20,
      startDate: req.query.startDate ? String(req.query.startDate) : undefined,
      endDate: req.query.endDate ? String(req.query.endDate) : undefined,
    });
    res.status(result.error ? 400 : 200).json(result);
  } catch (e) {
    res.status(500).json({ error: `分层回测失败: ${e.message?.slice(0, 80)}` });
  }
});

/**
 * GET /api/factor-eval —— 因子稳健性评估（全区间 + 逐年对照）
 *   用途：判定因子是否稳健。单看全区间收益会被**路径依赖**放大——
 *   本项目实测：rev60 全区间超额 +253pp，但逐年 6 正 5 负、平均 -0.82pp。
 *   query: factors=rev60,mom20 | topN | rebalanceEvery | capital | yearFrom
 *   ⚠️ 计算量 = N 因子 × (1 + 年数) 次回测；归档已进程内缓存，实测 2 因子约 4.3s。
 *   ⚠️ 本接口的用途是**否定**不可靠因子，不是推荐因子；结果不构成投资建议。
 */
app.get('/api/factor-eval', (req, res) => {
  try {
    const factors = req.query.factors
      ? String(req.query.factors)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const result = require('./factoreval.cjs').evaluate({
      factors,
      topN: Number(req.query.topN) || 20,
      rebalanceEvery: Number(req.query.rebalanceEvery) || 20,
      capital: Number(req.query.capital) || 1_000_000,
      yearFrom: req.query.yearFrom ? Number(req.query.yearFrom) : undefined,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: `因子评估失败: ${e.message?.slice(0, 80)}` });
  }
});

// ───────────── 6. 网站 AI 问答（离线规则引擎，无外部 AI API） ─────────────
/** 推荐股票池（与前端 STOCK_POOL 一致） */
const QA_POOL = [
  { symbol: 'MSFT', name: '微软' },
  { symbol: 'NVDA', name: '英伟达' },
  { symbol: 'AAPL', name: '苹果' },
  { symbol: 'GOOGL', name: '谷歌-A' },
  { symbol: 'TSLA', name: '特斯拉' },
  { symbol: 'AMZN', name: '亚马逊' },
  { symbol: 'META', name: 'Meta' },
  { symbol: 'AMD', name: '超威半导体' },
  { symbol: '600519', name: '贵州茅台' },
  { symbol: '300750', name: '宁德时代' },
  { symbol: '00700', name: '腾讯控股' },
  { symbol: '03690', name: '美团-W' },
];

/** 简洁五因子评分（趋势/动量/量能/波动/位置，满分 100） */
function scoreStock(klines, quotePrice) {
  const closes = klines.map((k) => k.close);
  if (closes.length < 60) return { score: 0, rating: '数据不足', note: '历史数据不足 60 个交易日' };
  const latest = quotePrice || closes[closes.length - 1];
  let score = 0;
  const notes = [];
  // 趋势 30
  const avg = (arr, n) => arr.slice(-n).reduce((a, b) => a + b, 0) / n;
  const ma5 = avg(closes, 5);
  const ma20 = avg(closes, 20);
  const ma60 = avg(closes, 60);
  if (ma5 > ma20 && ma20 > ma60) {
    score += 22;
    notes.push('均线多头排列');
  } else if (ma5 < ma20 && ma20 < ma60) {
    score += 6;
    notes.push('均线空头排列');
  } else {
    score += 13;
    notes.push('均线纠缠');
  }
  if (latest > ma20) {
    score += 8;
  }
  // 动量 25
  const ret20 = (latest / closes[closes.length - 21] - 1) * 100;
  if (ret20 >= 5 && ret20 <= 25) {
    score += 15;
    notes.push(`近20日涨幅 ${ret20.toFixed(1)}%`);
  } else if (ret20 > 25) {
    score += 7;
    notes.push(`近20日涨幅过大 ${ret20.toFixed(1)}%`);
  } else if (ret20 < -10) {
    score += 7;
    notes.push(`近20日超跌 ${ret20.toFixed(1)}%`);
  } else {
    score += 10;
  }
  const rsiArr = rsiSeries(closes, 14);
  const rsi = rsiArr[rsiArr.length - 1];
  if (rsi !== null && rsi >= 50 && rsi <= 70) {
    score += 10;
    notes.push(`RSI=${rsi.toFixed(1)} 强势区间`);
  } else if (rsi !== null && (rsi > 70 || rsi < 30)) {
    score += 5;
    notes.push(`RSI=${rsi.toFixed(1)} 极端区间`);
  }
  // 量能 15
  const vols = klines.map((k) => k.volume || 0);
  const avgVol5 = avg(vols.slice(-5), 5);
  const avgVol20 = avg(vols.slice(-20, -5), 15);
  const ratio = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;
  if (ratio > 1.3) {
    score += 12;
    notes.push(`量比 ${ratio.toFixed(2)} 放量`);
  } else if (ratio > 1) {
    score += 8;
  } else {
    score += 4;
  }
  // 波动 15
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const recent = rets.slice(-20);
  const m = recent.reduce((a, b) => a + b, 0) / recent.length;
  const variance = recent.reduce((a, b) => a + (b - m) * (b - m), 0) / recent.length;
  const volPct = Math.sqrt(variance) * 100;
  if (volPct >= 1 && volPct <= 3.5) {
    score += 12;
  } else if (volPct < 1) {
    score += 8;
  } else {
    score += 5;
  }
  // 位置 15
  const highs = klines.slice(-250).map((k) => k.high);
  const lows = klines.slice(-250).map((k) => k.low);
  const high52 = Math.max(...highs);
  const low52 = Math.min(...lows);
  const distHigh = ((high52 - latest) / high52) * 100;
  if (distHigh < 10) {
    score += 10;
    notes.push(`距52周高点仅 ${distHigh.toFixed(1)}%`);
  } else if (distHigh < 25) {
    score += 7;
  } else {
    score += 4;
  }
  if (((latest - low52) / low52) * 100 < 15) {
    score += 5;
  }
  const rating = score >= 80 ? '强烈关注' : score >= 65 ? '关注' : score >= 45 ? '中性' : '谨慎';
  return { score, rating, note: notes.join('；') };
}

/** 从问题中提取股票代码/名称 → symbol */
function extractSymbol(q) {
  const upper = q.toUpperCase();
  // 前缀代码：sh600519 / sz000858 / hk00700 / usAAPL
  let m = upper.match(/\b((?:SH|SZ|HK|US)\d{5,6}|(?:SH|SZ|HK|US)[A-Z]{1,6})\b/);
  if (m) {
    const code = m[1];
    if (/^US[A-Z]{1,6}$/.test(code)) return code.slice(2);
    return code.toLowerCase();
  }
  // 6 位 / 5 位数字
  m = upper.match(/\b(\d{6}|\d{5})\b/);
  if (m) return m[1];
  // 英文代码（排除常见疑问词）
  m = upper.match(/\b([A-Z]{2,6})\b/);
  if (m && !['AI', 'MACD', 'RSI', 'ETF', 'CEO'].includes(m[1])) {
    if (US_FALLBACK[m[1]] || /^[A-Z]{2,6}$/.test(m[1])) return m[1];
  }
  // 中文名称反查
  for (const [code, name] of Object.entries(US_FALLBACK)) {
    if (q.includes(name)) return code;
  }
  const CN_NAMES = {
    600519: '贵州茅台',
    300750: '宁德时代',
    '000001': '平安银行',
    601318: '中国平安',
    601899: '紫金矿业',
    002230: '科大讯飞',
  };
  for (const [code, name] of Object.entries(CN_NAMES)) {
    if (q.includes(name)) return code;
  }
  const HK_NAMES = { '00700': '腾讯控股', '09988': '阿里巴巴', '03690': '美团', '01810': '小米' };
  for (const [code, name] of Object.entries(HK_NAMES)) {
    if (q.includes(name)) return code;
  }
  return null;
}

const USAGE_GUIDE = [
  '📖 AI深度量化 使用指南',
  '1. 首页查看市场概况（6 大指数，每 10 秒自动刷新）、我的收藏、今日观察（因子评分）。',
  '2. 在任意搜索框输入股票代码（如 AAPL / 600519 / 00700 / sh000001），进入量化看板：',
  '   K线 + MA5/10/20/60/120/250 + 成交量 + MACD + 形态标注；',
  '   短期副图提供 1/5/15/30/60/120 分钟 K 线（多日真实数据）。',
  '3. 「量化因子分析」页面对个股做五因子（趋势/动量/量能/波动/位置）评分。',
  '4. 「策略回测」页面支持 MA 双均线 / RSI / 买入持有 策略的历史回测。',
  '5. 问我「分析 AAPL」「600519 怎么样」可直接获取个股解读；问「今天观察什么」获取因子评分排名。',
  '6. 数据来源：新浪/腾讯公开行情（无需 API Key），仅供参考，不构成投资建议。',
].join('\n');

/** 生成个股分析报告文本 */
async function analyzeForQA(symbol) {
  const code = toTencentCode(symbol);
  const quote = await getQuoteInternal(code, symbol);
  const klines = await fetchDailyRows(code, 250);
  if (!klines.length) return `⚠️ 未获取到 ${symbol} 的历史数据，请确认代码是否正确。`;
  const closes = klines.map((k) => k.close);
  const latest = quote?.price || closes[closes.length - 1];
  const { score, rating, note } = scoreStock(klines, quote?.price);
  const avg = (arr, n) => (arr.length >= n ? arr.slice(-n).reduce((a, b) => a + b, 0) / n : null);
  const ma5 = avg(closes, 5);
  const ma20 = avg(closes, 20);
  const ma60 = avg(closes, 60);
  const high52 = Math.max(...klines.slice(-250).map((k) => k.high));
  const low52 = Math.min(...klines.slice(-250).map((k) => k.low));
  const lines = [
    `📊 ${symbol}${quote?.name ? `（${quote.name}）` : ''} 快速解读`,
    `最新价: ${latest.toFixed(2)}${quote?.changePercent != null ? `（${quote.changePercent >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%）` : ''}`,
    `MA5: ${ma5?.toFixed(2) ?? '--'} | MA20: ${ma20?.toFixed(2) ?? '--'} | MA60: ${ma60?.toFixed(2) ?? '--'}`,
    `52周区间: ${low52.toFixed(2)} ~ ${high52.toFixed(2)}（现价处于 ${(((latest - low52) / (high52 - low52)) * 100).toFixed(0)}% 分位）`,
    `AI 五因子评分: ${score}/100（${rating}）`,
    note ? `要点: ${note}` : '',
    '⚠️ 以上为量化指标解读，仅供参考，不构成投资建议。',
  ];
  return lines.filter(Boolean).join('\n');
}

/** 内部报价获取（复用缓存） */
async function getQuoteInternal(code, symbol) {
  const cacheKey = `quote:${code}`;
  const cached = getCached(cacheKey, QUOTE_TTL);
  if (cached) return cached;
  try {
    const text = await fetchTencentQuoteText(code);
    const quote = parseTencentQuote(text, symbol);
    if (quote?.price) {
      setCache(cacheKey, quote);
      return quote;
    }
  } catch {
    /* 报价失败不影响分析 */
  }
  return null;
}
app.get('/api/qa', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length > 500) return res.status(413).json({ error: '问题长度不能超过 500 个字符' });
  if (!consumeAiQuota(req, 'qa', AI_QA_LIMIT)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'AI 问答请求过于频繁，请稍后再试' });
  }
  // 降级可观测：已配置云端模型、但本次回答最终由本地引擎兜底时必须显式标注，
  // 否则用户会把规则 / 知识库答案误认为大模型输出（原实现只能靠 engine 字段间接推断）。
  let cloudDegraded = null;
  const reply = (obj) => {
    const answer = typeof obj.answer === 'string' ? obj.answer.slice(0, 12_000) : obj.answer;
    try { brain.recordQA(q, answer, { type: obj.type }); } catch { /* 语料记录失败不阻塞 */ }
    const degraded = obj.degraded || (cloudDegraded && obj.engine !== 'cloud' ? cloudDegraded : undefined);
    return res.json({ ...obj, ...(degraded ? { degraded } : {}), answer });
  };
  if (!q) return reply({ question: q, type: 'empty', answer: '请告诉我你的问题，例如「分析 AAPL」或「平台怎么用？」' });

  // ReAct 工具集（推理引擎按意图调用，避免循环依赖由宿主注入）
  //   knowledgeSearch：结构化知识库（knowledge.cjs，整型分）；入参截断 200 字符防超长查询
  //   marketMood：市场温度计（/api/mood 同源，60s 缓存 + lastGood 兜底，问答路径纯内存读取）
  const tools = {
    analyzeStock: (sym) => analyzeForQA(sym),
    sectorFlow: (t) => sectors.getFlow(t),
    extractSymbol: (s) => extractSymbol(s),
    knowledgeSearch: (query) => knowledgeBase.search(String(query || '').slice(0, 200), { limit: 3 }),
    marketMood: () => screener.getMood(),
  };

  // 自学习知识库命中记录（hit 用于：云端上下文注入 / 高置信直答 / 兜底前中置信降级）
  //   🔴 直答已移到本地技能路由之后（见下）——brain 的 2-gram 模糊匹配会把
  //   「什么是夏普比率」错答成「最大回撤」这类相近词目（实测 34ms 错答），
  //   结构化技能（真实数据 / 带出处知识库）必须优先于模糊匹配。
  const hit = brain.lookup(q);

  // 本地 ReAct 推理引擎（确定性技能优先：个股/板块/情绪/名词解释/大盘）
  //   技能失败时 route 返回 {type:'skill-error', answer:null, degraded}——answer 为 null 不返回，
  //   degraded 记下透传给最终兜底回答（子代理评审 Blocking#4：降级必须用户可见）
  let skillDegraded = null;
  if (typeof reasoning.route === 'function') {
    const routed = await reasoning.route(q, tools);
    if (routed?.answer) return reply({ question: q, type: routed.type, engine: 'reasoner', answer: routed.answer, reasoning: routed.reasoning });
    if (routed?.degraded) skillDegraded = routed.degraded;
  }

  // 高置信学习条目直答（技能未命中时）
  if (hit && hit.score >= 0.7) {
    return reply({
      question: q, type: 'learned', engine: 'knowledge',
      answer: `${hit.entry.a}

（🧠 来自学习知识库 · 匹配置信 ${Math.round(hit.score * 100)}%）`,
    });
  }
  // 云端专家模型优先（ReAct 观察结果注入上下文 → 大模型综合真思考链）
  if (cloudAI.configured()) {
    try {
      const dataCtx = await reasoning.buildCloudContext(q, tools);
      const ctx = [
        { role: 'system', content: process.env.AI_CLOUD_SYSTEM || '你是「AI深度量化」平台的金融研究助手。回答专业、结构化；所有内容为学术研究演示，不构成任何投资建议；拒绝荐股与收益承诺。' },
      ];
      if (dataCtx) ctx.push({ role: 'system', content: dataCtx });
      if (hit) ctx.push({ role: 'system', content: `平台知识库参考（置信 ${Math.round(hit.score * 100)}%）：
${hit.entry.a}` });
      ctx.push({ role: 'user', content: q });
      const out = await cloudAI.chat(ctx, { thinking: 'enabled' });
      if (out?.content) {
        return reply({
          question: q, type: 'cloud', engine: 'cloud',
          answer: out.content,
          reasoning: out.reasoning ?? null,
        });
      }
      cloudDegraded = '云端大模型返回空内容，本次回答已回退本地规则引擎';
    } catch (e) {
      // 云端失败自动回退，但必须留痕：静默降级会让用户误判答案来源
      console.warn('[AI问答] 云端回答失败，回退本地引擎:', String(e?.message || e).slice(0, 80));
      cloudDegraded = '云端大模型调用失败，本次回答已回退本地规则引擎';
    }
  }
  try {
  // 回测指引（优先级高于通用指南：避免「回测怎么用」被使用指南截胡）
    if (/回测|backtest/i.test(q)) {
      return reply({
        question: q,
        type: 'guide',
        answer: [
          '📈 策略回测：',
          '1. 打开「策略回测」页面（首页功能中心或导航）。',
          '2. 输入股票代码，选择策略：MA 双均线（默认 5/20）、RSI 超买超卖（30/70）、买入持有。',
          '3. 设置初始资金，点击「开始回测」查看收益曲线、最大回撤、胜率、交易明细。',
          '回测基于真实历史日 K（新浪/腾讯），含 0.1% 双边手续费，仅供参考。',
        ].join('\n'),
      });
    }
    // 「XX怎么样 / XX如何 / 值得关注吗」句式：含标的信号 → 个股解读
    //   （GUI 检查 Bug4：'600519 怎么样' 曾因 guide 正则 /怎么/ 过宽被使用指南截胡——
    //    快捷问题按钮本身就是这句话，自证踩坑。回测指引已在其上先行，此处分流剩余句式。）
    if (/(怎么样|如何|好不好|值不值得|值得买|值得关注|能买)/.test(q)) {
      const symHow = extractSymbol(q);
      if (symHow) {
        const answer = await analyzeForQA(symHow);
        return reply({ question: q, type: 'analysis', symbol: symHow, answer });
      }
    }
    // 使用指南
    if (/怎么|如何|教程|帮助|使用|操作|入门|指南|help|guide|usage/i.test(q)) {
      return reply({ question: q, type: 'guide', answer: USAGE_GUIDE });
    }
    // 今日观察（五因子评分）
    if (/推荐|选股|观察|机会|评分/i.test(q)) {
      // 并发 4 路评估股票池（原串行实现冷启动可达分钟级）
      const evalOne = async (item) => {
        try {
          const code = toTencentCode(item.symbol);
          const [klines, quote] = await Promise.all([
            fetchDailyRows(code, 250),
            getQuoteInternal(code, item.symbol),
          ]);
          if (!klines.length) return null;
          const { score, rating } = scoreStock(klines, quote?.price);
          return { symbol: item.symbol, name: item.name, price: quote?.price ?? klines[klines.length - 1].close, score, rating };
        } catch {
          return null; /* 单只失败跳过 */
        }
      };
      const results = (await mapPool(QA_POOL.slice(0, 10), 4, evalOne)).filter(Boolean);
      results.sort((a, b) => b.score - a.score);
      const top = results.slice(0, 5);
      const answer = [
        '📊 因子评分观察 Top 5（五因子模型，满分 100）：',
        ...top.map((r, i) => `${i + 1}. ${r.symbol}（${r.name}）现价 ${Number(r.price).toFixed(2)} → ${r.score} 分 · ${r.rating}`),
        '想看某只的详细解读，可以问「分析 <代码>」。',
      ];
      return reply({ question: q, type: 'recommend', answer: answer.join('\n') });
    }
    // 个股分析
    const symbol = extractSymbol(q);
    if (symbol) {
      const answer = await analyzeForQA(symbol);
      return reply({ question: q, type: 'analysis', symbol, answer });
    }
    // 中置信知识库条目（brain.lookup 内部阈值 0.45-0.7）：
    // 让位于 guide/推荐/个股等具体技能分支，兜底前才输出，且强制带"中置信"标注——
    // （子代理评审 Blocking#2：不得让低分学习条目截胡「回测怎么用」这类精心维护的指引）
    if (hit) {
      return reply({
        question: q, type: 'learned', engine: 'knowledge',
        answer: `${hit.entry.a}

（🧠 来自学习知识库 · 匹配置信 ${Math.round(hit.score * 100)}% · 中置信，仅供参考）`,
        ...(skillDegraded ? { degraded: skillDegraded } : {}),
      });
    }
    // 兜底
    return reply({
      question: q,
      type: 'fallback',
      answer: [
        '🤖 我是 AI深度量化 的站内智能助手，可以：',
        '· 「分析 AAPL」—— 个股五因子解读（任何美股/A股/港股代码）',
        '· 「今天观察什么」—— 股票池因子评分排名',
        '· 「市场情绪怎么样」—— 温度计与涨跌结构解读',
        '· 「什么是夏普比率」—— 量化名词解释（带出处）',
        '· 「平台怎么用」—— 使用指南',
        '· 「回测怎么用」—— 策略回测指引',
        '试试输入上面任意一句吧！',
      ].join('\n'),
      ...(skillDegraded ? { degraded: skillDegraded } : {}),
    });
  } catch (e) {
    res.status(500).json({ error: `AI 问答失败: ${e.message?.slice(0, 80)}` });
  }
});

// ───────────── 6b. Agent 团队分析（主理人调度制五阶段流水线） ─────────────
const agentTeam = require('./agents/agents.cjs');
const datafeeds = require('./agents/datafeeds.cjs');
const alerts = require('./paper/alerts.cjs');
const sectors = require('./sectors.cjs');
const screener = require('./screener.cjs');
const watchlist = require('./watchlist.cjs');
const agentReportStore = require('./agents/reportstore.cjs');
const newsStore = require('./newsstore.cjs');
const newsEngine = require('./news/index.cjs');
const knowledgeBase = require('./knowledge.cjs'); // M1：知识库检索（结构化条目 + 出处）
newsStore.init();

// 市场要闻后台刷新：交易时段 3 分钟一次，非交易时段 12 分钟一次，兼顾时效与上游压力
let newsRefreshing = false;
async function refreshMarketNews(force = false) {
  if (newsRefreshing) return;
  newsRefreshing = true;
  try {
    const market = await newsEngine.getMarketNews({ pages: 3, force });
    const fetchedAt = new Date().toISOString();
    const rows = (market || []).map((item) => ({ ...item, category: 'market', sourceType: 'public-media', fetchedAt }));
    if (rows.length) newsStore.merge(rows);
  } catch {
    // 上游失败时保留本地快照，由接口层降级返回
  } finally {
    newsRefreshing = false;
  }
}

function isTradingWindow() {
  const d = new Date();
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const h = d.getHours() + d.getMinutes() / 60;
  return h >= 8.5 && h <= 16.5;
}

function scheduleNewsRefresh() {
  const delay = isTradingWindow() ? 3 * 60_000 : 12 * 60_000;
  const timer = setTimeout(async () => {
    await refreshMarketNews(true).catch(() => {});
    scheduleNewsRefresh();
  }, delay);
  if (timer.unref) timer.unref();
}
scheduleNewsRefresh();
refreshMarketNews(true).catch(() => {});

// 通达信行情通道健康探测（每 30 分钟），结果供运维观测，失败不影响资讯主流程
let tdxHealth = { reachable: 0, total: 0, available: false, checkedAt: null };
async function probeTdx() {
  try {
    tdxHealth = { ...(await newsEngine.sources.tdxChannelHealth()), checkedAt: new Date().toISOString() };
  } catch {
    tdxHealth = { reachable: 0, total: 0, available: false, checkedAt: new Date().toISOString() };
  }
}
setInterval(() => { probeTdx().catch(() => {}); }, 30 * 60_000).unref();
probeTdx().catch(() => {});

/** POST /api/agents/analyze  body: { symbol, mode?: full|quick|debate|risk|single, agent?, entryPrice? }
 *  云端模型可用时启动异步任务（13 角色 LLM 流水线，约 2-4 分钟）返回 jobId；不可用时同步返回规则引擎结果 */
const agentJobs = new Map(); // id -> { id, uid, status, stage, step, total, trace, reportId, error, createdAt }
let agentJobSeq = 0;
// 各模式的角色调用步数，供前端进度条在首个 onProgress 到达前就有正确分母。
// ⚠️ 必须与 agents/llm_pipeline.cjs 的 TOTAL_STEPS 保持一致（quick 为 7 步：4 分析师 + 裁决 + 交易员 + 主理人）。
const AGENT_JOB_MODE_STEPS = { full: 15, quick: 7, debate: 10, risk: 10, single: 1 };
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of agentJobs) {
    if (j.status !== 'running' && now - j.createdAt > 30 * 60_000) agentJobs.delete(id);
    else if (j.status === 'running' && now - j.createdAt > 15 * 60_000) {
      j.status = 'error';
      j.error = '任务超时（15 分钟），已中止';
    }
  }
}, 10 * 60_000).unref();

app.post('/api/agents/analyze', async (req, res) => {
  const body = req.body || {};
  const symbol = String(body.symbol || '').trim();
  if (!symbol) return res.status(400).json({ ok: false, error: '缺少股票代码' });
  const mode = ['full', 'quick', 'debate', 'risk', 'single'].includes(String(body.mode)) ? String(body.mode) : 'full';
  const uid = broker.uidOf(req);
  if (!consumeAiQuota(req, 'agent', AI_AGENT_LIMIT)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ ok: false, error: 'Agent 分析请求过于频繁，请稍后再试' });
  }
  for (const j of agentJobs.values()) {
    if (j.uid === uid && j.status === 'running') {
      return res.status(429).json({ ok: false, error: '当前已有分析任务在运行，请等待其完成后再发起' });
    }
  }
  try {
    const code = toTencentCode(symbol);
    const [klines, quote, feed] = await Promise.all([
      fetchDailyRows(code, 300),
      getQuoteInternal(code, symbol),
      datafeeds.getAll(code),
    ]);
    if (!klines.length) return res.status(404).json({ ok: false, error: `未获取到 ${symbol} 的行情数据` });
    const ctx = { symbol, klines, quote, name: quote?.name, mode, agent: String(body.agent || ''), entryPrice: Number(body.entryPrice) || null, feed, uid };
    // 档位（L1.5）：前端显式下传时按其选择执行；未传则沿用既有行为（向后兼容）。
    //   · rule     —— 直接走规则引擎，不碰云端配额（用户主动选择，不是降级）
    //   · platform —— 走 LLM 流水线（下方管理员闸门 + runtime 校验）
    //   · byok     —— 用户自带 Key 走同一条流水线（2026-10-02 新增）：Key 仅当次请求内存
    //     使用（AsyncLocalStorage 贯通 → cloudAI.chat），不落盘不进日志不进报告；
    //     不消耗平台算力，故不经管理员闸；限流与单任务门与 platform 档一致。
    const reqTier = ['rule', 'platform', 'byok'].includes(String(body.tier)) ? String(body.tier) : null;
    const llmOverride = reqTier === 'byok' ? normalizeByokOverride(body.byok) : null;
    if (reqTier === 'byok' && !llmOverride) {
      return res.status(400).json({
        ok: false,
        tier: 'byok',
        error: 'BYOK 流水线缺少有效的自配信息（需要 base/key/model）。请在「自配 API」面板保存配置后重试。',
        availableTiers: ['rule', 'byok'],
      });
    }
    if (reqTier === 'rule' || (!cloudAI.configured() && !llmOverride)) {
      const trace = await agentTeam.run(ctx); // P3: agents.run async 化（报告保存走 DB 后端）
      return res.json({ ok: true, name: quote?.name, tier: 'rule', ...trace });
    }
    const effTier = llmOverride ? 'byok' : 'platform';
    // ── BYOK 全流水线：不经管理员闸（算力由用户自担）；Vercel 上仅放行 single ──
    if (effTier === 'byok') {
      if (IS_VERCEL && mode !== 'single') {
        return res.status(503).json({
          ok: false,
          tier: 'byok',
          error: 'Vercel Serverless 暂不支持多步 Agent 流水线（full/debate/risk/quick 需多步 LLM 调用，超出函数 30 秒上限）；完整流水线请使用本机版，或改用 single 模式（线上可运行）。',
          availableTiers: ['rule', 'byok'],
        });
      }
      if (IS_VERCEL && mode === 'single') {
        const trace = await llmPipeline.runLLM({ ...ctx, llmOverride, onProgress: () => {} });
        if (!trace) return res.status(502).json({ ok: false, tier: 'byok', error: '流水线调用失败：请核对自配端点与模型名是否可用。' });
        // 报告归档必须在响应返回前 await 完成（Serverless 冻结丢写）
        const reportId = await agentReportStore.saveReport(trace, uid);
        return res.json({ ok: true, name: quote?.name, tier: 'byok', mode, reportId, ...trace });
      }
      // 自托管：落到底部与 platform 档共用的异步任务路径
    } else if (!isAdminReq(req)) {
      return res.status(403).json({
        ok: false,
        tier: 'platform',
        error: '平台 LLM 档位仅管理员可用；你可以使用「规则引擎」（无需 Key）或「自配 API」（在你的浏览器中填入自己的 Key）档位。',
        availableTiers: ['rule', 'byok'],
      });
    }
    if (IS_VERCEL && mode !== 'single') {
      return res.status(503).json({
        ok: false,
        error: 'Vercel Serverless 暂不支持多步 Agent 流水线（full/debate/risk/quick 需多步 LLM 调用，超出函数 30 秒上限）；请使用本机版，或改用 single 模式（单次调用，线上可运行）。',
        availableTiers: ['rule', 'byok'],
      });
    }
    // Vercel + single 放行（P2，2026-09-25）：single 仅 1 次 LLM 调用（llm_pipeline
    // TOTAL_STEPS.single=1），vercel.json functions maxDuration=30 内可同步完成。
    // 响应直接带 trace（含 stages 字段 → 前端识别为同步路径，协议兼容，无需 jobId 轮询）。
    if (IS_VERCEL && mode === 'single') {
      const trace = await llmPipeline.runLLM({ ...ctx, onProgress: () => {} });
      // 报告归档必须在响应返回前 await 完成（Serverless 冻结丢写，P1 同款教训）
      const reportId = await agentReportStore.saveReport(trace, uid);
      return res.json({ ok: true, name: quote?.name, tier: 'platform', mode, reportId, ...trace });
    }
    // 自托管 Node：异步任务留在长生命周期进程内，前端轮询 jobId
    const id = `job-${Date.now().toString(36)}-${++agentJobSeq}`;
    const job = { id, uid, status: 'running', stage: '任务已受理，正在准备数据', step: 0, total: AGENT_JOB_MODE_STEPS[mode] ?? 15, trace: null, reportId: null, error: null, createdAt: Date.now() };
    agentJobs.set(id, job);
    res.json({ ok: true, jobId: id, name: quote?.name });
    llmPipeline
      .runLLM({ ...ctx, llmOverride: llmOverride || undefined, onProgress: (p) => {
        job.step = p.step;
        job.total = p.total || job.total;
        if (p.stage) job.stage = p.stage;
      } })
      .then(async (trace) => {
        if (!trace) throw new Error('LLM 流水线不可用');
        const reportId = await agentReportStore.saveReport(trace, uid); // P3: async 化，await 确保落库后再标记完成
        // 档位回显：前端据此标注「本次实际由 platform/byok 档产出」（L1.5）
        job.trace = { ...trace, reportId, uid, tier: effTier };
        job.reportId = reportId;
        job.status = 'done';
        job.stage = '报告已完成';
      })
      .catch((e) => {
        job.status = 'error';
        job.error = `分析失败: ${String(e?.message || e).slice(0, 100)}`;
      });
  } catch (e) {
    res.status(500).json({ ok: false, error: `Agent 团队分析失败: ${e.message?.slice(0, 80)}` });
  }
});

/** GET /api/agents/job/:id —— 轮询异步分析任务进度 */
app.get('/api/agents/job/:id', (req, res) => {
  const job = agentJobs.get(String(req.params.id));
  if (!job || job.uid !== broker.uidOf(req)) return res.status(404).json({ ok: false, error: '任务不存在或已过期' });
  res.json({
    ok: true,
    status: job.status,
    stage: job.stage,
    step: job.step,
    total: job.total,
    reportId: job.reportId,
    error: job.error,
    trace: job.status === 'done' ? job.trace : null,
  });
});

/** GET /api/agents/report/:id —— 完整报告（含全部 Agent 全文） */
app.get('/api/agents/report/:id', async (req, res) => {
  const r = await agentReportStore.getReport(req.params.id); // P3: async（DB 优先/文件兜底）
  if (!r || r.uid !== broker.uidOf(req)) return res.status(404).json({ ok: false, error: '报告不存在或已过期' });
  res.json({ ok: true, report: r });
});

/** GET /api/agents/reports —— 历史报告列表 */
app.get('/api/agents/reports', async (req, res) => {
  try {
    const list = await agentReportStore.listReports({ symbol: req.query.symbol, limit: Number(req.query.limit) || 20, uid: broker.uidOf(req) });
    res.json({ ok: true, list });
  } catch (e) {
    res.status(500).json({ ok: false, error: `报告列表查询失败: ${e.message?.slice(0, 80)}` });
  }
});

/** DELETE /api/agents/reports/:id —— 删除自己的历史报告 */
app.delete('/api/agents/reports/:id', async (req, res) => {
  const r = await agentReportStore.deleteReport(String(req.params.id), broker.uidOf(req));
  res.status(r.ok ? 200 : r.error?.includes('无权') ? 403 : 404).json(r);
});

// ───────────── 6b. 板块与资讯域路由（已拆分至 server/routes/sectors-news.cjs，行为零变化） ─────────────
require('./routes/sectors-news.cjs').registerSectorsNewsRoutes(app, {
  axios,
  UA,
  sectors,
  datafeeds,
  newsEngine,
  newsStore,
  toTencentCode,
  getTdxHealth: () => tdxHealth,
});

// ───────────── 6c. AI 助手学习系统（知识库 / 反馈 / 教学 / 自训练） ─────────────

/**
 * 管理员判定（单一实现，L1.3 抽取）。
 *   · AUTH_ENABLED=false（未设 SITE_PASSWORD）视为**未启用鉴权**：本机单用户场景，
 *     此时 req.user 为 undefined，若沿用 `req.user.username !== SITE_USERNAME` 会把
 *     管理员自己挡在门外——这是抽取前两处调用点共有的缺陷。
 *   · AUTH_ENABLED=true：仅 SITE_USERNAME 归属者算管理员。
 * 供 /api/ai/teach、/api/ai/stats、/api/agents/capabilities 与 T3 闸门共用。
 */
function isAdminReq(req) {
  if (!AUTH_ENABLED) return true;
  return req.user?.username === SITE_USERNAME;
}

/** POST /api/ai/feedback —— 点赞/点踩，实时调整知识权重 */
app.post('/api/ai/feedback', (req, res) => {
  const { question, answer, rating, comment } = req.body || {};
  if (!['up', 'down'].includes(rating)) return res.status(400).json({ ok: false, error: 'rating 必须为 up/down' });
  res.json(brain.recordFeedback({ question, answer, rating, comment }));
});

/** POST /api/ai/teach —— 用户教学：直接写入知识库 */
app.post('/api/ai/teach', (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ ok: false, error: '仅管理员可教学' });
  const { q, a } = req.body || {};
  const r = brain.addEntry(q, a, 'user');
  res.status(r.ok ? 200 : 400).json(r);
});

/** GET /api/ai/stats —— 知识库规模 / 训练状态 */
app.get('/api/ai/stats', (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ ok: false, error: '仅管理员可查看学习统计' });
  res.json({ ok: true, ...brain.stats() });
});

/**
 * GET /api/agents/capabilities —— Agent 能力档位（规则引擎 / 自配 API / 平台 LLM）
 *
 *   前端据此渲染档位选择器：前两档对所有登录用户开放；平台 LLM 仅管理员可见。
 *   同时透出 runtime，使**公网演示版上不可用的模式能被前端明确置灰**
 *   （而非等用户点了才报 503）——符合项目「降级必须可见」铁律。
 *   本端点为**纯声明**，不消耗任何 LLM 配额、不触发外部请求。
 *
 * ⚠️ 对外文案纪律（2026-09-22 自查）：`runtime` 取值与置灰 `reason` **都会原样到达客户端**，
 *   故此处不得出现部署平台、运行环境、函数时限、步数、本地版等实现细节。
 *   取值改用 'public' / 'full'，不带任何平台含义。
 */
app.get('/api/agents/capabilities', (req, res) => {
  const admin = isAdminReq(req);
  const runtime = IS_VERCEL ? 'public' : 'full';
  // 各模式在公网演示版下是否可跑：按"单步能否在受限时间内完成"判定
  const modeSteps = AGENT_JOB_MODE_STEPS;
  const modeSafe = IS_VERCEL ? 1 : Number.POSITIVE_INFINITY;
  res.json({
    ok: true,
    runtime,
    tiers: [
      { key: 'rule', available: true, platformLLM: false, label: '规则引擎' },
      { key: 'byok', available: true, platformLLM: false, label: '自配 API' },
      { key: 'platform', available: admin, platformLLM: true, label: '平台 LLM', adminOnly: true },
    ],
    /** 按档位给出各模式可用性：仅平台 LLM 档受长任务限制 */
    modes: Object.fromEntries(
      Object.entries(modeSteps).map(([m, steps]) => [
        m,
        steps <= modeSafe
          ? { available: true }
          : {
            available: false,
            reason: `该模式需 ${steps} 步分析，耗时长于公网演示版的处理上限；请改用「规则引擎」档获得完整的确定性分析`,
          },
      ]),
    ),
    hints: {
      byok: '使用你自己的 API Key：请求由浏览器直接发往供应商，不经过本站服务器，本站不保存你的 Key。',
      platform: '使用平台预置云端模型，仅管理员可用。',
    },
  });
});


// ───────────── 7. 健康检查 ─────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    name: `${APP_NAME}数据服务`,
    version: APP_VERSION,
    uptime: Math.floor(process.uptime()),
    cacheSize: cache.size,
    staticMode: fs.existsSync(path.join(__dirname, '..', 'dist', 'index.html')),
    maintainWindow: !NO_MAINTAIN,
    time: new Date().toISOString(),
  });
});

// ───────────── 8. 自检维护（每日 02:00–03:00） ─────────────
const REPORTS_DIR = path.join(__dirname, '..', 'reports');

/** 执行一次完整自检，返回报告对象 */
async function runMaintenance() {
  const report = {
    app: APP_NAME,
    version: APP_VERSION,
    startedAt: new Date().toISOString(),
    checks: [],
    summary: { total: 0, passed: 0, failed: 0 },
    issues: [],
  };
  const add = (name, ok, detail = '') => {
    report.checks.push({ name, ok, detail: String(detail).slice(0, 300), at: new Date().toISOString() });
    report.summary.total += 1;
    if (ok) report.summary.passed += 1;
    else {
      report.summary.failed += 1;
      report.issues.push(`${name}: ${String(detail).slice(0, 200)}`);
    }
  };

  // 1) 代码语法扫描（node --check 每个服务端文件）
  const serverDir = path.join(__dirname, '..', 'server');
  try {
    const files = fs.readdirSync(serverDir).filter((f) => /\.(cjs|js|mjs)$/.test(f));
    let allOk = true;
    const details = [];
    for (const f of files) {
      try {
        execFileSync(process.execPath, ['--check', path.join(serverDir, f)], { stdio: 'pipe' });
        details.push(`${f} ✓`);
      } catch (e) {
        allOk = false;
        details.push(`${f} ✗ ${String(e.message).slice(0, 80)}`);
      }
    }
    add('代码语法扫描', allOk, details.join('；'));
  } catch (e) {
    add('代码语法扫描', false, e.message);
  }

  // 2) dist 产物完整性
  try {
    const dist = path.join(__dirname, '..', 'dist');
    const idx = path.join(dist, 'index.html');
    const ok = fs.existsSync(idx) && fs.statSync(idx).size > 500;
    add('前端产物完整性', ok, ok ? `dist/index.html ${fs.statSync(idx).size} 字节` : 'dist/index.html 缺失或过小');
  } catch (e) {
    add('前端产物完整性', false, e.message);
  }

  // 3) 接口冒烟测试（站点密码启用时自动携带认证头）
  //    · 上游数据源（新浪/腾讯/东财）偶发抖动：失败自动重试 1 次
  //    · /api/qa 走云端大模型常见 30s+，单独放宽到 90s，避免每日误报
  const base = `http://127.0.0.1:${PORT}`;
  const smoke = async (pathName, validate, timeoutMs = 10000) => {
    const attempt = async () => {
      try {
        const res = await axios.get(base + pathName, { timeout: timeoutMs, headers: authHeaderValue() });
        return { ok: validate(res.data), detail: '' };
      } catch (e) {
        return { ok: false, detail: `HTTP 失败: ${e.message?.slice(0, 60)}` };
      }
    };
    let r = await attempt();
    if (!r.ok) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const r2 = await attempt();
      if (r2.ok) r = r2;
      else r.detail = r.detail || r2.detail;
    }
    return { ok: r.ok, detail: r.ok ? 'OK' : r.detail || '数据校验失败' };
  };
  const s1 = await smoke('/api/health', (d) => d?.ok === true);
  add('冒烟: /api/health', s1.ok, s1.detail);
  const s2 = await smoke('/api/indices', (d) => Array.isArray(d) && d.length >= 4 && d.every((i) => Number.isFinite(i.price)));
  add('冒烟: /api/indices', s2.ok, s2.detail);
  const s3 = await smoke('/api/quote/AAPL', (d) => Number.isFinite(d?.price) && d.price > 0);
  add('冒烟: /api/quote/AAPL', s3.ok, s3.detail);
  const s4 = await smoke('/api/history/MSFT?count=30', (d) => Array.isArray(d?.klines) && d.klines.length >= 20);
  add('冒烟: /api/history/MSFT', s4.ok, s4.detail);
  const s5 = await smoke('/api/minute/sh600519', (d) => Array.isArray(d?.points) && d.points.length > 50);
  add('冒烟: /api/minute/sh600519', s5.ok, s5.detail);
  const s6 = await smoke('/api/mkline/sh600519?period=m5&count=20', (d) => Array.isArray(d?.klines) && d.klines.length >= 10);
  add('冒烟: /api/mkline/sh600519(m5)', s6.ok, s6.detail);
  const s7 = await smoke('/api/backtest?symbol=AAPL&strategy=ma&count=120', (d) => Number.isFinite(d?.totalReturn) && Array.isArray(d?.equity));
  add('冒烟: /api/backtest/AAPL', s7.ok, s7.detail);
  const s8 = await smoke(`/api/qa?q=${encodeURIComponent('平台怎么用')}`, (d) => typeof d?.answer === 'string' && d.answer.length > 10, 90_000);
  add('冒烟: /api/qa', s8.ok, s8.detail);

  // 4) 数据质量三断言（评审 P1-5）：本地归档抽样校验 OHLC 有效性 / 涨跌幅越界 / 交易日缺口
  try {
    const { checkKlines, findMissingDays } = require('./dataquality.cjs');
    const { localArchiveInfo } = require('./localstore.cjs');
    const info = localArchiveInfo();
    const dqIssues = [];
    if (info.count > 0) {
      const kdir = path.join(__dirname, '..', 'data', 'history', 'kline');
      const files = fs.readdirSync(kdir).filter((f) => f.endsWith('.json')).slice(0, 5);
      for (const f of files) {
        const doc = JSON.parse(fs.readFileSync(path.join(kdir, f), 'utf8'));
        const rows = (doc.rows || []).slice(-250);
        const sym = doc.code || f.replace('.json', '');
        dqIssues.push(...checkKlines(rows, { symbol: sym, pctCap: 31 }).map((x) => x.detail));
        const missing = findMissingDays(rows);
        if (missing.length) {
          dqIssues.push(`${sym} 缺 ${missing.length} 个交易日: ${missing.slice(0, 5).join(',')}${missing.length > 5 ? '…' : ''}`);
        }
      }
    }
    add(
      `数据质量三断言（归档 ${info.count} 只）`,
      dqIssues.length === 0,
      dqIssues.length === 0
        ? info.count === 0
          ? '本地归档为空（Baostock 同步未运行），跳过抽样'
          : `抽样 ${Math.min(info.count, 5)} 只全部通过`
        : dqIssues.slice(0, 8).join('；'),
    );
  } catch (e) {
    add('数据质量三断言', false, e.message);
  }

  // 5) 每日账实对账（评审 P2-3）：冻结账实相符 / 订单状态一致 / 基本不变量
  try {
    const { reconcileAll } = require('./paper/reconcile.cjs');
    const rec = reconcileAll(broker.store);
    add(
      '每日账实对账',
      rec.ok,
      rec.ok ? `${rec.accounts} 个账户全部通过` : `${rec.issueCount} 项不符: ${Object.entries(rec.issues).map(([uid, arr]) => `${uid}: ${arr[0]}${arr.length > 1 ? ` 等${arr.length}项` : ''}`).join('；').slice(0, 200)}`,
    );
  } catch (e) {
    add('每日账实对账', false, e.message);
  }

  // 6) 一致性报告（评审 P2-4）：回测 vs 模拟盘三指标 + 衰减信号，落盘 reports/consistency-latest.json
  try {
    const report = await require('./paper/consistency.cjs').buildReport({
      strategies: strategies.all(),
      windowDays: 30,
      fetchDailyRows,
      toTencentCode,
    });
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORTS_DIR, 'consistency-latest.json'), JSON.stringify(report, null, 2), 'utf8');
    const withTrades = report.strategies.filter((s) => s.paper.closedTrades > 0).length;
    add(
      '一致性报告',
      report.decayCount === 0,
      `${report.strategyCount} 个策略（${withTrades} 个有成交），衰减信号 ${report.decayCount} 个`,
    );
  } catch (e) {
    add('一致性报告', false, e.message);
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - new Date(report.startedAt).getTime();

  // 写报告
  try {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(REPORTS_DIR, `maintenance-${day}.json`),
      JSON.stringify(report, null, 2),
      'utf8',
    );
    fs.writeFileSync(path.join(REPORTS_DIR, 'maintenance-latest.json'), JSON.stringify(report, null, 2), 'utf8');
    fs.appendFileSync(
      path.join(REPORTS_DIR, 'maintenance.log'),
      `[${report.startedAt}] 自检完成: ${report.summary.passed}/${report.summary.total} 通过${report.issues.length ? `，问题: ${report.issues.join(' | ')}` : ''}\n`,
      'utf8',
    );
  } catch (e) {
    console.error('写自检报告失败:', e.message);
  }
  console.log(
    `🔧 [自检] ${report.summary.passed}/${report.summary.total} 项通过` +
      (report.issues.length ? ` | 问题: ${report.issues.join(' | ')}` : ' | 全部正常 ✓'),
  );
  return report;
}

// 自检调度：每日 02:00–03:00 窗口执行一次（本地服务运行期间生效；
// 服务关闭期间由 Windows 计划任务 register-maintenance.bat 兜底；Vercel 环境不启用）
if (!NO_MAINTAIN && !MAINTAIN_ONCE && !IS_VERCEL) {
  let lastMaintainDay = '';
  setInterval(() => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() === 2 && lastMaintainDay !== day) {
      lastMaintainDay = day;
      console.log(`🔧 [自检] 进入每日 02:00–03:00 维护窗口，开始自检...`);
      runMaintenance()
        .then(() => {
          try {
            const r = brain.nightlyTrain();
            console.log(`🧠 [AI自训练] 完成: 提升 ${r.promoted} / 降权 ${r.demoted} / 剪枝 ${r.pruned} / 待学习 +${r.pendingAdded}`);
          } catch (e2) {
            console.error('[AI自训练] 失败:', e2.message);
          }
        })
        .catch((e) => console.error('[自检] 执行失败:', e.message));
    }
  }, 60_000).unref();
  console.log('🔧 每日 02:00–03:00 自检调度已开启（--no-maintain 可关闭）');
}

// ───────────── 8b. 模拟交易域路由（已拆分至 server/routes/paper.cjs，行为零变化） ─────────────
// broker/strategies 的 require 留守宿主：Agent 域（uidOf）与自检域（store/all）仍在使用。
const broker = require('./paper/broker.cjs');
const strategies = require('./paper/strategies.cjs');
require('./routes/paper.cjs').registerPaperRoutes(app, {
  broker,
  strategies,
  alerts,
  watchlist,
  getQuoteInternal,
  fetchDailyRows,
  toTencentCode,
  IS_VERCEL,
  MAINTAIN_ONCE,
  axios,
  UA,
  sectors,
});

// ───────────── 8c. 知识/选股/自选域路由（已拆分至 server/routes/knowledge-screener.cjs，行为零变化） ─────────────
// knowledgeBase/screener 的 require 留守宿主：AI 问答工具注册（knowledgeSearch/marketMood）仍在使用。
require('./routes/knowledge-screener.cjs').registerKnowledgeScreenerRoutes(app, {
  knowledgeBase,
  screener,
  watchlist,
  broker,
});
// ───────────── 9. 静态托管（生产模式：单端口整站） ─────────────
const DIST_DIR = path.join(__dirname, '..', 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

if (fs.existsSync(DIST_DIR)) {
  // gzip 预压缩资源优先（vite-plugin-compression 产物）
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    const enc = (req.headers['accept-encoding'] || '').includes('gzip');
    if (!enc) return next();
    const file = path.join(DIST_DIR, req.path);
    if (fs.existsSync(`${file}.gz`)) {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
      return res.sendFile(`${file}.gz`);
    }
    next();
  });
  app.use(express.static(DIST_DIR));
  // SPA 路由回退（/stock/MSFT、/backtest、/assistant 等前端路由）
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

// 404 兜底（API 未命中）
app.use('/api', (req, res) => {
  res.status(404).json({ error: `接口不存在: ${req.method} ${req.path}` });
});

// 全局错误中间件（必须最后注册）：此前部分路由无 try/catch，漏抛异常会走
// Express 默认 handler 返回 HTML 500，破坏前端 JSON 契约；且 unhandledRejection
// 只记日志不退出，半损坏状态可能持续对外服务——这里至少保证错误响应可解析。
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[Server] 路由异常:', req?.method, req?.path, err?.stack || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: `服务器内部错误: ${String(err?.message || err).slice(0, 120)}` });
});

// ───────────── 导出 / 启动 ─────────────
// 通用模式：
//   · Vercel Serverless：api/index.js import 本模块并导出 app（require.main 为打包入口，不会触发 listen）
//   · 本地直接运行：node server/index.cjs → require.main === module → 监听端口
//   · 自检模式：node server/index.cjs --maintain-once → 执行一次自检后退出
if (require.main === module) {
  if (MAINTAIN_ONCE) {
    // 仅执行一次自检后退出（供 Windows 计划任务使用）
    runMaintenance()
      .then(() => process.exit(0))
      .catch((e) => {
        console.error('[自检] 执行失败:', e.message);
        process.exit(1);
      });
  } else {
    app.listen(PORT, () => {
      // 本机局域网地址列表（服务默认监听所有网卡，手机/平板可访问）
      const nets = os.networkInterfaces();
      const addrs = [];
      for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
          if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
        }
      }
      console.log(`🚀 ${APP_NAME} 已启动: http://127.0.0.1:${PORT}  (v${APP_VERSION})`);
      console.log(`   - 本机打开:   http://127.0.0.1:${PORT}/`);
      if (addrs.length) {
        console.log(`   - 局域网打开: http://${addrs[0]}:${PORT}/（手机/其他电脑同一 WiFi 下可访问）`);
      }
      console.log(`   - 整站页面:   http://127.0.0.1:${PORT}/`);
      console.log(`   - 实时报价:   http://127.0.0.1:${PORT}/api/quote/sh600519`);
      console.log(`   - 历史K线:    http://127.0.0.1:${PORT}/api/history/sh600519`);
      console.log(`   - 分钟K线:    http://127.0.0.1:${PORT}/api/mkline/sh600519?period=m5`);
      console.log(`   - 大盘指数:   http://127.0.0.1:${PORT}/api/indices`);
      console.log(`   - 策略回测:   http://127.0.0.1:${PORT}/api/backtest?symbol=AAPL`);
      console.log(`   - AI问答:     http://127.0.0.1:${PORT}/api/qa?q=分析AAPL`);
      console.log(`   - 搜索:       http://127.0.0.1:${PORT}/api/search/茅台`);
      console.log(`   - 健康检查:   http://127.0.0.1:${PORT}/api/health`);
      console.log(`   - 自检:       node server/index.cjs --maintain-once`);
      if (!fs.existsSync(DIST_DIR)) {
        console.warn('⚠️ 未检测到 dist/ 前端产物：请先运行 npm run build（或 npm start 一键构建启动）');
      }
    });
  }
}

// 导出 Express 应用（Vercel / ESM 包装复用）
module.exports = app;
// 兼容 esbuild 打包（@vercel/node）：CJS→ESM 互操作需要 default 命名导出
module.exports.default = app;
