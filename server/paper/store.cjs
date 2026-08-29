// ─────────────────────────────────────────────────────────────
// 模拟交易持久化层：单文件 JSON + 原子写入 + 定时快照
//   · 每次交易/订单状态变更即时落盘（write-through）
//   · 引擎另有 60s 定时快照（记录净值曲线），双保险防重启丢数据
//   · 存储适配器接口：如需迁移 SQLite/Redis，仅需替换本文件实现
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.PAPER_DATA_DIR || path.join(__dirname, '..', '..', 'data', 'paper');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

function emptyState() {
  return {
    accounts: {},   // uid -> {cash, initialCapital, createdAt}
    positions: {},  // uid -> [ {symbol, name, market, qty, avgCost, todayBoughtQty, todayBoughtDate} ]
    orders: {},     // uid -> [ 订单（含状态机 pending/resting/filled/canceled/rejected） ]
    equity: {},     // uid -> [ {t, total, cash, marketValue} ] 净值快照序列
    dailyPnl: {},   // uid -> { 'YYYY-MM-DD': 当日盈亏 }
    logs: [],       // 策略运行日志（全局环形，上限 500 条）
  };
}

class PaperStore {
  constructor() {
    this.state = emptyState();
    this.load();
    // 定时快照任务：每 60s 强制落盘一次（要求 #2：严防重启丢数据）
    this.timer = setInterval(() => this.save(), 60_000);
    this.timer.unref();
  }

  load() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(STATE_FILE)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        this.state = { ...emptyState(), ...loaded };
      } catch (e) {
        // 状态文件损坏时保留损坏副本，从零开始，绝不静默覆盖原文件
        console.error('[PaperStore] 状态文件解析失败，已备份为 state.corrupt.json:', e.message);
        fs.copyFileSync(STATE_FILE, path.join(DATA_DIR, 'state.corrupt.json'));
        this.state = emptyState();
      }
    }
  }

  /** 原子落盘：临时文件 + rename，等价单事务提交 */
  save() {
    try {
      const tmp = `${STATE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state), 'utf8');
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
      console.error('[PaperStore] 持久化失败:', e.message);
    }
  }

  /** 确保用户账户存在（初始资金默认 100 万，PAPER_INITIAL_CAPITAL 可调） */
  ensureAccount(uid) {
    if (!this.state.accounts[uid]) {
      const capital = Math.max(Number(process.env.PAPER_INITIAL_CAPITAL) || 1_000_000, 10_000);
      this.state.accounts[uid] = { cash: capital, initialCapital: capital, createdAt: new Date().toISOString() };
      this.state.positions[uid] = this.state.positions[uid] || [];
      this.state.orders[uid] = this.state.orders[uid] || [];
      this.state.equity[uid] = this.state.equity[uid] || [];
      this.state.dailyPnl[uid] = this.state.dailyPnl[uid] || {};
      this.save();
    }
    return this.state.accounts[uid];
  }

  reset(uid) {
    delete this.state.accounts[uid];
    delete this.state.positions[uid];
    delete this.state.orders[uid];
    delete this.state.equity[uid];
    delete this.state.dailyPnl[uid];
    this.ensureAccount(uid);
    this.save();
  }
}

module.exports = { PaperStore, emptyState };
