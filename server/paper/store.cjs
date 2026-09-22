// ─────────────────────────────────────────────────────────────
// 模拟交易持久化层：单文件 JSON + 原子写入 + 定时快照
//   · 每次交易/订单状态变更即时落盘（write-through）
//   · 引擎另有 60s 定时快照（记录净值曲线），双保险防重启丢数据
//   · 存储适配器接口：如需迁移 SQLite/Redis，仅需替换本文件实现
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const db = require('../db.cjs');

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

  // ── Postgres 镜像（托管环境的持久化）──────────────────────────
  //  为什么需要：Vercel 文件系统**只读** ⇒ 上面的 write-through 与 60s 快照都写不进去，
  //  订单/持仓只活单实例内存 ⇒ 冷启动即丢（用户实测：刷新/重开订单消失）。
  //  方案：**按 uid 分行**存 Postgres —— 冷启动一次性载入全部行（个位数用户，成本可忽略）；
  //  落盘时按 uid UPSERT，跨用户互不影响。
  //  ⚠️ 已知边界（如实说明）：**跨实例**并发写同一 uid 仍是后写覆盖 ——
  //     个位数用户、低频交易的规模下可接受；要彻底解决需按订单行级存储 + 数据库行锁。
  whenReady() {
    if (!db.hasDb()) return Promise.resolve(false);
    if (!this.dbReady) {
      this.dbReady = (async () => {
        await db.ready();
        await this.hydrateFromDb();
        return true;
      })().catch((e) => {
        this.dbReady = null; // 允许后续请求重试，而不是永久卡死
        throw e;
      });
    }
    return this.dbReady;
  }

  /** 冷启动载入：以数据库为准填充内存（此时内存应为空）。 */
  async hydrateFromDb() {
    const r = await db.query(`SELECT uid, data, updated_at FROM paper_state`);
    let n = 0;
    for (const row of r.rows) {
      this.dirtyAt[row.uid] = new Date(row.updated_at).getTime();
      const d = row.data || {};
      if (d.accounts && !this.state.accounts[row.uid]) this.state.accounts[row.uid] = d.accounts;
      if (d.positions && !this.state.positions[row.uid]) this.state.positions[row.uid] = d.positions;
      if (d.orders && !this.state.orders[row.uid]) this.state.orders[row.uid] = d.orders;
      if (d.equity && !this.state.equity[row.uid]) this.state.equity[row.uid] = d.equity;
      if (d.dailyPnl && !this.state.dailyPnl[row.uid]) this.state.dailyPnl[row.uid] = d.dailyPnl;
      n++;
    }
    if (n) console.log(`💾 [PaperStore] 已从数据库载入 ${n} 个账户的状态`);
  }

  /**
   * 落盘后调度一次数据库同步（800ms 去抖：把同一瞬间的多次写合并成一轮 UPSERT）。
   * 同步失败**显式打日志**（数据仍在内存，下一轮落盘会再试）—— 不静默。
   */
  scheduleDbSync() {
    if (!db.hasDb()) return;
    if (this.dbSyncTimer) return; // 已排程，去重
    this.dbSyncTimer = setTimeout(() => {
      this.dbSyncTimer = null;
      this.syncToDb().catch((e) =>
        console.error('[PaperStore] 数据库同步失败（数据仍在内存，下轮落盘会再试）:', e.message),
      );
    }, 800);
    if (this.dbSyncTimer.unref) this.dbSyncTimer.unref();
  }

  /** 把内存中每个 uid 的五段数据 UPSERT 回数据库（个位数用户，量级极小） */
  async syncToDb() {
    await this.whenReady();
    const uids = new Set([
      ...Object.keys(this.state.accounts),
      ...Object.keys(this.state.positions),
      ...Object.keys(this.state.orders),
    ]);
    for (const uid of uids) {
      const data = {
        accounts: this.state.accounts[uid] ?? null,
        positions: this.state.positions[uid] ?? [],
        orders: this.state.orders[uid] ?? [],
        equity: this.state.equity[uid] ?? [],
        dailyPnl: this.state.dailyPnl[uid] ?? {},
      };
      await db.query(
        `INSERT INTO paper_state (uid, data, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (uid) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [uid, JSON.stringify(data)],
      );
    }
  }

  /** 从数据库删除某 uid 的镜像（配合账户重置，避免"重置后被载回"） */
  deleteDbMirror(uid) {
    if (!db.hasDb()) return;
    db.query(`DELETE FROM paper_state WHERE uid = $1`, [uid]).catch((e) =>
      console.warn('[PaperStore] 删除数据库镜像失败:', e.message),
    );
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
    // 写文件之外，调度一次数据库镜像（托管环境的持久化通道；内部有去抖与显式失败日志）
    this.scheduleDbSync();
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
    // 🔴 必须同时删掉数据库镜像，否则下次冷启动会把旧状态**载回**（重置等于没重置）
    this.deleteDbMirror(uid);
    this.ensureAccount(uid);
    this.save();
  }
}

module.exports = { PaperStore, emptyState };
