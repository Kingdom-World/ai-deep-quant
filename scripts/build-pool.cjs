// ─────────────────────────────────────────────────────────────
// 全A股票池生成（评审 R5）：用平台自己的东财全市场快照生成 Baostock 同步池
//   · 背景：Baostock query_all_stock 对近期日期不稳定（挂起/空返回），
//     而平台选股模块本就有全A 5300 只的可靠快照——直接复用，顺带带上行业名
//   · 输出 data/history/pool-all.json：["sh600519", ...]（仅沪深，剔除北交所——Baostock 不覆盖）
//   · 用法：node scripts/build-pool.cjs
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { snapshot } = require('../server/screener.cjs');

const OUT = path.join(__dirname, '..', 'data', 'history', 'pool-all.json');

function withMarket(bare) {
  if (/^6/.test(bare)) return `sh${bare}`;
  if (/^(0|3)/.test(bare)) return `sz${bare}`;
  return null; // 北交所（4/8/92 开头）Baostock 不支持，剔除
}

(async () => {
  try {
    const snap = await snapshot();
    const pool = [];
    const industries = {};
    for (const r of snap.rows) {
      const code = withMarket(String(r.code));
      if (!code) continue;
      pool.push(code);
      if (r.name && r.industry && r.industry !== '—') industries[code] = r.industry;
    }
    pool.sort();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(
      OUT,
      JSON.stringify({ generatedAt: new Date().toISOString(), count: pool.length, pool, industries }, null, 0),
      'utf8',
    );
    console.log(`[build-pool] OK：${pool.length} 只（含行业映射 ${Object.keys(industries).length} 条）→ ${OUT}`);
  } catch (e) {
    console.error('[build-pool] 失败:', e.message);
    process.exit(1);
  }
})();
