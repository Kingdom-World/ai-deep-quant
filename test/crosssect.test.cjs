// ─────────────────────────────────────────────────────────────
// 横截面回测引擎单元测试（评审 P2-5）
//   合成宇宙：A 强势上涨 / B 横盘 / C 下跌——动量因子应持续持有 A
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCrossBacktest } = require('../server/crosssect.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-'));
process.env.LOCAL_HISTORY_DIR = tmpDir;

function writeStock(code, closes) {
  const rows = closes.map((c, i) => ({
    date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    open: +(c * 0.999).toFixed(4),
    close: c,
    high: c * 1.01,
    low: c * 0.99,
    volume: 1000,
  }));
  fs.writeFileSync(path.join(tmpDir, `${code}.json`), JSON.stringify({ code, adjust: 'none+factor', rows, factors: [] }));
}

// 90 根：A 10→20（强）、B 恒 10、C 10→5（弱）——满足引擎 ≥80 根的入池门槛
const up = Array.from({ length: 90 }, (_, i) => +(10 + i * (10 / 89)).toFixed(4));
const flat = Array.from({ length: 90 }, () => 10);
const down = Array.from({ length: 90 }, (_, i) => +(10 - i * (5 / 89)).toFixed(4));
writeStock('sh600001', up);
writeStock('sz000002', flat);
writeStock('sh600003', down);

test('动量 top1 应持有强势标的，收益为正', () => {
  const r = runCrossBacktest({ factor: 'mom20', topN: 1, rebalanceEvery: 5, capital: 1_000_000 });
  assert.ok(!r.error, r.error);
  assert.equal(r.universeSize, 3);
  assert.ok(r.totalReturn > 20, `totalReturn=${r.totalReturn}（A 涨约 100%，半仓以上应 >20%）`);
  assert.ok(r.rebalances >= 10);
  assert.ok(r.fills > 0);
  assert.ok(r.totalFees > 0 && r.feeRatePct > 0 && r.feeRatePct < 0.5);
  assert.ok(r.equity.length > 0 && r.equity[r.equity.length - 1].value > 1_000_000);
});

test('top3 等权：结果确定性（两次运行一致）', () => {
  const a = runCrossBacktest({ factor: 'mom60', topN: 3, rebalanceEvery: 10 });
  const b = runCrossBacktest({ factor: 'mom60', topN: 3, rebalanceEvery: 10 });
  assert.equal(a.finalValue, b.finalValue);
  assert.equal(a.fills, b.fills);
  assert.ok(a.totalReturn >= b.totalReturn - 1e-9);
});

test('数据不足返回明确错误', () => {
  process.env.LOCAL_HISTORY_DIR = path.join(tmpDir, 'empty');
  const r = runCrossBacktest({});
  assert.ok(r.error && r.error.includes('本地归档不足'));
  assert.ok(r.error.includes('sync_baostock'), '错误信息应指引同步命令');
  process.env.LOCAL_HISTORY_DIR = tmpDir;
});
