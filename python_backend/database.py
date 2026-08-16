# ─────────────────────────────────────────────────────────────
# SQLite 本地持久化缓存层
#   · 历史K线缓存 24 小时（合规要求：24h 内再次访问不调用数据源）
#   · 实时报价 8s / 指数 15s / 分钟K线 1h / 搜索 60s
#   · 记录命中/未命中统计，供 /api/cache/status 展示
# ─────────────────────────────────────────────────────────────
import json
import os
import sqlite3
import threading
import time

from config import (
    DB_PATH,
    DATA_DIR,
    INDEX_CACHE_TTL,
    KLINE_CACHE_TTL,
    MKLINE_CACHE_TTL,
    MINUTE_CACHE_TTL,
    QUOTE_CACHE_TTL,
    SEARCH_CACHE_TTL,
)

_lock = threading.Lock()
_stats = {"kline_hits": 0, "kline_misses": 0, "quote_hits": 0, "quote_misses": 0}


def _conn():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    with _lock, _conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS kline_cache (
                symbol     TEXT PRIMARY KEY,
                frequency  TEXT NOT NULL DEFAULT 'day',
                start_date TEXT,
                end_date   TEXT,
                data       TEXT NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS quote_cache (
                symbol     TEXT PRIMARY KEY,
                data       TEXT NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS index_cache (
                key        TEXT PRIMARY KEY,
                data       TEXT NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS misc_cache (
                key        TEXT PRIMARY KEY,
                data       TEXT NOT NULL,
                updated_at REAL NOT NULL
            );
            """
        )


def _get(table, key_col, key, ttl):
    with _lock, _conn() as conn:
        row = conn.execute(
            f"SELECT data, updated_at FROM {table} WHERE {key_col} = ?", (key,)
        ).fetchone()
    if not row:
        return None, False
    data, updated_at = row
    if time.time() - updated_at < ttl:
        return json.loads(data), True
    return None, False


def _set(table, key_col, key, data):
    payload = json.dumps(data, ensure_ascii=False)
    with _lock, _conn() as conn:
        conn.execute(
            f"INSERT INTO {table} ({key_col}, data, updated_at) VALUES (?, ?, ?) "
            f"ON CONFLICT({key_col}) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            (key, payload, time.time()),
        )


# ── 历史 K 线（24h 缓存） ──
def get_kline(symbol, frequency="day"):
    data, hit = _get("kline_cache", "symbol", f"{symbol}|{frequency}", KLINE_CACHE_TTL)
    if hit:
        _stats["kline_hits"] += 1
    else:
        _stats["kline_misses"] += 1
    return data


def set_kline(symbol, frequency, start_date, end_date, klines, source=None):
    payload = {
        "symbol": symbol,
        "frequency": frequency,
        "start_date": start_date,
        "end_date": end_date,
        "klines": klines,
        "source": source or "cache",
        "cached_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    _set("kline_cache", "symbol", f"{symbol}|{frequency}", payload)


# ── 实时报价（8s 缓存） ──
def get_quote(symbol):
    data, hit = _get("quote_cache", "symbol", symbol, QUOTE_CACHE_TTL)
    if hit:
        _stats["quote_hits"] += 1
    else:
        _stats["quote_misses"] += 1
    return data


def set_quote(symbol, quote):
    _set("quote_cache", "symbol", symbol, quote)


# ── 大盘指数（15s 缓存） ──
def get_index(key):
    data, hit = _get("index_cache", "key", key, INDEX_CACHE_TTL)
    return data


def set_index(key, data):
    _set("index_cache", "key", key, data)


# ── 通用短缓存（分钟K线/分时/搜索等） ──
def get_misc(key, ttl):
    data, _ = _get("misc_cache", "key", key, ttl)
    return data


def set_misc(key, data):
    _set("misc_cache", "key", key, data)


# ── 缓存状态（/api/cache/status） ──
def cache_status():
    with _lock, _conn() as conn:
        k = conn.execute("SELECT COUNT(*), COALESCE(MAX(updated_at),0) FROM kline_cache").fetchone()
        q = conn.execute("SELECT COUNT(*), COALESCE(MAX(updated_at),0) FROM quote_cache").fetchone()
        i = conn.execute("SELECT COUNT(*), COALESCE(MAX(updated_at),0) FROM index_cache").fetchone()
        m = conn.execute("SELECT COUNT(*), COALESCE(MAX(updated_at),0) FROM misc_cache").fetchone()
        latest = conn.execute(
            "SELECT symbol, updated_at FROM kline_cache ORDER BY updated_at DESC LIMIT 1"
        ).fetchone()
    db_size = os.path.getsize(DB_PATH) if os.path.exists(DB_PATH) else 0
    fmt = lambda ts: time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts)) if ts else None
    return {
        "database": DB_PATH,
        "db_size_bytes": db_size,
        "kline_entries": k[0],
        "kline_last_update": fmt(k[1]),
        "quote_entries": q[0],
        "index_entries": i[0],
        "misc_entries": m[0],
        "stats": dict(_stats),
        "ttl": {
            "kline": KLINE_CACHE_TTL,
            "quote": QUOTE_CACHE_TTL,
            "index": INDEX_CACHE_TTL,
        },
        "latest_kline": {"symbol": latest[0], "updated_at": fmt(latest[1])} if latest else None,
    }


def clear_cache():
    with _lock, _conn() as conn:
        for t in ("kline_cache", "quote_cache", "index_cache", "misc_cache"):
            conn.execute(f"DELETE FROM {t}")
    return True
