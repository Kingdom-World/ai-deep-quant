# ─────────────────────────────────────────────────────────────
# AI深度量化 · Python 后端（Flask）
#   数据源架构：历史→Baostock（主源，SQLite 24h 缓存）
#              实时→Ashare 兼容层（辅助源，新浪/腾讯公开接口）
#   合规：单用户限流（10 次/分钟，429）；不暴露原始行情接口；
#         学生学术研究演示，非营利，不构成投资建议。
#   启动：python app.py  （默认 http://127.0.0.1:5000）
# ─────────────────────────────────────────────────────────────
import os
import sys
import time

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

import database
import rate_limit
import services
from config import PORT
from scheduler import start_scheduler

app = Flask(__name__)
CORS(app)

APP_NAME = "AI深度量化 Python 数据服务"
APP_VERSION = "2.1.0"

# 生产托管模式：--serve-dist 时由 Flask 托管前端构建产物（单端口整站）
DIST_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "dist")
SERVE_DIST = "--serve-dist" in sys.argv


@app.before_request
def _rate_limit():
    ip = request.headers.get("X-Forwarded-For", request.remote_addr or "unknown").split(",")[0].strip()
    allowed, retry_after = rate_limit.check(ip, request.path)
    if not allowed:
        resp = jsonify(
            error=f"请求过于频繁：单用户每分钟最多 {rate_limit.status()['max_per_minute']} 次，请 {retry_after} 秒后重试"
        )
        resp.status_code = 429
        resp.headers["Retry-After"] = str(retry_after)
        return resp
    return None


# ── 历史 K 线（Baostock 主源 + 24h SQLite 缓存） ──
@app.route("/api/history/<symbol>")
def api_history(symbol):
    count = min(int(request.args.get("count", 500)), 2000)
    data = services.get_history(symbol, count)
    if not data:
        return jsonify(error=f"未获取到 {symbol} 的历史数据"), 500
    resp = {
        "symbol": data["symbol"],
        "frequency": "1d",
        "source": data["source"],
        "fromCache": bool(data.get("fromCache", False)),
        "klines": data["klines"][-count:],
    }
    return jsonify(resp)


# ── 实时报价（Ashare 辅助源） ──
@app.route("/api/quote/<symbol>")
def api_quote(symbol):
    q = services.get_quote(symbol)
    if not q:
        return jsonify(error=f"未获取到 {symbol} 的实时报价"), 404
    return jsonify(q)


# ── 批量报价（聚合接口：收藏/推荐一次获取） ──
@app.route("/api/quotes")
def api_quotes():
    symbols = [s for s in request.args.get("symbols", "").split(",") if s.strip()]
    if not symbols:
        return jsonify([])
    return jsonify(services.get_quotes(symbols[:30]))


# ── 大盘指数 ──
@app.route("/api/indices")
def api_indices():
    items = services.get_indices()
    if not items:
        return jsonify(error="获取指数失败"), 500
    return jsonify(items)


# ── 搜索 ──
@app.route("/api/search/<keyword>")
def api_search(keyword):
    return jsonify(services.search(keyword))


# ── 分钟 K 线 ──
@app.route("/api/mkline/<symbol>")
def api_mkline(symbol):
    period = str(request.args.get("period", "m5")).replace("m", "")
    if period not in ("1", "5", "15", "30", "60"):
        period = "5"
    count = min(int(request.args.get("count", 320)), 800)
    data = services.get_mkline(symbol, period, count)
    if not data:
        return jsonify(error=f"获取分钟K线失败: {symbol}"), 500
    data["klines"] = data["klines"][-count:]
    return jsonify(data)


# ── 当日分时 ──
@app.route("/api/minute/<symbol>")
def api_minute(symbol):
    data = services.get_minute(symbol)
    if not data:
        return jsonify(error=f"获取分时数据失败: {symbol}"), 500
    return jsonify(data)


# ── 策略回测 ──
@app.route("/api/backtest")
def api_backtest():
    symbol = request.args.get("symbol", "600519")
    strategy = request.args.get("strategy", "ma")
    fast = min(max(int(request.args.get("fast", 5)), 2), 120)
    slow = min(max(int(request.args.get("slow", 20)), fast + 1), 250)
    capital = min(max(int(request.args.get("capital", 100000)), 1000), 10**9)
    count = min(int(request.args.get("count", 500)), 2000)
    result = services.backtest(symbol, strategy, fast, slow, capital, count)
    if "error" in result:
        return jsonify(result), 400
    return jsonify(result)


# ── 今日观察（后端聚合评分） ──
@app.route("/api/recommend")
def api_recommend():
    count = min(int(request.args.get("count", 6)), 10)
    return jsonify(services.recommend(count))


# ── 网站 AI 问答 ──
@app.route("/api/qa")
def api_qa():
    q = request.args.get("q", "")
    return jsonify(services.qa(q))


# ── 健康检查 ──
@app.route("/api/health")
def api_health():
    return jsonify(
        {
            "ok": True,
            "name": APP_NAME,
            "version": APP_VERSION,
            "uptime": int(time.time() - app_start_time),
            "cacheSize": database.cache_status()["kline_entries"],
            "rateLimit": rate_limit.status()["max_per_minute"],
            "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
    )


# ── 缓存状态（24h 缓存验证） ──
@app.route("/api/cache/status")
def api_cache_status():
    return jsonify(database.cache_status())


# ── 限流状态 ──
@app.route("/api/rate/status")
def api_rate_status():
    return jsonify(rate_limit.status())


# ── 清理缓存（管理用） ──
@app.route("/api/cache/clear", methods=["POST"])
def api_cache_clear():
    database.clear_cache()
    return jsonify({"ok": True})


@app.errorhandler(404)
def not_found(e):
    return jsonify(error="接口不存在（AI深度量化仅提供聚合数据接口）"), 404


# ── 生产托管：前端 dist 静态资源 + SPA 回退（--serve-dist 模式） ──
if SERVE_DIST and os.path.isdir(DIST_DIR):
    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def spa(path):
        if path.startswith("api/") or path.startswith("api"):
            return jsonify(error="接口不存在"), 404
        fp = os.path.join(DIST_DIR, path)
        if path and os.path.isfile(fp):
            return send_from_directory(DIST_DIR, path)
        return send_from_directory(DIST_DIR, "index.html")


app_start_time = time.time()

if __name__ == "__main__":
    database.init_db()
    start_scheduler()
    print(f"[OK] {APP_NAME} started: http://127.0.0.1:{PORT}")
    print(f"   - history(Baostock): http://127.0.0.1:{PORT}/api/history/600519")
    print(f"   - quote(Ashare):     http://127.0.0.1:{PORT}/api/quote/600519")
    print(f"   - indices:           http://127.0.0.1:{PORT}/api/indices")
    print(f"   - cache status:      http://127.0.0.1:{PORT}/api/cache/status")
    print(f"   - rate status:       http://127.0.0.1:{PORT}/api/rate/status")
    print(f"   - rate limit:        {rate_limit.status()['max_per_minute']} req/min per user")
    app.run(host="0.0.0.0", port=PORT, threaded=True)
