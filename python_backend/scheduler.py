# ─────────────────────────────────────────────────────────────
# 定时更新任务（每日 16:00 收盘后自动拉取热门股票刷新缓存）
#   独立守护线程，仅在后端进程存活期间运行；
#   如需服务关闭也执行，可另配系统计划任务调用 `python -m scheduler --once`。
# ─────────────────────────────────────────────────────────────
import datetime
import sys
import threading
import time

import baostock_source
import database
from config import HOT_STOCKS, SCHEDULE_TIME

_last_run_date = None
_lock = threading.Lock()


def refresh_hot_stocks(verbose=True):
    """拉取热门股票日K并写入缓存（绕过 HTTP 限流，直接操作数据层）"""
    updated, failed = 0, 0
    for sym in HOT_STOCKS:
        try:
            klines = baostock_source.query_history(sym, "d", 500)
            if klines:
                database.set_kline(
                    sym, "day", klines[0]["date"], klines[-1]["date"], klines
                )
                updated += 1
            else:
                failed += 1
        except Exception:
            failed += 1
        time.sleep(0.5)  # 温和节奏，避免对 Baostock 造成压力
    if verbose:
        print(
            f"[scheduler] {datetime.datetime.now():%Y-%m-%d %H:%M:%S} "
            f"热门股票缓存刷新完成：成功 {updated}，失败 {failed}"
        )
    return {"updated": updated, "failed": failed, "at": time.strftime("%Y-%m-%d %H:%M:%S")}


def compute_daily_scores(verbose=True):
    """每日量化评分：对股票池评分并写入 SQLite 快照（主页"今日观察"展示）"""
    import services  # 延迟导入，避免与 services 模块循环依赖

    try:
        items = services.recommend(len(services.STOCK_POOL))
        if not items:
            if verbose:
                print("[scheduler] 评分快照生成失败：无评分结果")
            return None
        computed_at = time.strftime("%Y-%m-%d %H:%M:%S")
        database.set_daily_scores(items, computed_at)
        if verbose:
            print(
                f"[scheduler] 每日量化评分快照已生成：{len(items)} 只股票 @ {computed_at}"
            )
        return {"count": len(items), "computedAt": computed_at}
    except Exception as e:
        if verbose:
            print(f"[scheduler] 评分快照生成失败: {e}")
        return None


def _loop():
    global _last_run_date
    while True:
        now = datetime.datetime.now()
        today = now.strftime("%Y-%m-%d")
        if now.strftime("%H:%M") == SCHEDULE_TIME and _last_run_date != today:
            with _lock:
                if _last_run_date != today:
                    _last_run_date = today
                    try:
                        refresh_hot_stocks()
                        compute_daily_scores()
                    except Exception as e:
                        print(f"[scheduler] 每日任务失败: {e}")
        time.sleep(20)


def start_scheduler():
    t = threading.Thread(target=_loop, daemon=True, name="daily-cache-refresh")
    t.start()
    print(
        f"[scheduler] 每日 {SCHEDULE_TIME} 自动刷新缓存已启动"
        f"（热门股票 {len(HOT_STOCKS)} 只）"
    )
    return t


if __name__ == "__main__":
    # 手动触发：python -m scheduler（配合系统计划任务实现服务关闭时也更新）
    if "--once" in sys.argv:
        database.init_db()
        result = refresh_hot_stocks()
        print(result)
        sys.exit(0)
    database.init_db()
    start_scheduler()
    # 保持前台运行（供计划任务/容器使用）
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
