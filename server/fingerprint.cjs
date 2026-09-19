// ─────────────────────────────────────────────────────────────
// 回测指纹（S1 · 四要素）
//   目的：让「可复现」从「声明」变成「可判定」——
//         两次回测若指纹相同，结果必然一致；若不同，必须能指出是哪一要素变了。
//   ⚠️ 边界认知：指纹**不保证**可复现，它只让「输入是否相同」可判定。
//      可复现的真正来源是「确定性计算 + 输入可固定」。
//
//   四要素：
//     codeHash  关键计算模块的内容哈希（改了任何一个字符都会变）
//     data      数据来源 / 复权口径 / 区间 / 末根日 / 序列哈希 / 因子引用
//     params    全量参数（策略、窗口、资金、滑点、市场、涨跌停…）
//     env       Node 版本 / 平台 —— **仅记录，不参与校验**
//               （理由：本平台回测链路无外部数学库依赖；但 Math.pow 等超越函数
//                跨平台可差 1 ULP，故记录以便跨平台复现时排查，不作判据）
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 关键计算模块：任一改动都会影响回测数值，故必须纳入哈希。
// 注意 index.cjs 必须在内——它持有 /api/backtest 的默认 slippage 等口径（见 v2 方案 D-f）。
const CODE_MODULES = [
  'quant.cjs',
  'crosssect.cjs',
  'index.cjs',
  path.join('paper', 'fees.cjs'),
  path.join('paper', 'matcher.cjs'),
];

let _codeHashCache = null; // 进程内缓存：模块文件在运行期不变，避免热路径反复读盘

function fileHash(absPath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/** 关键计算模块的内容哈希（默认走进程内缓存；force=true 可强制重算，供测试用） */
function codeHash(force = false) {
  if (_codeHashCache && !force) return _codeHashCache;
  const out = {};
  for (const rel of CODE_MODULES) {
    const h = fileHash(path.join(__dirname, rel));
    if (h) out[rel.split(path.sep).join('/')] = h;
  }
  _codeHashCache = out;
  return out;
}

/** 序列哈希：对 (date, close) 序列求 sha256 —— 只关心数值，不关心对象其他字段 */
function rowsHash(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const h = crypto.createHash('sha256');
  for (const r of rows) h.update(`${r.date}:${r.close};`);
  return h.digest('hex').slice(0, 16);
}

/** 全池哈希：code 升序 + 各自 rowsHash，聚合成一个哈希（横截面回测用） */
function universeHash(universe) {
  if (!universe || !universe.size) return null;
  const codes = [...universe.keys()].sort();
  const h = crypto.createHash('sha256');
  for (const code of codes) {
    h.update(code);
    h.update(':');
    h.update(rowsHash(universe.get(code)) || '-');
    h.update('|');
  }
  return h.digest('hex').slice(0, 16);
}

function envInfo() {
  return { node: process.version, platform: process.platform };
}

/**
 * 组装指纹
 * @param params 全量参数对象
 * @param data   { source, adjust, factorSource, range, lastDate, rowsHash, universeSize?, factorsRef? }
 */
function build({ params = {}, data = {} } = {}) {
  return {
    codeHash: codeHash(),
    data,
    params,
    env: envInfo(),
  };
}

module.exports = { build, codeHash, rowsHash, universeHash, envInfo, CODE_MODULES };
