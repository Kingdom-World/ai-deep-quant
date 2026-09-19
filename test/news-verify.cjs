// 资讯模块回归验证：新匹配引擎 vs 旧全文检索基线
// 用法：先启动服务（PORT=8899），再 node test/news-verify.cjs
const http = require('http');
const sources = require('../server/news/sources.cjs');
const matcher = require('../server/news/matcher.cjs');

const PORT = Number(process.env.VPORT || 8899);
const STOCKS = [
  ['sh600519', '贵州茅台'],
  ['sz000001', '平安银行'],
  ['sz300750', '宁德时代'],
  ['sh601318', '中国平安'],
  ['sh601899', '紫金矿业'],
  ['sz002594', '比亚迪'],
];

const get = (path) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path, headers: { 'User-Agent': 'verify' } }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch { reject(new Error('bad json: ' + d.slice(0, 100))); }
        });
      })
      .on('error', reject);
  });

// 旧逻辑：仅用 6 位代码全文检索，不做任何降噪
async function baselineStockNews(digits) {
  const rows = await sources.fetchEmSearch(digits, 10);
  return rows;
}

// 噪音判定：命中统计盘点/聚合类特征，且标题未点名本股
function isNoisy(title, name, digits) {
  const named = title.includes(name) || new RegExp(`(?<![0-9])${digits}(?![0-9])`).test(title);
  if (named) return false;
  return matcher.isRoundupNoise(title, matcher.buildProfile('sh' + digits, name), '');
}

(async () => {
  console.log('════════════ 资讯模块优化验证 ════════════\n');

  // ---------- 市场要闻 ----------
  const m = await get('/api/news?type=market&limit=200');
  const bySource = {};
  for (const x of m.items) bySource[x.source || 'unknown'] = (bySource[x.source || 'unknown'] || 0) + 1;
  console.log('【市场要闻】');
  console.log(`  优化前基线：新浪滚动单源  12 条/次，每日刷新 1 次`);
  console.log(`  优化后：    ${m.items.length} 条，来源 ${JSON.stringify(bySource)}`);
  console.log(`  时间跨度：  ${(m.items.at(-1)?.publishedAt || '').slice(5, 16).replace('T', ' ')} → ${(m.items[0]?.publishedAt || '').slice(5, 16).replace('T', ' ')}`);
  console.log(`  媒体覆盖：  ${[...new Set(m.items.map((x) => x.media))].slice(0, 6).join(' / ')}`);

  // ---------- 个股资讯 ----------
  console.log('\n【个股资讯】命中数量与噪音率对比');
  console.log('  股票          基线(条/噪音)   优化后(条/噪音)   高置信   标题点名');
  let bTotal = 0, bNoise = 0, aTotal = 0, aNoise = 0;
  for (const [sym, name] of STOCKS) {
    const digits = sym.slice(2);
    const base = await baselineStockNews(digits);
    const bNoisy = base.filter((x) => isNoisy(x.title, name, digits)).length;
    const r = await get(`/api/news?type=stock&symbol=${sym}&limit=60`);
    const items = r.items || [];
    const aNoisy = items.filter((x) => isNoisy(x.title, name, digits)).length;
    const high = items.filter((x) => (x.matchScore ?? 0) >= 0.7).length;
    const named = items.filter((x) => x.title.includes(name) || new RegExp(`(?<![0-9])${digits}(?![0-9])`).test(x.title)).length;
    bTotal += base.length; bNoise += bNoisy;
    aTotal += items.length; aNoise += aNoisy;
    console.log(
      `  ${(name + ' ' + sym).padEnd(20)}${String(base.length).padStart(3)} / ${String(bNoisy).padStart(2)}       ` +
        `${String(items.length).padStart(3)} / ${String(aNoisy).padStart(2)}        ${String(high).padStart(3)}     ${String(named).padStart(3)}`,
    );
  }
  const bRate = ((bNoise / Math.max(bTotal, 1)) * 100).toFixed(1);
  const aRate = ((aNoise / Math.max(aTotal, 1)) * 100).toFixed(1);
  console.log(`\n  合计：基线 ${bTotal} 条（噪音 ${bNoise}，${bRate}%） → 优化后 ${aTotal} 条（噪音 ${aNoise}，${aRate}%）`);

  // ---------- 数据源健康 ----------
  const h = await get('/api/news/health');
  console.log('\n【数据源健康度】');
  for (const [k, v] of Object.entries(h.sources || {})) {
    console.log(`  ${k.padEnd(14)} 成功 ${v.ok} 次 / 失败 ${v.fails} 次${v.degraded ? '  ⚠ 已熔断降级' : ''}`);
  }
  console.log(`  通达信行情通道: ${JSON.stringify(h.tdxChannel)}`);
  console.log(`  本地快照:      ${JSON.stringify(h.snapshot)}`);
  console.log('\n══════════════════════════════════════════');
})();
