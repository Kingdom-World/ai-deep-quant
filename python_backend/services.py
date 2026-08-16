# ─────────────────────────────────────────────────────────────
# 业务聚合服务层
#   前端只接收聚合后的展示数据（合规要求：不对外暴露原始行情接口）。
#   数据源路由：历史→Baostock（主源），实时→Ashare 兼容层（辅助源）。
# ─────────────────────────────────────────────────────────────
import datetime
import json
import re
import socket
import time

import requests

# 强制 IPv4 解析（原因见 ashare_compat.py 顶部注释）
_orig_getaddrinfo = socket.getaddrinfo


def _ipv4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)


socket.getaddrinfo = _ipv4_getaddrinfo

import ashare_compat
import baostock_source
import database
from config import (
    HOT_STOCKS,
    INDICES,
    MINUTE_CACHE_TTL,
    MKLINE_CACHE_TTL,
    SEARCH_CACHE_TTL,
    STOCK_POOL,
)

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
)


# ─────────────────────────────────────────────────────────────
# 历史K线（主源：Baostock；24h SQLite 缓存）
# ─────────────────────────────────────────────────────────────
def get_history(symbol, count=500):
    sym = str(symbol).strip().upper()
    if not sym:
        return None
    cached = database.get_kline(sym, "day")
    if cached:
        cached.setdefault("source", "cache")
        cached["fromCache"] = True
        return cached
    klines = None
    source = None
    # A 股 → Baostock 主源
    if sym.isdigit() and len(sym) == 6:
        klines = baostock_source.query_history(sym, "d", count)
        source = "baostock"
    if not klines:
        # 非 A 股或 Baostock 失败 → 腾讯 K 线补充源（美股带交易所后缀探测）
        klines, source = _tencent_history(sym, count)
    if not klines:
        return None
    payload = {
        "symbol": sym,
        "frequency": "1d",
        "source": source,
        "start_date": klines[0]["date"],
        "end_date": klines[-1]["date"],
        "count": len(klines),
        "klines": klines,
        "cached_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "fromCache": False,
    }
    database.set_kline(
        sym, "day", payload["start_date"], payload["end_date"], klines, source
    )
    return payload


def _tencent_history(symbol, count):
    """腾讯 K 线（A股/港股/美股通用补充源）：返回 (klines, source)"""
    if symbol.isdigit() and len(symbol) == 6:
        code = ("sh" if symbol[0] in "69" else "sz") + symbol
    elif symbol.isdigit() and len(symbol) == 5:
        code = "hk" + symbol
    else:
        code = "us" + symbol
    candidates = [f"{code}.OQ", f"{code}.N", code] if code.startswith("us") else [code]
    best = []
    for cand in candidates:
        try:
            url = (
                f"http://web.ifzq.gtimg.cn/appstock/app/fqkline/get?"
                f"param={cand},day,,,{min(count, 2000)},qfq"
            )
            r = requests.get(url, headers={"User-Agent": UA, "Referer": "http://finance.qq.com"}, timeout=8)
            j = r.json()
            node = (j.get("data") or {}).get(cand) or {}
            rows = node.get("qfqday") or node.get("day") or []
            klines = [
                {
                    "date": str(x[0])[:10],
                    "open": _f(x[1]),
                    "close": _f(x[2]),
                    "high": _f(x[3]),
                    "low": _f(x[4]),
                    "volume": _f(x[5]),
                }
                for x in rows
                if len(x) >= 6
            ]
            klines = [k for k in klines if k["close"] is not None]
            if len(klines) > 2:
                return klines, "tencent"
            if len(klines) > len(best):
                best = klines
        except Exception:
            continue
    return (best or None), "tencent"


# ─────────────────────────────────────────────────────────────
# 实时报价（辅助源：Ashare 兼容层）
# ─────────────────────────────────────────────────────────────
def get_quote(symbol):
    sym = str(symbol).strip().upper()
    cached = database.get_quote(sym)
    if cached:
        return cached
    q = ashare_compat.get_stock(sym)
    if not q:
        return None
    q["symbol"] = sym
    database.set_quote(sym, q)
    return q


def get_quotes(symbols):
    """批量报价（收藏/推荐展示用，聚合后返回，避免逐只请求）"""
    result = []
    missing = []
    for s in symbols:
        sym = str(s).strip().upper()
        cached = database.get_quote(sym)
        if cached:
            result.append(cached)
        else:
            missing.append(sym)
    if missing:
        batch = ashare_compat.get_stocks(missing)
        for sym in missing:
            q = batch.get(ashare_compat._normalize(sym))
            if q:
                q["symbol"] = sym
                database.set_quote(sym, q)
                result.append(q)
    return result


def get_indices():
    """大盘指数（Ashare 兼容层，15s 缓存）"""
    cached = database.get_index("all")
    if cached:
        return cached
    items = []
    batch = ashare_compat.get_stocks([i["symbol"] for i in INDICES])
    for idx in INDICES:
        q = batch.get(ashare_compat._normalize(idx["symbol"]))
        if q:
            items.append(
                {
                    "symbol": idx["symbol"],
                    "name": idx["name"],
                    "price": q["price"],
                    "changePercent": q["changePercent"],
                }
            )
    if not items:
        return None
    database.set_index("all", items)
    return items


# ─────────────────────────────────────────────────────────────
# 搜索（新浪 suggest，聚合名称+代码）
# ─────────────────────────────────────────────────────────────
_US_FALLBACK = {
    "AAPL": "苹果", "MSFT": "微软", "NVDA": "英伟达", "GOOGL": "谷歌-A",
    "AMZN": "亚马逊", "META": "Meta", "TSLA": "特斯拉", "AMD": "超威半导体",
    "NFLX": "奈飞", "AVGO": "博通", "INTC": "英特尔", "INX": "标普500",
    "IXIC": "纳斯达克", "DJI": "道琼斯",
}
_CN_NAMES = {
    "600519": "贵州茅台", "000001": "平安银行", "300750": "宁德时代",
    "002230": "科大讯飞", "601318": "中国平安", "000858": "五粮液",
}


def search(keyword):
    kw = str(keyword).strip()
    cached = database.get_misc(f"search:{kw}", SEARCH_CACHE_TTL)
    if cached:
        return cached
    items = []
    try:
        url = f"https://suggest3.sinajs.cn/suggest/type=11,12,13,14,15&key={requests.utils.quote(kw)}"
        r = requests.get(url, headers={"User-Agent": UA, "Referer": "https://finance.sina.com.cn"}, timeout=6)
        r.encoding = "gbk"
        m = re.search(r'"([^"]*)"', r.text)
        if m and m.group(1):
            for part in m.group(1).split("|"):
                seg = part.split(",")
                if len(seg) < 3:
                    continue
                raw = seg[2].strip()
                if re.match(r"^(sh|sz)", raw, re.I):
                    market = "CN"
                elif raw.lower().startswith("hk"):
                    market = "HK"
                elif raw.lower().startswith("us"):
                    market = "US"
                elif re.fullmatch(r"\d{6}", raw):
                    market = "CN"
                elif re.fullmatch(r"\d{5}", raw):
                    market = "HK"
                else:
                    market = "US"
                items.append({"name": seg[0], "code": raw, "market": market})
    except Exception:
        pass
    upper = kw.upper()
    if re.fullmatch(r"[A-Z0-9.]{1,10}", upper):
        if upper in _US_FALLBACK:
            items = [{"name": _US_FALLBACK[upper], "code": upper, "market": "US"}]
        elif re.fullmatch(r"\d{6}", upper):
            items = [{"name": _CN_NAMES.get(upper, upper), "code": upper, "market": "CN"}]
        elif re.fullmatch(r"\d{5}", upper):
            items = [{"name": upper, "code": upper, "market": "HK"}]
        elif re.fullmatch(r"[A-Z]{1,6}", upper) and not any(i["code"].upper() == upper for i in items):
            items.append({"name": _US_FALLBACK.get(upper, upper), "code": upper, "market": "US"})
    if kw in _CN_NAMES:
        items = [{"name": _CN_NAMES[kw], "code": kw, "market": "CN"}]
    database.set_misc(f"search:{kw}", items)
    return items


# ─────────────────────────────────────────────────────────────
# 分钟K线（Baostock 分钟主源；美股新浪 / 港股腾讯分时聚合）
# ─────────────────────────────────────────────────────────────
def get_mkline(symbol, period="5", count=320):
    sym = str(symbol).strip().upper()
    key = f"mkline:{sym}:{period}"
    cached = database.get_misc(key, MKLINE_CACHE_TTL)
    if cached:
        return cached
    klines, source = None, None
    if sym.isdigit() and len(sym) == 6:
        klines = baostock_source.query_minute(sym, period, count)
        source = "baostock"
    if not klines and sym.isalpha() and len(sym) <= 6:
        klines, source = _sina_us_minute(sym, period)
    if not klines and (sym.isdigit() and len(sym) == 5):
        klines, source = _hk_minute_agg(sym, int(period))
    if not klines:
        # 最后回退：腾讯当日分时聚合
        points = get_minute(sym)
        if points:
            klines = _agg_points(points, int(period))
            source = "tencent-minute"
    if not klines:
        return None
    payload = {
        "symbol": sym,
        "period": f"m{period}",
        "source": source,
        "klines": klines[-count:],
    }
    database.set_misc(key, payload)
    return payload


def _sina_us_minute(symbol, period):
    try:
        url = (
            "https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_=/US_MinKService"
            f".getMinK?symbol={symbol.lower()}&type={period}"
        )
        r = requests.get(url, headers={"User-Agent": UA, "Referer": "https://finance.sina.com.cn"}, timeout=8)
        s = r.text.find("([")
        e = r.text.rfind("])")
        if s < 0 or e < 0:
            return None, "sina-us"
        arr = json.loads(r.text[s + 1 : e + 1])
        rows = []
        for x in arr:
            rows.append(
                {
                    "date": str(x.get("d"))[:16],
                    "open": _f(x.get("o")),
                    "close": _f(x.get("c")),
                    "high": _f(x.get("h")),
                    "low": _f(x.get("l")),
                    "volume": _f(x.get("v")),
                }
            )
        rows = [r for r in rows if r["close"] is not None]
        return (rows or None), "sina-us"
    except Exception:
        return None, "sina-us"


def _hk_minute_agg(symbol, step):
    points = _tencent_minute_points(f"hk{symbol}")
    if not points:
        return None, "tencent-minute"
    return _agg_points(points, step), "tencent-minute"


def _tencent_minute_points(code):
    try:
        url = f"https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={code}"
        r = requests.get(url, headers={"User-Agent": UA, "Referer": "http://finance.qq.com"}, timeout=6)
        j = r.json()
        rows = ((j.get("data") or {}).get(code) or {}).get("data", {}).get("data") or []
        now = datetime.datetime.now()
        out = []
        for line in rows:
            p = str(line).strip().split()
            if len(p) < 2:
                continue
            price = _f(p[1])
            if price is None or price <= 0:
                continue
            out.append(
                {
                    "time": f"{p[0][:2]}:{p[0][2:4]}",
                    "price": price,
                    "volume": _f(p[2]) or 0,
                }
            )
        return out
    except Exception:
        return []


def _agg_points(points, step):
    """1分钟点 → N 分钟K线（尾部分组）"""
    if step <= 1:
        return [
            {
                "date": f"{datetime.date.today()} {p['time']}",
                "open": p["price"],
                "close": p["price"],
                "high": p["price"],
                "low": p["price"],
                "volume": p["volume"],
            }
            for p in points
        ]
    out = []
    for i in range(len(points), 0, -step):
        grp = points[max(0, i - step) : i]
        if not grp:
            continue
        out.insert(
            0,
            {
                "date": f"{datetime.date.today()} {grp[-1]['time']}",
                "open": grp[0]["price"],
                "close": grp[-1]["price"],
                "high": max(p["price"] for p in grp),
                "low": min(p["price"] for p in grp),
                "volume": sum(p["volume"] for p in grp),
            },
        )
    return out


def get_minute(symbol):
    """当日分时（聚合数据，仅供前端实时走势展示）"""
    sym = str(symbol).strip().upper()
    cached = database.get_misc(f"minute:{sym}", MINUTE_CACHE_TTL)
    if cached:
        return cached
    if sym.isdigit() and len(sym) == 6:
        code = ("sh" if sym[0] in "69" else "sz") + sym
    elif sym.isdigit() and len(sym) == 5:
        code = "hk" + sym
    else:
        code = "us" + sym
    points = _tencent_minute_points(code)
    if not points:
        return None
    payload = {"symbol": sym, "points": points}
    database.set_misc(f"minute:{sym}", payload)
    return payload


# ─────────────────────────────────────────────────────────────
# 策略回测（服务端计算，基于缓存历史数据）
# ─────────────────────────────────────────────────────────────
def backtest(symbol, strategy="ma", fast=5, slow=20, capital=100000, count=500):
    data = get_history(symbol, min(count, 2000))
    if not data:
        return {"error": "历史数据不足"}
    klines = data["klines"]
    closes = [k["close"] for k in klines]
    n = len(closes)
    if n < 30:
        return {"error": "历史数据不足 30 根，无法回测"}
    fee = 0.001
    fast_sma = _sma(closes, fast)
    slow_sma = _sma(closes, slow)
    rsi = _rsi(closes, 14)
    cash = float(capital)
    shares = 0.0
    position = False
    entry_price = 0.0
    entry_date = ""
    equity = []
    trades = []
    peak = float(capital)
    max_dd_pct = 0.0

    for i in range(n):
        price = closes[i]
        target = position
        if strategy == "buyhold":
            target = True
        elif strategy == "ma":
            if fast_sma[i] is not None and slow_sma[i] is not None:
                target = fast_sma[i] > slow_sma[i]
        elif strategy == "rsi":
            if i >= 1 and rsi[i] is not None and rsi[i - 1] is not None:
                if rsi[i - 1] <= 30 < rsi[i]:
                    target = True
                if rsi[i - 1] >= 70 > rsi[i]:
                    target = False
        if target and not position and cash > price:
            shares = cash * (1 - fee) / price
            cash = 0.0
            position = True
            entry_price = price
            entry_date = klines[i]["date"]
        elif not target and position:
            cash = shares * price * (1 - fee)
            shares = 0.0
            position = False
            trades.append(
                {
                    "entryDate": entry_date,
                    "entryPrice": round(entry_price, 2),
                    "exitDate": klines[i]["date"],
                    "exitPrice": round(price, 2),
                    "pnlPct": round((price - entry_price) / entry_price * 100, 2),
                    "holdDays": i,
                }
            )
        value = cash + shares * price
        equity.append({"date": klines[i]["date"], "value": round(value, 2)})
        peak = max(peak, value)
        dd = (peak - value) / peak if peak else 0
        max_dd_pct = max(max_dd_pct, dd)

    final_value = equity[-1]["value"]
    if position:
        final_value = shares * closes[-1] * (1 - fee)
        trades.append(
            {
                "entryDate": entry_date,
                "entryPrice": round(entry_price, 2),
                "exitDate": klines[-1]["date"],
                "exitPrice": round(closes[-1], 2),
                "pnlPct": round((closes[-1] - entry_price) / entry_price * 100, 2),
                "holdDays": n - 1,
                "forced": True,
            }
        )
        equity[-1] = {"date": klines[-1]["date"], "value": round(final_value, 2)}

    total_return = (final_value / capital - 1) * 100
    years = max(n / 252, 0.25)
    annualized = ((final_value / capital) ** (1 / years) - 1) * 100
    wins = sum(1 for t in trades if t["pnlPct"] > 0)
    win_rate = wins / len(trades) * 100 if trades else 0
    bench_return = (closes[-1] / closes[0] - 1) * 100
    bench_equity = [
        {"date": klines[i]["date"], "value": round(capital / closes[0] * closes[i], 2)}
        for i in range(n)
    ]
    return {
        "symbol": symbol,
        "strategy": strategy,
        "params": {"fast": fast, "slow": slow, "capital": capital},
        "range": {"start": klines[0]["date"], "end": klines[-1]["date"], "bars": n},
        "finalValue": round(final_value, 2),
        "totalReturn": round(total_return, 2),
        "annualized": round(annualized, 2),
        "maxDrawdownPct": round(max_dd_pct * 100, 2),
        "maxDrawdown": round(max_dd_pct * capital, 2),
        "tradeCount": len(trades),
        "winRate": round(win_rate, 1),
        "benchmarkReturn": round(bench_return, 2),
        "trades": trades[-50:],
        "equity": equity,
        "benchmark": bench_equity,
    }


def _sma(values, n):
    out = [None] * len(values)
    s = 0.0
    for i, v in enumerate(values):
        s += v
        if i >= n:
            s -= values[i - n]
        if i + 1 >= n:
            out[i] = s / n
    return out


def _rsi(values, n=14):
    out = [None] * len(values)
    for i in range(len(values)):
        if i < n:
            continue
        gains = losses = 0.0
        for j in range(i - n + 1, i + 1):
            diff = values[j] - values[j - 1]
            if diff >= 0:
                gains += diff
            else:
                losses -= diff
        ag, al = gains / n, losses / n
        out[i] = 100 if al == 0 else 100 - 100 / (1 + ag / al)
    return out


# ─────────────────────────────────────────────────────────────
# 五因子 AI 评分（趋势/动量/量能/波动/位置，0-100）
# ─────────────────────────────────────────────────────────────
def score_stock(klines, quote_price=None):
    closes = [k["close"] for k in klines]
    if len(closes) < 60:
        return {"score": 0, "rating": "数据不足", "note": "历史数据不足 60 个交易日"}
    latest = quote_price or closes[-1]
    score = 0
    notes = []

    def avg(arr, n):
        return sum(arr[-n:]) / n

    ma5, ma20, ma60 = avg(closes, 5), avg(closes, 20), avg(closes, 60)
    if ma5 > ma20 > ma60:
        score += 22
        notes.append("均线多头排列")
    elif ma5 < ma20 < ma60:
        score += 6
        notes.append("均线空头排列")
    else:
        score += 13
        notes.append("均线纠缠")
    if latest > ma20:
        score += 8

    ret20 = (latest / closes[-21] - 1) * 100
    if 5 <= ret20 <= 25:
        score += 15
        notes.append(f"近20日涨幅 {ret20:.1f}%")
    elif ret20 > 25:
        score += 7
        notes.append(f"近20日涨幅过大 {ret20:.1f}%")
    elif ret20 < -10:
        score += 7
        notes.append(f"近20日超跌 {ret20:.1f}%")
    else:
        score += 10
    rsi = _rsi(closes, 14)[-1]
    if rsi is not None and 50 <= rsi <= 70:
        score += 10
        notes.append(f"RSI={rsi:.1f} 强势区间")
    elif rsi is not None and (rsi > 70 or rsi < 30):
        score += 5
        notes.append(f"RSI={rsi:.1f} 极端区间")

    vols = [k.get("volume") or 0 for k in klines]
    v5 = sum(vols[-5:]) / 5
    v20 = sum(vols[-20:-5]) / max(1, len(vols[-20:-5]))
    ratio = v5 / v20 if v20 > 0 else 1
    if ratio > 1.3:
        score += 12
        notes.append(f"量比 {ratio:.2f} 放量")
    elif ratio > 1:
        score += 8
    else:
        score += 4

    rets = [closes[i] / closes[i - 1] - 1 for i in range(1, len(closes)) if closes[i - 1] > 0]
    recent = rets[-20:]
    m = sum(recent) / len(recent)
    var = sum((x - m) ** 2 for x in recent) / len(recent)
    vol_pct = var**0.5 * 100
    score += 12 if 1 <= vol_pct <= 3.5 else 8 if vol_pct < 1 else 5

    high52 = max(k["high"] for k in klines[-250:])
    low52 = min(k["low"] for k in klines[-250:])
    dist_high = (high52 - latest) / high52 * 100
    if dist_high < 10:
        score += 10
        notes.append(f"距52周高点仅 {dist_high:.1f}%")
    elif dist_high < 25:
        score += 7
    else:
        score += 4
    if (latest - low52) / low52 * 100 < 15:
        score += 5

    rating = "强烈关注" if score >= 80 else "关注" if score >= 65 else "中性" if score >= 45 else "谨慎"
    return {"score": score, "rating": rating, "note": "；".join(notes)}


def recommend(count=6):
    """股票池 AI 评分排名（后端聚合，一次请求完成）"""
    results = []
    for item in STOCK_POOL:
        try:
            data = get_history(item["symbol"], 300)
            if not data:
                continue
            q = get_quote(item["symbol"])
            rep = score_stock(data["klines"], q["price"] if q else None)
            results.append(
                {
                    "symbol": item["symbol"],
                    "market": item["market"],
                    "name": item["name"],
                    "price": q["price"] if q else data["klines"][-1]["close"],
                    "changePercent": q["changePercent"] if q else 0,
                    "score": rep["score"],
                    "rating": rep["rating"],
                }
            )
        except Exception:
            continue
    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:count]


# ─────────────────────────────────────────────────────────────
# 网站 AI 问答（离线规则引擎）
# ─────────────────────────────────────────────────────────────
_USAGE_GUIDE = "\n".join(
    [
        "📖 AI深度量化 使用指南",
        "1. 首页查看市场概况（6 大指数）、我的收藏、今日观察（因子评分）。",
        "2. 输入股票代码（如 600519 / 000001 / AAPL / 00700）进入量化看板：",
        "   K线 + MA均线 + MACD + 形态标注；短期副图提供 1~120 分钟 K 线。",
        "3. 「量化因子分析」页面对个股做五因子评分。",
        "4. 「策略回测」支持 MA 双均线 / RSI / 买入持有策略。",
        "5. 问我「分析 600519」「今天观察什么」可获取个股解读与因子评分。",
        "6. 历史数据主源 Baostock，实时行情辅助源（新浪/腾讯公开接口），仅供参考。",
    ]
)


def qa(question):
    q = str(question or "").strip()
    if not q:
        return {"type": "empty", "answer": "请告诉我你的问题，例如「分析 600519」或「平台怎么用？」"}
    if re.search(r"回测|backtest", q, re.I):
        return {
            "type": "guide",
            "answer": "\n".join(
                [
                    "📈 策略回测：",
                    "1. 打开「策略回测」页面（首页功能中心或导航）。",
                    "2. 输入股票代码，选择策略：MA 双均线（默认 5/20）、RSI、买入持有。",
                    "3. 设置初始资金，点击「开始回测」查看收益曲线、回撤、胜率、交易明细。",
                    "回测基于 Baostock 历史日 K（学术演示），含 0.1% 双边手续费，仅供参考。",
                ]
            ),
        }
    if re.search(r"怎么|如何|教程|帮助|使用|操作|入门|指南|help|guide|usage", q, re.I):
        return {"type": "guide", "answer": _USAGE_GUIDE}
    if re.search(r"推荐|选股|观察|机会|评分", q):
        try:
            top = recommend(5)
            lines = ["📊 因子评分观察 Top 5（五因子模型，满分 100）："]
            for i, r in enumerate(top, 1):
                lines.append(f"{i}. {r['symbol']}（{r['name']}）现价 {r['price']:.2f} → {r['score']} 分 · {r['rating']}")
            lines.append("想看某只的详细解读，可以问「分析 <代码>」。")
            return {"type": "recommend", "answer": "\n".join(lines)}
        except Exception as e:
            return {"type": "fallback", "answer": f"推荐计算失败：{e}"}
    symbol = _extract_symbol(q)
    if symbol:
        answer = _analyze(symbol)
        return {"type": "analysis", "symbol": symbol, "answer": answer}
    return {
        "type": "fallback",
        "answer": "\n".join(
            [
                "🤖 我是 AI深度量化 的站内智能助手（离线规则引擎），可以：",
                "· 「分析 600519」—— 个股五因子解读（Baostock 历史 + 实时报价）",
                "· 「今天观察什么」—— 股票池因子评分排名",
                "· 「平台怎么用」—— 使用指南",
                "· 「回测怎么用」—— 策略回测指引",
                "试试输入上面任意一句吧！",
            ]
        ),
    }


def _extract_symbol(q):
    upper = q.upper()
    m = re.search(r"\b((?:SH|SZ|HK|US)\d{5,6}|(?:SH|SZ|HK|US)[A-Z]{1,6})\b", upper)
    if m:
        code = m.group(1)
        return code[2:] if code.startswith("US") else code.lower()
    m = re.search(r"\b(\d{6}|\d{5})\b", upper)
    if m:
        return m.group(1)
    m = re.search(r"\b([A-Z]{2,6})\b", upper)
    if m and m.group(1) not in ("AI", "MACD", "RSI", "ETF", "CEO"):
        return m.group(1)
    for code, name in _US_FALLBACK.items():
        if name and name in q:
            return code
    for code, name in _CN_NAMES.items():
        if name in q:
            return code
    return None


def _analyze(symbol):
    data = get_history(symbol, 250)
    if not data:
        return f"⚠️ 未获取到 {symbol} 的历史数据，请确认代码是否正确。"
    klines = data["klines"]
    closes = [k["close"] for k in klines]
    q = get_quote(symbol)
    latest = q["price"] if q else closes[-1]
    rep = score_stock(klines, q["price"] if q else None)

    def avg(arr, n):
        return round(sum(arr[-n:]) / n, 2) if len(arr) >= n else None

    high52 = max(k["high"] for k in klines[-250:])
    low52 = min(k["low"] for k in klines[-250:])
    pos = (latest - low52) / (high52 - low52) * 100 if high52 > low52 else 0
    lines = [
        f"📊 {symbol}（{q['name'] if q else symbol}） 快速解读",
        f"最新价: {latest:.2f}" + (f"（{q['changePercent']:+.2f}%）" if q and q.get("changePercent") is not None else ""),
        f"MA5: {avg(closes, 5)} | MA20: {avg(closes, 20)} | MA60: {avg(closes, 60)}",
        f"52周区间: {low52:.2f} ~ {high52:.2f}（现价处于 {pos:.0f}% 分位）",
        f"AI 五因子评分: {rep['score']}/100（{rep['rating']}）",
        f"数据源: 历史 Baostock · 实时（新浪/腾讯）",
        "⚠️ 以上为量化指标解读，仅供参考，不构成投资建议。",
    ]
    return "\n".join(lines)


def _f(v):
    try:
        f = float(v)
        return f if f == f else None
    except (TypeError, ValueError):
        return None
