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
const LOCK_FILE = path.join(DATA_DIR, 'state.json.lock');

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
    this.acquireLock(); // 双实例会在此处报错退出（防止内存态互相覆盖回滚交易）
    // 定时快照任务：每 60s 强制落盘一次（要求 #2：严防重启丢数据）
    this.timer = setInterval(() => this.save(), 60_000);
    this.timer.unref();
    // 退出兜底：正常退出（Ctrl+C/SIGTERM/exit）时最终落盘 + 释放锁（强杀进程无钩子，靠 write-through 保数据）
    let exiting = false;
    const finalFlush = () => {
      if (exiting) return;
      exiting = true;
      try { this.save(); } catch { /* exit 阶段尽力而为 */ }
      try { fs.unlinkSync(LOCK_FILE); } catch { /* 锁文件可能已被清理 */ }
    };
    process.on('exit', finalFlush);
    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
  }

  /**
   * 单实例守卫：锁文件记录 PID，检测到存活的其他实例直接抛错拒绝启动。
   * 背景：历史上残留的旧实例用 60s 定时快照反复用旧内存态覆盖 state.json，
   * 把用户新做的交易滚回旧状态（2026-08-31 用户茅台半卖+平安买入丢失事故）。
   */
  acquireLock() {
    const write = () => fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
    try {
      if (fs.existsSync(LOCK_FILE)) {
        let prev = null;
        try { prev = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { /* 锁文件损坏按无锁处理 */ }
        if (prev?.pid) {
          let alive = false;
          try { process.kill(prev.pid, 0); alive = prev.pid !== process.pid; } catch { alive = false; }
          if (alive) {
            throw new Error(`[PaperStore] 检测到另一个模拟盘实例正在运行（PID ${prev.pid}）。两个实例会互相覆盖交易状态，请先关闭旧实例（或结束该进程）再启动本服务。`);
          }
        }
      }
      write();
    } catch (e) {
      if (String(e.message).includes('另一个模拟盘实例')) throw e;
      try { write(); } catch { /* 只读 FS（如 Vercel）无锁可用，静默降级 */ }
    }
    // 进程存活校验兜底：锁内 PID 已死说明是残锁，上面 write() 已接管
  }

  load() {
    // ⚠️ 只读文件系统（Vercel Serverless 等）降级：建目录失败不能拖垮整个进程。
    //    背景（2026-09-20 线上实测）：本行原先无 try/catch，Vercel 上抛
    //    ENOENT: mkdir '/var/task/data/paper' → 模块加载即崩 →
    //    整个 Serverless 函数 500、全站不可用。
    //    与同类中的 acquireLock() 保持一致——那里早已显式处理只读 FS。
    //    降级语义：无法持久化则按内存态运行（模拟盘在无持久存储的环境本就不该可用）。
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (e) {
      console.warn('[PaperStore] 持久化不可用，降级为内存态:', e.message);
    }
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

  /**
   * 落盘：临时文件 + rename 原子提交。
   * Windows 下杀毒/索引器会短暂锁住目标文件导致 rename EPERM（已实测发生）——
   * 失败时同步等待重试，仍失败则降级为直接覆写，宁可非原子也绝不丢交易。
   * @returns {boolean} 是否成功落盘
   */
  save() {
    const payload = JSON.stringify(this.state);
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
    } catch (e) {
      console.error('[PaperStore] 临时文件写入失败:', e.message);
      return false;
    }
    for (let i = 0; i < 5; i++) {
      try {
        fs.renameSync(tmp, STATE_FILE);
        return true;
      } catch {
        // 同步休眠 120ms 后重试（Atomics.wait，不阻塞事件循环之外的东西）
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120); } catch { /* 超时返回属正常 */ }
      }
    }
    try {
      fs.writeFileSync(STATE_FILE, payload, 'utf8');
      try { fs.unlinkSync(tmp); } catch { /* 清理临时文件失败无碍 */ }
      console.warn('[PaperStore] rename 连续失败，已用直接覆写保住交易数据（目标文件可能被杀软/索引器锁定）');
      return true;
    } catch (e) {
      console.error('[PaperStore] 持久化彻底失败:', e.message);
      return false;
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
