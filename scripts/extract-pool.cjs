#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// 从本地全A池提取「代码 + 名称」清单 → server/a-share-list.json
//
//  为什么需要它：
//    `data/` 被 .vercelignore 排除 ⇒ Vercel 上**没有** pool-all.json。
//    而「换数据源」方案（东财 clist → 腾讯批量行情）必须先有一份全A代码清单。
//    腾讯没有"列出全部股票"的接口，只能按代码批量查 —— 所以清单要随代码一起部署。
//
//  为什么放 server/ 而不是 data/：
//    server/ 会随部署上传；data/ 不会。清单是同花顺代码，非敏感数据，可公开。
//
//  用法：node scripts/extract-pool.cjs
//  刷新时机：新股上市/退市后手动重跑（构成变化很慢，不需要频繁更新）。
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'data', 'history', 'pool-all.json');
const OUT = path.join(__dirname, '..', 'server', 'a-share-list.json');

/** 归一化成腾讯可用的代码：sh600519 / sz000001 / bj430047 */
function normalize(x) {
  if (typeof x === 'string') {
    const c = x.trim().toLowerCase();
    return /^(sh|sz|bj)\d{6}$/.test(c) ? { code: c, name: '' } : null;
  }
  if (!x || typeof x !== 'object') return null;
  const raw = String(x.code || x.symbol || x.ts_code || '').trim().toLowerCase();
  const name = String(x.name || x.stock_name || '').trim();
  if (/^(sh|sz|bj)\d{6}$/.test(raw)) return { code: raw, name };
  // 600519.SH / 000001.sz / 600519 三种写法都兼容
  const digits = raw.replace(/^(sh|sz|bj)/, '').replace(/\.(sh|sz|bj)$/, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const prefix = digits[0] === '6' ? 'sh' : digits[0] === '4' || digits[0] === '8' ? 'bj' : 'sz';
  return { code: prefix + digits, name };
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`❌ 找不到源文件：${SRC}\n   （该文件由 Baostock 归档同步生成，本地才有）`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  // 实测结构（2026-09-22）：{ generatedAt, count, pool: ["sh600000", …], industries: { 代码: 行业 } }
  const pool = Array.isArray(raw) ? raw : raw.pool || raw.stocks || raw.list || raw.data || [];
  const industries = (raw && !Array.isArray(raw) && raw.industries) || {};
  if (!pool.length) {
    console.error('❌ 源文件里没解析出条目 —— 结构可能变了，请检查 pool-all.json 的字段名');
    process.exit(1);
  }

  // 清单只存「代码 + 行业」：**名称不存**，因为腾讯批量行情会随行情一起带回名称，
  // 存了反而会因除权改名而过期。行业腾讯不给，所以必须来自这里。
  const list = pool
    .map((x) => {
      const n = normalize(x);
      return n ? { code: n.code, industry: industries[n.code] || '' } : null;
    })
    .filter(Boolean);
  const uniq = [...new Map(list.map((s) => [s.code, s])).values()];
  const by = {};
  for (const s of uniq) {
    const p = s.code.slice(0, 2);
    by[p] = (by[p] || 0) + 1;
  }

  fs.writeFileSync(OUT, JSON.stringify(uniq), 'utf8');
  console.log(`源文件代码数：${pool.length}   行业映射：${Object.keys(industries).length} 条`);
  console.log(`样例：${JSON.stringify(uniq[0])}`);
  console.log(`✅ 已写出 ${path.relative(path.join(__dirname, '..'), OUT)}`);
  console.log(`   有效代码：${uniq.length} 只（${(fs.statSync(OUT).size / 1024).toFixed(0)} KB）`);
  console.log(`   分布：${JSON.stringify(by)}`);
}

main();
