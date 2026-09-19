# -*- coding: utf-8 -*-
"""
Baostock 每日数据同步管线（评审路线图 P1-1 / P1-2）
  三件套：
    1. 交易日历        → data/calendar.json（Node server/calendar.cjs 优先使用，硬编码表降级为兜底）
    2. 日线归档        → data/history/kline/{code}.json（不复权 + 复权因子，可复现口径）
    3. 财务快照(PIT)   → data/history/finance/{code}.json（按 pubDate(披露日) 积累，非报告期）

  为什么存「不复权 + 复权因子」而不是前复权：
    前复权价格会随每次除权除息整体平移——今天归档的前复权历史与一年前归档的对不上，
    等于破坏了自己的可复现性。不复权价 + adjustFactor 才能随时精确重建任意口径。
    （这也是 Point-in-Time 教学的第一课：先固定原始事实，再按需推导衍生口径。）

  用法：
    python scripts/sync_baostock.py                    # 每日任务：日历 + 核心池增量日线 + 财务快照
    python scripts/sync_baostock.py --only calendar    # 只同步交易日历（最快）
    python scripts/sync_baostock.py --pool all         # 全A日线首次建库（约 5300 只，耗时 1-2 小时）
    python scripts/sync_baostock.py --code sh600036    # 把指定代码加入核心池
    python scripts/sync_baostock.py --start 2010-01-01 # 指定历史起点（默认 2015-01-01）
"""
import argparse
import json
import os
import socket
import sys
import time

# Baostock 底层 socket 无超时：服务端偶发挂起会永久卡死同步（实测发生）。
# 全局 30 秒超时 → 单只股票查询挂死会抛异常 → 走逐只容错与连续失败重连。
socket.setdefaulttimeout(30)
from datetime import date, datetime, timedelta

try:
    import baostock as bs
except ImportError:
    print("[sync] 未安装 baostock：pip install baostock")
    sys.exit(1)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCK_FILE = os.path.join(ROOT, "data", "history", "_sync.lock")
CURSOR_FILE = os.path.join(ROOT, "data", "history", "_cursor.json")
KLINE_DIR = os.path.join(ROOT, "data", "history", "kline")
FIN_DIR = os.path.join(ROOT, "data", "history", "finance")
POOL_FILE = os.path.join(ROOT, "data", "history", "pool.json")
META_FILE = os.path.join(ROOT, "data", "history", "_meta.json")
CALENDAR_FILE = os.path.join(ROOT, "data", "calendar.json")

SLEEP_BETWEEN_CALLS = 0.25
DEFAULT_START = "2015-01-01"

# 核心股票池初始名单（沪深主板/创业板/科创板流动性较好的 30 只，可经 --code 追加，持久化到 pool.json）
STARTER_POOL = [
    "sh600519", "sh601318", "sh600036", "sh600900", "sz000858", "sz000333",
    "sz300750", "sz000001", "sh688981", "sh601899", "sh600030", "sh601166",
    "sz002594", "sh600276", "sh601088", "sh601668", "sz000651", "sh600887",
    "sz002415", "sh688111", "sh603259", "sh600309", "sz002714", "sh601919",
    "sz300059", "sh601012", "sz002230", "sz000063", "sh688041", "sh600418",
]


def tencent_to_bs(code: str) -> str:
    """sh600519 → sh.600519（Baostock 代码格式）"""
    s = code.strip().lower()
    if "." in s:
        return s
    if len(s) != 8:
        return ""
    return f"{s[:2]}.{s[2:]}"


def bs_to_tencent(code: str) -> str:
    """sh.600519 → sh600519（平台内部格式，文件名以此为准）"""
    return code.replace(".", "", 1)


def atomic_write_json(path: str, data) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def read_json(path: str, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def rows_of(rs) -> list:
    out = []
    while (rs.error_code == "0") and rs.next():
        out.append(rs.get_row_data())
    return out


def fields_of(rs) -> list:
    return list(rs.fields or [])


# ─────────────────────────── 1. 交易日历 ───────────────────────────
def sync_calendar() -> list:
    today = date.today()
    start = f"{today.year - 1}-01-01"
    end = f"{today.year + 1}-12-31"
    rs = bs.query_trade_dates(start_date=start, end_date=end)
    if rs.error_code != "0":
        raise RuntimeError(f"query_trade_dates 失败: {rs.error_msg}")
    days = [r[0] for r in rows_of(rs) if r[1] == "1"]
    payload = {
        "source": "baostock query_trade_dates",
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "range": [start, end],
        "tradingDays": days,
    }
    atomic_write_json(CALENDAR_FILE, payload)
    print(f"[sync] 交易日历 OK：{len(days)} 个交易日（{start} ~ {end}）")
    return days


# ─────────────────────────── 2. 股票池 ───────────────────────────
def load_pool(args, trading_days: list) -> list:
    saved = read_json(POOL_FILE, [])
    pool = set(saved or [])
    pool.update(STARTER_POOL)
    for c in args.code or []:
        if c:
            pool.add(c.strip().lower())
    if args.pool_file:
        doc = read_json(args.pool_file, None)
        codes = doc.get("pool") if isinstance(doc, dict) else doc
        if not codes:
            raise RuntimeError(f"池文件 {args.pool_file} 无有效代码")
        pool.update(c.strip().lower() for c in codes if c)
        print(f"[sync] 从池文件载入 {len(codes)} 只")
    elif args.pool == "all":
        if not trading_days:
            raise RuntimeError("全A池需要先同步交易日历")
        anchor = trading_days[-1]
        # 全A 快照锚定最近一个已收盘交易日（盘中运行时当日数据尚不完整）
        probe = anchor
        for _ in range(7):
            rs = bs.query_all_stock(day=probe)
            if rs.error_code == "0" and rows_of(rs):
                rs2 = bs.query_all_stock(day=probe)
                allrows = rows_of(rs2)
                for r in allrows:
                    c = r[0]
                    if c.startswith(("sh.6", "sz.0", "sz.3", "sh.68")):
                        pool.add(bs_to_tencent(c))
                print(f"[sync] 全A池锚定 {probe}：共 {len(allrows)} 只，过滤后池大小 {len(pool)}")
                break
            probe = (datetime.strptime(probe, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
        else:
            raise RuntimeError("query_all_stock 连续 7 天无数据")
    pool.discard("")
    ordered = sorted(pool)
    if ordered != sorted(saved or []):
        atomic_write_json(POOL_FILE, ordered)
    return ordered


# ─────────────────────────── 3. 日线归档（不复权 + 复权因子） ───────────────────────────
def sync_kline(code_t: str, start: str, today: str) -> dict:
    """增量归档单只股票的日线。返回 {status, newRows}"""
    os.makedirs(KLINE_DIR, exist_ok=True)
    fname = os.path.join(KLINE_DIR, f"{code_t}.json")
    doc = read_json(fname, None) or {
        "code": code_t,
        "adjust": "none+factor",
        "rows": [],
        "factors": [],
        "updatedAt": None,
    }
    rows = doc.get("rows", [])
    last = rows[-1]["date"] if rows else None
    q_start = last if last else start
    if last and last >= today:
        return {"status": "up-to-date", "newRows": 0}

    rs = bs.query_history_k_data_plus(
        tencent_to_bs(code_t),
        "date,open,high,low,close,volume,amount,turn,pctChg",
        start_date=q_start if last else start,
        end_date=today,
        frequency="d",
        adjustflag="3",  # 不复权
    )
    if rs.error_code != "0":
        return {"status": f"error: {rs.error_msg}", "newRows": 0}
    fresh = []
    for r in rows_of(rs):
        try:
            fresh.append({
                "date": r[0],
                "open": float(r[1]) if r[1] else None,
                "high": float(r[2]) if r[2] else None,
                "low": float(r[3]) if r[3] else None,
                "close": float(r[4]) if r[4] else None,
                "volume": float(r[5]) if r[5] else 0,
                "amount": float(r[6]) if r[6] else 0,
                "turn": float(r[7]) if r[7] else None,
                "pctChg": float(r[8]) if r[8] else None,
            })
        except (ValueError, IndexError):
            continue
    # 去重（增量起点含 last 当日，防止重复）
    if last:
        fresh = [r for r in fresh if r["date"] > last]
    if fresh:
        rows.extend(fresh)
        doc["rows"] = rows[-12000:]  # 单只上限 12000 根（约 48 年），防无限增长
    # 复权因子（全量重拉，条数少；覆盖分红送转后因子的变化）
    try:
        rsf = bs.query_adjust_factor(
            code=tencent_to_bs(code_t),
            start_date="2006-01-01",
            end_date=today,
        )
        if rsf.error_code == "0":
            doc["factors"] = [
                {"date": r[1], "fore": float(r[2]), "back": float(r[3]), "factor": float(r[4])}
                for r in rows_of(rsf)
            ]
    except Exception as e:  # 因子失败不阻塞日线
        print(f"[sync] {code_t} 复权因子失败: {e}")
    if fresh or last is None:
        doc["updatedAt"] = datetime.now().isoformat(timespec="seconds")
        atomic_write_json(fname, doc)
    return {"status": "ok" if fresh else "no-new", "newRows": len(fresh)}


# ─────────────────────────── 4. 财务快照（PIT：按披露日 pubDate 积累） ───────────────────────────
def recent_quarters(n: int) -> list:
    """返回最近 n 个报告期 [(year, quarter)]。9月13日 → 2026Q2 已披露(8月底前) → [(2026,2),(2026,1)...]"""
    today = date.today()
    y, q = today.year, (today.month - 1) // 3 + 1
    # 报告期通常滞后 1~2 个月披露，取上上个季度为最新目标期更稳
    q -= 1
    if q == 0:
        y, q = y - 1, 4
    out = []
    for _ in range(n):
        out.append((y, q))
        q -= 1
        if q == 0:
            y, q = y - 1, 4
    return out


PROFIT_FIELDS = "code,pubDate,statDate,roeAvg,npMargin,epsTTM,MBRevenue,totalShare,liqaShare"


def sync_finance(code_t: str, quarters: list) -> dict:
    os.makedirs(FIN_DIR, exist_ok=True)
    fname = os.path.join(FIN_DIR, f"{code_t}.json")
    doc = read_json(fname, None) or {"code": code_t, "note": "PIT 快照：以 pubDate(披露日) 为准，不做回填改写", "rows": []}
    known = {(r.get("statDate"), r.get("pubDate")) for r in doc["rows"]}
    added = 0
    for (y, q) in quarters:
        rs = bs.query_profit_data(code=tencent_to_bs(code_t), year=y, quarter=q)
        if rs.error_code != "0":
            continue
        for r in rows_of(rs):
            row = dict(zip(fields_of(rs), r))
            pub, stat = row.get("pubDate"), row.get("statDate")
            if not pub or not stat:
                continue  # 未披露
            key = (stat, pub)
            if key in known:
                continue
            try:
                doc["rows"].append({
                    "statDate": stat,
                    "pubDate": pub,
                    "roeAvg": float(row.get("roeAvg") or 0) or None,
                    "npMargin": float(row.get("npMargin") or 0) or None,
                    "epsTTM": float(row.get("epsTTM") or 0) or None,
                    "totalShare": float(row.get("totalShare") or 0) or None,
                })
                known.add(key)
                added += 1
            except (ValueError, TypeError):
                continue
    if added:
        doc["rows"].sort(key=lambda r: (r["pubDate"], r["statDate"]))
        doc["updatedAt"] = datetime.now().isoformat(timespec="seconds")
        atomic_write_json(fname, doc)
    return {"added": added}


# ─────────────────────────── 主流程 ───────────────────────────
def acquire_lock() -> bool:
    """防并发锁：全量建库与每日计划任务同时跑会互相拖垮 Baostock 连接。按时间过期（6 小时）。"""
    try:
        info = read_json(LOCK_FILE, None)
        if info and time.time() - float(info.get("ts", 0)) < 6 * 3600:
            return False
    except Exception:
        pass
    try:
        atomic_write_json(LOCK_FILE, {"pid": os.getpid(), "ts": time.time()})
    except Exception:
        pass
    return True


def release_lock() -> None:
    try:
        os.remove(LOCK_FILE)
    except OSError:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["calendar"], default=None)
    ap.add_argument("--pool", choices=["core", "all"], default="core")
    ap.add_argument("--code", action="append", default=[], help="追加到核心池（平台格式，如 sh600036）")
    ap.add_argument("--start", default=DEFAULT_START)
    ap.add_argument("--fin-quarters", type=int, default=2)
    ap.add_argument("--max-codes", type=int, default=0, help="单次最多同步 N 只（0=不限）；配合 _cursor.json 轮转，供每日计划任务分批消化全池")
    ap.add_argument("--pool-file", default=None, help="从 JSON 文件读股票池（{pool:[...]} 或 [...])，替代 query_all_stock——Baostock 全A接口对近期日期不稳定，用平台东财快照代替")
    args = ap.parse_args()

    if not acquire_lock():
        print("[sync] 检测到另一同步进程在运行（6 小时内的锁），本任务退出")
        sys.exit(0)
    lg = bs.login()
    if lg.error_code != "0":
        print(f"[sync] baostock 登录失败: {lg.error_msg}")
        sys.exit(1)
    print("[sync] baostock 登录成功")

    stats = {"calendar": 0, "kline": {}, "finance": {}, "errors": []}
    try:
        trading_days = sync_calendar()
        stats["calendar"] = len(trading_days)
        if args.only == "calendar":
            return

        today = date.today().strftime("%Y-%m-%d")
        pool = load_pool(args, trading_days)
        pool_total = len(pool)
        if args.max_codes and pool_total > args.max_codes:
            cur = read_json(CURSOR_FILE, None)
            start_idx = int((cur or {}).get("next", 0)) % pool_total
            pool = [pool[(start_idx + i) % pool_total] for i in range(args.max_codes)]
            atomic_write_json(CURSOR_FILE, {"next": (start_idx + args.max_codes) % pool_total, "poolTotal": pool_total, "updatedAt": datetime.now().isoformat(timespec="seconds")})
            print(f"[sync] 轮转限额：本批 {args.max_codes} 只（起点 {start_idx}，池总 {pool_total}，每日计划任务约 {pool_total // max(args.max_codes,1) + 1} 天轮完）")
        print(f"[sync] 股票池：{len(pool)} 只，历史起点 {args.start}")
        quarters = recent_quarters(max(1, min(args.fin_quarters, 8)))
        consec_fail = 0

        for i, code_t in enumerate(pool, 1):
            try:
                r = sync_kline(code_t, args.start, today)
                stats["kline"][code_t] = r["newRows"]
                if r["status"].startswith("error"):
                    stats["errors"].append(f"{code_t} kline: {r['status']}")
                time.sleep(SLEEP_BETWEEN_CALLS)
                f = sync_finance(code_t, quarters)
                stats["finance"][code_t] = f["added"]
                time.sleep(SLEEP_BETWEEN_CALLS)
                consec_fail = 0
                if i % 20 == 0:
                    print(f"[sync] 进度 {i}/{len(pool)}")
            except Exception as e:
                consec_fail += 1
                stats["errors"].append(f"{code_t}: {e}")
                print(f"[sync] {code_t} 异常: {e}")
                if consec_fail >= 20:
                    # 连续失败大概率是连接掉线：重登录一次再继续
                    print("[sync] 连续失败 20 只，尝试重连 baostock …")
                    try:
                        bs.logout()
                        time.sleep(2)
                        lg2 = bs.login()
                        consec_fail = 0
                        print(f"[sync] 重连 {lg2.error_code}")
                    except Exception as e2:
                        print(f"[sync] 重连失败: {e2}")
                        break

        total_new = sum(stats["kline"].values())
        stats["summary"] = {
            "finishedAt": datetime.now().isoformat(timespec="seconds"),
            "poolSize": len(pool),
            "newKlineRows": total_new,
            "newFinanceRows": sum(stats["finance"].values()),
            "errorCount": len(stats["errors"]),
        }
        atomic_write_json(META_FILE, stats)
        print(f"[sync] 完成：新增日线 {total_new} 行，新增财务 {stats['summary']['newFinanceRows']} 行，错误 {len(stats['errors'])}")
    finally:
        release_lock()
        bs.logout()


if __name__ == "__main__":
    main()
