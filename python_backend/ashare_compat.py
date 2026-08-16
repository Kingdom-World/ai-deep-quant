# ─────────────────────────────────────────────────────────────
# Ashare 兼容数据源（实时行情辅助源）
#   原 Ashare（github.com/AshareHe/ashare）为轻量 A 股行情库，
#   官方仓库已不可访问，此文件实现与其相同语义的兼容层：
#     get_stock(code) -> dict（实时报价）
#   内部数据源：腾讯行情接口（qt.gtimg.cn，GBK 编码）
#   · 仅供学术研究演示使用，数据版权归原数据源所有
# ─────────────────────────────────────────────────────────────
import re
import socket
import time

import requests

# 强制 IPv4 解析：部分网络环境下 IPv6 不可达，默认解析会先尝试
# AAAA 记录导致每次请求超时回退（6s+），大幅拖慢实时行情获取。
_orig_getaddrinfo = socket.getaddrinfo


def _ipv4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)


socket.getaddrinfo = _ipv4_getaddrinfo

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
)


def _normalize(code):
    """统一为腾讯代码：600519->sh600519、sh000001->sh000001、INX->usINX、AAPL->usAAPL"""
    c = str(code).strip()
    low = c.lower()
    if low.startswith(("sh", "sz", "hk", "us")):
        return low[:2] + c[2:]
    if c.isdigit():
        if len(c) == 6:
            return ("sh" if c[0] in "69" else "sz") + c
        if len(c) == 5:
            return "hk" + c
    if re.fullmatch(r"[A-Za-z]{1,6}", c):
        return "us" + c.upper()
    return low


def _fetch(code):
    """请求腾讯行情并解析为 dict；失败返回 None"""
    # 使用 http（与既有稳定实现一致；https 在部分网络下连接缓慢）
    url = f"http://qt.gtimg.cn/q={code}"
    try:
        r = requests.get(
            url,
            headers={"User-Agent": UA, "Referer": "http://finance.qq.com"},
            timeout=6,
        )
        r.encoding = "gbk"
        text = r.text
    except Exception:
        return None
    m = re.search(r'"([^"]*)"', text)
    if not m or not m.group(1):
        return None
    parts = m.group(1).split("~")
    if len(parts) < 34:
        return None

    def num(v):
        try:
            f = float(v)
            return f
        except (TypeError, ValueError):
            return None

    price = num(parts[3])
    prev_close = num(parts[4])
    open_ = num(parts[5])
    if price is None or price <= 0:
        return None
    is_cn = code.startswith(("sh", "sz"))
    volume = num(parts[6])
    if volume is not None and is_cn:
        volume = volume * 100  # A股成交量单位为手，转为股
    change_pct = ((price - prev_close) / prev_close * 100) if prev_close and prev_close > 0 else 0
    return {
        "symbol": code,
        "name": parts[1] or code,
        "price": price,
        "prevClose": prev_close,
        "open": open_,
        "high": num(parts[33]),
        "low": num(parts[34]),
        "volume": volume,
        "changePercent": round(change_pct, 2),
        "timestamp": int(time.time() * 1000),
        "source": "ashare(tencent)",
    }


def get_stock(code):
    """实时报价：兼容 Ashare.get_stock 语义，返回 dict（失败返回 None）"""
    tcode = _normalize(code)
    if tcode.startswith("us"):
        # 美股：探测交易所后缀（usAAPL.OQ / usAAPL.N）
        for suffix in (".OQ", ".N", ".A"):
            q = _fetch(tcode + suffix)
            if q:
                q["symbol"] = tcode
                return q
        return _fetch(tcode)
    return _fetch(tcode)


def get_stocks(codes):
    """批量实时报价（腾讯支持逗号分隔，单次请求）"""
    tcodes = [_normalize(c) for c in codes]
    url = f"http://qt.gtimg.cn/q={','.join(tcodes)}"
    try:
        r = requests.get(
            url,
            headers={"User-Agent": UA, "Referer": "http://finance.qq.com"},
            timeout=6,
        )
        r.encoding = "gbk"
        text = r.text
    except Exception:
        return {}
    result = {}
    for tcode in tcodes:
        m = re.search(rf'v_{re.escape(tcode)}="([^"]*)"', text)
        if not m or not m.group(1):
            continue
        parts = m.group(1).split("~")
        if len(parts) < 34:
            continue

        def num(v):
            try:
                return float(v)
            except (TypeError, ValueError):
                return None

        price = num(parts[3])
        prev_close = num(parts[4])
        if price is None or price <= 0:
            continue
        is_cn = tcode.startswith(("sh", "sz"))
        volume = num(parts[6])
        if volume is not None and is_cn:
            volume = volume * 100
        change_pct = ((price - prev_close) / prev_close * 100) if prev_close and prev_close > 0 else 0
        result[tcode] = {
            "symbol": tcode,
            "name": parts[1] or tcode,
            "price": price,
            "prevClose": prev_close,
            "open": num(parts[5]),
            "high": num(parts[33]),
            "low": num(parts[34]),
            "volume": volume,
            "changePercent": round(change_pct, 2),
            "timestamp": int(time.time() * 1000),
            "source": "ashare(tencent)",
        }
    return result
