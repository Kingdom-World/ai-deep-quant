# ─────────────────────────────────────────────────────────────
# AI深度量化 · Render 部署用 Baostock 后端（可选）
#
# ⚠️ 部署前须知（批判性评估结论）：
#   1. Render 免费实例位于海外（美国 Oregon），访问 Baostock 国内服务器
#      稳定性未知（可能与 Vercel 一样存在连通性问题），请部署后先验证 /health 与 /api/history；
#   2. Render 免费实例无持久磁盘：SQLite 缓存会随实例重启/休眠丢失，
#      且 15 分钟无访问会休眠（唤醒约 10-15 秒）；
#   3. 本后端仅支持 A 股（Baostock 数据范围），美股/港股请继续使用轻量后端；
#   4. 若仅需公网演示，推荐直接使用 Vercel 上已部署的轻量后端（免费、无冷启动、双源）。
#
# 部署：Render → New Web Service → 关联仓库 → 启动命令 python render_app.py
# ─────────────────────────────────────────────────────────────
import datetime
import os
import socket
import threading

# 强制 IPv4 解析（部分网络下 IPv6 不可达会导致每次请求超时回退）
_orig_getaddrinfo = socket.getaddrinfo


def _ipv4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)


socket.getaddrinfo = _ipv4_getaddrinfo

import baostock as bs  # noqa: E402
from flask import Flask, jsonify, request  # noqa: E402
from flask_cors import CORS  # noqa: E402

app = Flask(__name__)
CORS(app)

_connected = False
_lock = threading.Lock()


def _login():
    global _connected
    if _connected:
        return True
    try:
        lg = bs.login()
        _connected = lg.error_code == "0"
    except Exception:
        _connected = False
    return _connected


def _logout():
    global _connected
    if _connected:
        try:
            bs.logout()
        except Exception:
            pass
        _connected = False


def _query(fn):
    """加锁执行查询；失败断开重连重试一次"""
    with _lock:
        for _ in (0, 1):
            if not _login():
                return None
            try:
                r = fn()
                if r is not None:
                    return r
            except Exception:
                pass
            _logout()
        return None


def to_baostock_code(symbol):
    """统一为 Baostock 格式：600519 -> sh.600519；sh.600519 / sh600519 原样归一"""
    s = str(symbol).strip().lower()
    if s.startswith(("sh.", "sz.", "bj.")):
        return s  # 已是 Baostock 格式
    if s.startswith(("sh", "sz", "bj")):
        return s[:2] + "." + s[2:]
    if s.isdigit() and len(s) == 6:
        return ("sh." if s[0] in "69" else "sz.") + s
    return s


@app.route("/api/history", methods=["GET"])
def get_history():
    """历史K线（响应格式与前端 stockDataService 兼容）
    参数兼容：symbol（前端）/ code（手动测试）均可；count（根数）/ start_date+end_date 均可"""
    symbol = request.args.get("symbol") or request.args.get("code", "600519")
    count = min(int(request.args.get("count", 500)), 2000)
    freq = request.args.get("frequency", "1d")
    freq_map = {"1d": "d", "1w": "w", "1M": "m"}
    frequency = freq_map.get(freq, "d")
    code = to_baostock_code(symbol)
    if not code.startswith(("sh.", "sz.", "bj.")):
        return (
            jsonify({"error": "Render-Baostock 后端仅支持 A 股，请使用轻量后端"}),
            400,
        )
    start = request.args.get(
        "start_date",
        (
            datetime.date.today() - datetime.timedelta(days=int(count * 1.6) + 120)
        ).strftime("%Y-%m-%d"),
    )
    end = request.args.get("end_date", datetime.date.today().strftime("%Y-%m-%d"))

    def run():
        rs = bs.query_history_k_data_plus(
            code,
            "date,code,open,high,low,close,volume",
            start_date=start,
            end_date=end,
            frequency=frequency,
            adjustflag="3",
        )
        if rs.error_code != "0":
            return None
        rows = []
        while rs.next():
            r = rs.get_row_data()
            rows.append(
                {
                    "date": r[0],
                    "code": r[1],
                    "open": float(r[2]),
                    "close": float(r[3]),
                    "high": float(r[4]),
                    "low": float(r[5]),
                    "volume": float(r[6]),
                }
            )
        return rows or None

    klines = _query(run)
    if not klines:
        return jsonify({"error": "未获取到数据（海外节点访问 Baostock 可能不稳定）"}), 500
    klines.sort(key=lambda x: x["date"])
    return jsonify(
        {
            "symbol": symbol,
            "frequency": freq,
            "source": "baostock",
            "fromCache": False,
            "count": len(klines),
            "klines": klines,
        }
    )


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "name": "AI深度量化 Render-Baostock 后端"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
