// ─────────────────────────────────────────────────────────────
// 实验管理最小版（评审 P1-7 / 路线图 1-3 月）
//   · 每次回测自动追加一条实验记录（参数+数据区间+口径+指标全集），可复现可对比
//   · 存储：data/experiments.jsonl 追加写（O(1)，热路径不做全量 IO——项目约定）；
//     超 5MB 整文件轮转归档一次
//   · 测试可用环境变量 EXPERIMENTS_FILE 覆盖路径
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { normalizeSymbol } = require('./symbolnorm.cjs');

const FILE = () => process.env.EXPERIMENTS_FILE || path.join(__dirname, '..', 'data', 'experiments.jsonl');
const ROTATE_BYTES = 5 * 1024 * 1024;
const MAX_THUMB = 60;

/**
 * 等间隔降采样净值曲线到最多 MAX_THUMB 点，强制保留首点与末点。
 * 原点数 ≤ MAX_THUMB 时全量保留（不做降采样）。元素形如 { d: date, v: value }。
 */
function downsampleEquity(equity) {
  const n = equity.length;
  if (n <= MAX_THUMB) {
    return equity.map((e) => ({ d: e.date, v: e.value }));
  }
  const out = [];
  for (let i = 0; i < MAX_THUMB; i++) {
    const idx = Math.round((i * (n - 1)) / (MAX_THUMB - 1));
    out.push({ d: equity[idx].date, v: equity[idx].value });
  }
  return out;
}

/** 从回测结果对象提取实验记录（只存口径与结论；缩略净值曲线做降采样留存） */
function toRecord(result) {
  if (!result || result.error) return null;
  const rawSymbol = result.symbol || '';
  const norm = normalizeSymbol(rawSymbol);
  const symbol = norm || rawSymbol;
  // 缩略净值曲线：仅当 result.equity 为有效非空数组时写入 equityThumb 字段（不写 null）
  let equityThumb;
  const eq = result.equity;
  if (Array.isArray(eq) && eq.length > 0) {
    equityThumb = downsampleEquity(eq);
    // 自洽要求：末点 v 必须等于 metrics.finalValue
    const fv = result.finalValue;
    if (typeof fv === 'number' && Number.isFinite(fv) && equityThumb.length > 0) {
      const last = equityThumb[equityThumb.length - 1];
      equityThumb[equityThumb.length - 1] = { d: last.d, v: fv };
    }
  }
  const rec = {
    ts: new Date().toISOString(),
    symbol,
    rawSymbol,
    strategy: result.strategy,
    params: result.params || {},
    market: result.params?.market || '',
    range: result.range || null,
    metrics: {
      finalValue: result.finalValue,
      totalReturn: result.totalReturn,
      annualized: result.annualized,
      maxDrawdownPct: result.maxDrawdownPct,
      sharpe: result.sharpe,
      sortino: result.sortino,
      calmar: result.calmar,
      tradeCount: result.tradeCount,
      winRate: result.winRate,
      benchmarkReturn: result.benchmarkReturn,
      blockedLimitUp: result.blockedLimitUp,
      blockedLimitDown: result.blockedLimitDown,
    },
    note: result.note || '',
  };
  if (equityThumb) rec.equityThumb = equityThumb;
  return rec;
}

/** 追加一条实验记录（失败静默：实验记录缺失不得影响回测本身） */
function record(result) {
  const rec = toRecord(result);
  if (!rec) return false;
  try {
    const file = FILE();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > ROTATE_BYTES) {
        fs.renameSync(file, `${file}.${Date.now()}.bak`);
      }
    } catch { /* 轮转探测失败不阻塞追加 */ }
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
    return true;
  } catch (e) {
    console.error('[Experiments] 记录失败:', e.message);
    return false;
  }
}

/** 最近 N 条实验（新在前；filters: {symbol?, strategy?}） */
function list(limit = 50, filters = {}) {
  const file = FILE();
  let out = [];
  try {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const rec = JSON.parse(lines[i]);
        // 符号过滤两侧都归一化后比较：历史裸码(600519)也能被 sh600519 搜到
        if (filters.symbol && normalizeSymbol(rec.symbol) !== normalizeSymbol(filters.symbol)) continue;
        if (filters.strategy && rec.strategy !== filters.strategy) continue;
        // 读取侧防御（v2 护栏 4）：equityThumb 非数组或长度 >200 一律忽略，不得污染图表
        if (rec.equityThumb !== undefined && (!Array.isArray(rec.equityThumb) || rec.equityThumb.length > 200)) {
          delete rec.equityThumb;
        }
        out.push(rec);
      } catch { /* 跳过损坏行 */ }
    }
  } catch (e) {
    console.error('[Experiments] 读取失败:', e.message);
  }
  return out;
}

module.exports = { record, list, toRecord };
