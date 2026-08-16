# ─────────────────────────────────────────────────────────────
# Baostock 数据源（历史K线主源）
#   · 提供日/周/月/分钟K线与复权数据，免费、学术友好
#   · 数据版权归 Baostock 所有，仅用于学术研究演示
#   · 会话复用：一次 login 服务多次查询（加锁串行化，断线自动重连）
# ─────────────────────────────────────────────────────────────
import datetime
import threading

import baostock as bs

from config import BAOSTOCK_ADJUST, BAOSTOCK_DEFAULT_DAYS

_bs_connected = False
_bs_lock = threading.Lock()


def _login():
    global _bs_connected
    if _bs_connected:
        return True
    try:
        lg = bs.login()
        _bs_connected = lg.error_code == "0"
    except Exception:
        _bs_connected = False
    return _bs_connected


def _logout():
    global _bs_connected
    if _bs_connected:
        try:
            bs.logout()
        except Exception:
            pass
        _bs_connected = False


def _query(fn):
    """加锁执行查询；失败断开并重连重试一次"""
    with _bs_lock:
        for _ in (0, 1):
            if not _login():
                return None
            try:
                result = fn()
                if result is not None:
                    return result
            except Exception:
                pass
            _logout()  # 查询失败 → 断开，下次重连
        return None


def to_baostock_code(symbol):
    """A股 6 位数字 → Baostock 格式（600519 -> sh.600519、000001 -> sz.000001）"""
    s = str(symbol).strip().lower()
    if s.startswith(("sh", "sz", "bj")):
        return s[:2] + "." + s[2:]
    if s.isdigit() and len(s) == 6:
        return ("sh." if s[0] in "69" else "sz.") + s
    return s


def _start_date(count):
    """按根数推算起始日期（含冗余，保证足够数据）"""
    today = datetime.date.today()
    start = today - datetime.timedelta(days=int(count * 1.6) + 120)
    return start.strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")


def query_history(symbol, frequency="d", count=BAOSTOCK_DEFAULT_DAYS):
    """查询日/周/月K线（frequency: d/w/m），返回标准化列表或 None"""
    code = to_baostock_code(symbol)
    if not code.startswith(("sh.", "sz.", "bj.")):
        return None  # 非 A 股（美股/港股）Baostock 不支持，由调用方回退
    start, end = _start_date(count)

    def _run():
        rows = []
        rs = bs.query_history_k_data_plus(
            code,
            "date,open,high,low,close,volume,amount",
            start_date=start,
            end_date=end,
            frequency=frequency,
            adjustflag=BAOSTOCK_ADJUST,
        )
        if rs.error_code != "0":
            return None
        while rs.next():
            r = rs.get_row_data()
            rows.append(
                {
                    "date": r[0],
                    "open": _f(r[1]),
                    "high": _f(r[2]),
                    "low": _f(r[3]),
                    "close": _f(r[4]),
                    "volume": _f(r[5]),
                }
            )
        if not rows:
            return None
        return rows

    rows = _query(_run)
    if not rows:
        return None
    rows = [r for r in rows if r["close"] is not None and r["open"] is not None]
    rows.sort(key=lambda x: x["date"])
    return rows or None


def query_minute(symbol, frequency="5", count=320):
    """查询分钟K线（frequency: 5/15/30/60），Baostock 分钟线保留近期数据"""
    code = to_baostock_code(symbol)
    if not code.startswith(("sh.", "sz.", "bj.")):
        return None

    def _run():
        rows = []
        rs = bs.query_history_k_data_plus(
            code,
            "date,time,open,high,low,close,volume",
            start_date=(datetime.date.today() - datetime.timedelta(days=15)).strftime("%Y-%m-%d"),
            end_date=datetime.date.today().strftime("%Y-%m-%d"),
            frequency=frequency,
            adjustflag=BAOSTOCK_ADJUST,
        )
        if rs.error_code != "0":
            return None
        while rs.next():
            r = rs.get_row_data()
            dt = f"{r[0]} {r[1]}" if r[1] else r[0]
            rows.append(
                {
                    "date": dt,
                    "open": _f(r[2]),
                    "high": _f(r[3]),
                    "low": _f(r[4]),
                    "close": _f(r[5]),
                    "volume": _f(r[6]),
                }
            )
        if not rows:
            return None
        return rows

    rows = _query(_run)
    if not rows:
        return None
    rows = [r for r in rows if r["close"] is not None and r["open"] is not None]
    rows.sort(key=lambda x: x["date"])
    return rows or None


def _f(v):
    try:
        f = float(v)
        return f if f == f else None  # NaN -> None
    except (TypeError, ValueError):
        return None
