'use strict';
// ─────────────────────────────────────────────────────────────
// 归档索引与数据质量（Phase 2 · 数据治理）
//
//   一次扫描同时产出两件事：
//     · **数据版本指纹**（digest）—— "这次结论是拿哪一版数据算的"
//     · **数据质量体检**—— 覆盖/缺失/口径退化/异常，以及已知问题清单
//
//   🔴 为什么需要数据版本（这是复现承诺上的一个真洞）：
//     现有 `fingerprint` 由「引擎版本 + 数据窗口(start/end) + 池子规模 + 运行参数」构成，
//     **不含数据内容**。归档每日同步、可追加可修正 ⇒ 同一个指纹完全可能对应两份不同的数据，
//     于是"同指纹 ⇒ 同结果"在某些情形下并不成立。数据版本指纹补上这一环：
//     结论 + 引擎版本 + **数据版本** 才是完整的复现三件套。
//
//   ⚠️ 本模块**不改** `runModel` 的 fingerprint 构成 —— 那会让历史实验记录（Postgres 里已有的
//      fingerprint）与重算值全部对不上。数据版本只作为**新增字段**附带，属加法演进。
//
//   口径单一源：归档目录取 `crosssect.resolveArchiveDir()`；入池门槛取 `crosssect.UNIVERSE_MIN_ROWS`；
//   逐行可用性过滤与复权退化判定复用 `crosssect` 的实现（不另写一份）。
// ─────────────────────────────────────────────────────────────
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const crosssect = require('./crosssect.cjs');

/** 索引算法自述（随结果返回，便于事后核对"这串指纹是怎么来的"） */
const INDEX_ALGORITHM =
  'sha256(按 code 升序拼接「code|行数|首日|末日|因子摘要|逐行字段摘要」)；逐行摘要覆盖 date/open/high/low/close/volume/amount/turn/pctChg';

const CACHE_TTL_MS = 10 * 60 * 1000;
let _cache = null; // { signature, at, index }

/**
 * 数据层面的**已知问题清单**（单一源）。
 * 与 `validation.LIMITATIONS` 的分工：这里只讲**数据**本身的事实（可从归档验证），
 * 那里讲**结论**的适用边界。研究包会把两份都带上，避免任一处被漏读。
 */
const DATA_ISSUES = [
  '仅核心股票池（非全市场）；**退市股未入归档** ⇒ 存在幸存者偏差，历史表现偏乐观',
  `入池门槛按**全期**行数（≥ ${crosssect.UNIVERSE_MIN_ROWS}）判定 ⇒ 池子构成含未来信息（"事后选池"的轻微 as-of 偏差）`,
  '无复权因子覆盖的行退化为**不复权**口径（adjFallback）⇒ 该标的在除权日的动量可能出现假跳空',
  '归档为**日线**（无 tick 与时间戳）⇒ 日内级信息泄露物理上不可检（该风险由引擎源码契约兜底）',
  '归档不含股票名 ⇒ ST 股的 5% 限幅无法识别，涨跌停守卫按 10% 判定（偏松）',
];

/** 目录签名：文件名集合 + 各自 mtime/size 的摘要。比单纯 TTL 更准（归档每日同步一次）。 */
function dirSignature(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  const h = crypto.createHash('sha256');
  for (const f of [...files].sort()) {
    let st = null;
    try {
      st = fs.statSync(path.join(dir, f));
    } catch {
      /* 读不到就当 0 */
    }
    h.update(`${f}|${st ? st.size : 0}|${st ? st.mtimeMs : 0}\n`);
  }
  return { sig: h.digest('hex'), files };
}

const FIELD_KEYS = ['date', 'open', 'high', 'low', 'close', 'volume', 'amount', 'turn', 'pctChg'];

/** 单只标的的体检 + 内容摘要 */
function scanSymbol(dir, file) {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const code = doc.code || file.replace('.json', '');
  const allRows = Array.isArray(doc.rows) ? doc.rows : [];
  const factors = Array.isArray(doc.factors) ? doc.factors : [];

  // 与引擎完全同源的可用性过滤（loadUniverse 的判据）
  const usable = allRows.filter(
    (r) => r.date && Number.isFinite(r.close) && Number.isFinite(r.open) && r.close > 0 && r.open > 0,
  );
  // 复权退化判定复用引擎实现（原地补 adjClose/adjOpen，可能置 adjFallback）
  crosssect.withAdjustedPrices(usable, factors);

  const missing = {};
  for (const k of FIELD_KEYS) {
    if (k === 'date') continue; // date 是可用性过滤的前提，缺失行已被剔除
    let n = 0;
    for (const r of usable) if (!Number.isFinite(r[k])) n += 1;
    if (n) missing[k] = n;
  }
  let badPriceRows = 0; // 高开低收为负或高低倒挂等结构异常
  for (const r of usable) {
    if (
      (Number.isFinite(r.high) && r.high < 0) ||
      (Number.isFinite(r.low) && r.low < 0) ||
      (Number.isFinite(r.high) && Number.isFinite(r.low) && r.high < r.low)
    ) {
      badPriceRows += 1;
    }
  }
  const seen = new Set();
  let duplicateDates = 0;
  for (const r of usable) {
    const d = String(r.date);
    if (seen.has(d)) duplicateDates += 1;
    else seen.add(d);
  }
  let adjFallbackRows = 0;
  for (const r of usable) if (r.adjFallback) adjFallbackRows += 1;

  // 内容摘要：逐行拼接字段（增量 update，避免把 30MB 串起来）
  const h = crypto.createHash('sha256');
  for (const r of usable) {
    for (const k of FIELD_KEYS) h.update(String(r[k]));
    h.update('\n');
  }
  const rowsDigest = h.digest('hex');
  const fh = crypto.createHash('sha256');
  for (const f of factors) fh.update(`${f.date}|${f.fore}|${f.back}\n`);
  const factorsDigest = fh.digest('hex');

  return {
    code,
    file,
    rows: allRows.length,
    rowsUsable: usable.length,
    rowsDropped: allRows.length - usable.length,
    firstDate: usable.length ? String(usable[0].date) : null,
    lastDate: usable.length ? String(usable[usable.length - 1].date) : null,
    factorsCount: factors.length,
    adjFallbackRows,
    missing,
    badPriceRows,
    duplicateDates,
    inPool: usable.length >= crosssect.UNIVERSE_MIN_ROWS,
    /** 供总指纹使用（不出现在对外列表里，避免响应体膨胀） */
    rowsDigest,
    factorsDigest,
  };
}

function sumCounts(list, pick) {
  const out = {};
  for (const s of list) {
    for (const [k, v] of Object.entries(pick(s) || {})) out[k] = (out[k] || 0) + v;
  }
  return out;
}

const ROOT_KEYS = ['code', 'file', 'rows', 'rowsUsable', 'rowsDropped', 'firstDate', 'lastDate', 'factorsCount', 'adjFallbackRows', 'missing', 'badPriceRows', 'duplicateDates', 'inPool', 'rowsDigest', 'factorsDigest'];

/**
 * 构建归档索引（带缓存）。
 * @param {string} [dir] 归档目录（缺省取 crosssect.resolveArchiveDir()）
 * @param {{force?:boolean, ttlMs?:number}} [opts]
 */
function buildArchiveIndex(dir, opts = {}) {
  // 单参形式 `buildArchiveIndex({ force: true })`：第一参是对象时视为 opts。
  // 若不做这层识别，`{force:true}` 会被当成目录名 ⇒ 静默返回 ok:false（调用方随后读 .version 才崩）。
  // 显式拒绝比静默失败好 —— 这正是本项目"禁静默降级"的要求。
  if (dir && typeof dir === 'object') {
    opts = dir;
    dir = null;
  }
  const target = dir || crosssect.resolveArchiveDir();
  const ttl = Number.isFinite(opts.ttlMs) ? opts.ttlMs : CACHE_TTL_MS;
  const sig = dirSignature(target);
  if (!sig) {
    return {
      ok: false,
      // ⚠️ 错误信息**不得**含归档目录的绝对路径（公开仓库/公网红线）；只描述来源形态
      error: `归档目录不存在或不可读（来源：${
        process.env.LOCAL_HISTORY_DIR ? 'LOCAL_HISTORY_DIR 环境变量' : '默认数据目录'
      }）`,
      source: process.env.LOCAL_HISTORY_DIR ? 'env-override' : 'default',
      algorithm: INDEX_ALGORITHM,
      issues: DATA_ISSUES,
    };
  }
  if (
    !opts.force &&
    _cache &&
    _cache.dir === target &&
    _cache.signature === sig.sig &&
    Date.now() - _cache.at < ttl
  ) {
    return { ..._cache.index, cached: true };
  }

  const symbols = [];
  const badFiles = [];
  for (const f of [...sig.files].sort()) {
    try {
      symbols.push(scanSymbol(target, f));
    } catch (e) {
      badFiles.push({ file: f, error: String((e && e.message) || e).slice(0, 80) });
    }
  }

  // 总指纹：按 code 升序（与文件顺序无关），逐只拼一行再 hash
  const total = crypto.createHash('sha256');
  for (const s of [...symbols].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))) {
    total.update(`${s.code}|${s.rowsUsable}|${s.firstDate || ''}|${s.lastDate || ''}|${s.factorsDigest}|${s.rowsDigest}\n`);
  }
  const digest = total.digest('hex');

  const rowsUsable = symbols.reduce((a, s) => a + s.rowsUsable, 0);
  const rowsTotal = symbols.reduce((a, s) => a + s.rows, 0);
  const firstDate = symbols.reduce((a, s) => (s.firstDate && (!a || s.firstDate < a) ? s.firstDate : a), null);
  const lastDate = symbols.reduce((a, s) => (s.lastDate && (!a || s.lastDate > a) ? s.lastDate : a), null);
  const missingTotals = sumCounts(symbols, (s) => s.missing);
  const symbolsWithMissing = {};
  for (const s of symbols) for (const k of Object.keys(s.missing || {})) symbolsWithMissing[k] = (symbolsWithMissing[k] || 0) + 1;

  const buckets = { '<80': 0, '80-249': 0, '250-999': 0, '1000-1999': 0, '>=2000': 0 };
  for (const s of symbols) {
    const n = s.rowsUsable;
    if (n < 80) buckets['<80'] += 1;
    else if (n < 250) buckets['80-249'] += 1;
    else if (n < 1000) buckets['250-999'] += 1;
    else if (n < 2000) buckets['1000-1999'] += 1;
    else buckets['>=2000'] += 1;
  }

  // 新鲜度：归档最后交易日距"计算时刻"的自然日数（⚠️ 依赖运行时刻，故随结果标注）
  let lastDateAgeDays = null;
  if (lastDate) {
    const t = Date.parse(`${lastDate}T00:00:00Z`);
    if (Number.isFinite(t)) lastDateAgeDays = Math.max(0, Math.round((Date.now() - t) / 86400000));
  }

  const index = {
    ok: true,
    algorithm: INDEX_ALGORITHM,
    /** 数据源形态（**不暴露绝对路径** —— 公开仓库/公网都不该出现本机路径） */
    source: process.env.LOCAL_HISTORY_DIR ? 'env-override' : 'default',
    version: {
      digest,
      stocks: symbols.length,
      rows: rowsUsable,
      firstDate,
      lastDate,
      poolStocks: symbols.filter((s) => s.inPool).length,
      poolMinRows: crosssect.UNIVERSE_MIN_ROWS,
    },
    quality: {
      filesRead: sig.files.length,
      filesBad: badFiles.length,
      badFiles,
      rowsTotal,
      rowsUsable,
      rowsDropped: rowsTotal - rowsUsable,
      missingTotals,
      symbolsWithMissing,
      adjFallbackRows: symbols.reduce((a, s) => a + s.adjFallbackRows, 0),
      symbolsWithAdjFallback: symbols.filter((s) => s.adjFallbackRows > 0).length,
      badPriceRows: symbols.reduce((a, s) => a + s.badPriceRows, 0),
      duplicateDates: symbols.reduce((a, s) => a + s.duplicateDates, 0),
      belowPoolMinRows: buckets['<80'],
      coverageBuckets: buckets,
      lastDateAgeDays,
      lastDateAgeNote: '按计算时刻与归档最后交易日的自然日差（周末/假期会自然偏大）',
    },
    /** 逐只明细（默认不含内容摘要，避免响应体膨胀；需要时传 withDigests） */
    symbols: opts.withDigests ? symbols : symbols.map((s) => {
      const o = {};
      for (const k of ROOT_KEYS) if (k !== 'rowsDigest' && k !== 'factorsDigest') o[k] = s[k];
      return o;
    }),
    issues: DATA_ISSUES,
    computedAt: new Date().toISOString(),
    cached: false,
  };

  _cache = { dir: target, signature: sig.sig, at: Date.now(), index };
  return index;
}

/**
 * 只读缓存里的数据版本（**不触发计算**）。
 * 给热路径用：`runModel` 每次回测都算一遍 90MB 的摘要不可接受，
 * 但若索引已经在缓存里，顺手带上数据版本几乎零成本。
 */
function peekArchiveVersion() {
  if (!_cache || !_cache.index || _cache.index.ok !== true) return null;
  if (Date.now() - _cache.at > CACHE_TTL_MS) return null;
  return _cache.index.version.digest;
}

/** 清缓存（测试与归档同步后调用） */
function invalidateArchiveIndex() {
  _cache = null;
}

module.exports = {
  INDEX_ALGORITHM,
  DATA_ISSUES,
  buildArchiveIndex,
  peekArchiveVersion,
  invalidateArchiveIndex,
  dirSignature,
};
