# ─────────────────────────────────────────────────────────────
# 单用户限流（合规要求：每分钟最多 10 次请求，超限返回 429）
#   按客户端 IP 维度计数，滑动窗口算法，线程安全。
#   健康/状态类路径豁免（见 config.RATE_LIMIT_EXEMPT）。
# ─────────────────────────────────────────────────────────────
import threading
import time
from collections import defaultdict, deque

from config import RATE_LIMIT_EXEMPT, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW

_buckets = defaultdict(deque)
_lock = threading.Lock()


def check(ip, path):
    """返回 (allowed, retry_after)；retry_after 为秒数"""
    if path in RATE_LIMIT_EXEMPT:
        return True, 0
    now = time.time()
    with _lock:
        dq = _buckets[ip]
        while dq and now - dq[0] > RATE_LIMIT_WINDOW:
            dq.popleft()
        if len(dq) >= RATE_LIMIT_MAX:
            retry = int(RATE_LIMIT_WINDOW - (now - dq[0])) + 1
            return False, max(retry, 1)
        dq.append(now)
        # 防止内存无限增长：周期性清理过期桶
        if len(_buckets) > 10000:
            for k in [k for k, v in _buckets.items() if not v or now - v[-1] > RATE_LIMIT_WINDOW * 2]:
                del _buckets[k]
        return True, 0


def status():
    with _lock:
        return {
            "max_per_minute": RATE_LIMIT_MAX,
            "window_seconds": RATE_LIMIT_WINDOW,
            "tracked_ips": len(_buckets),
            "exempt_paths": sorted(RATE_LIMIT_EXEMPT),
        }
