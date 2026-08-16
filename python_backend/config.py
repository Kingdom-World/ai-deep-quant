# ─────────────────────────────────────────────────────────────
# AI深度量化 · Python 后端配置
# 数据源架构：
#   历史K线/技术指标 → Baostock（主源）
#   实时行情/指数    → Ashare 兼容层（辅助源，新浪/腾讯公开接口）
# 合规定位：学生学术研究演示，非营利，不构成投资建议
# ─────────────────────────────────────────────────────────────
import os

# 服务端口
PORT = int(os.environ.get("PY_PORT", "5000"))

# 数据目录（SQLite 缓存文件存放处）
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "quant_cache.db")

# ── 缓存有效期（秒） ──
KLINE_CACHE_TTL = 24 * 3600      # 历史K线缓存 24 小时（核心合规要求）
QUOTE_CACHE_TTL = 8              # 实时报价缓存 8 秒
INDEX_CACHE_TTL = 15             # 大盘指数缓存 15 秒
MKLINE_CACHE_TTL = 3600          # 分钟K线缓存 1 小时
MINUTE_CACHE_TTL = 8             # 当日分时缓存 8 秒
SEARCH_CACHE_TTL = 60            # 搜索缓存 60 秒

# ── 限流（单用户，即单 IP） ──
RATE_LIMIT_MAX = 10              # 每分钟最多 10 次请求（合规要求）
RATE_LIMIT_WINDOW = 60           # 时间窗口（秒）
RATE_LIMIT_EXEMPT = {            # 豁免限流的路径（健康/状态类，供监控使用）
    "/api/health",
    "/api/cache/status",
    "/api/rate/status",
}

# ── 定时更新任务 ──
SCHEDULE_TIME = "16:00"          # 每日收盘后自动更新缓存
HOT_STOCKS = [                   # 热门 A 股池（定时任务刷新用）
    "600519", "000001", "300750", "002230", "601318", "000858",
    "601899", "002594", "600036", "000333", "600276", "601012",
]

# ── Baostock ──
BAOSTOCK_ADJUST = "2"            # 复权方式：2=前复权
BAOSTOCK_DEFAULT_DAYS = 2500     # 默认拉取天数（约 10 年日线）

# 大盘指数列表（腾讯/新浪代码）
INDICES = [
    {"symbol": "sh000001", "name": "上证指数"},
    {"symbol": "sh000300", "name": "沪深300"},
    {"symbol": "sz399001", "name": "深证成指"},
    {"symbol": "usINX", "name": "标普500"},
    {"symbol": "usIXIC", "name": "纳斯达克"},
    {"symbol": "usDJI", "name": "道琼斯"},
]

# 推荐股票池（AI 评分用，与前端一致）
STOCK_POOL = [
    {"symbol": "600519", "name": "贵州茅台", "market": "CN"},
    {"symbol": "000001", "name": "平安银行", "market": "CN"},
    {"symbol": "002230", "name": "科大讯飞", "market": "CN"},
    {"symbol": "300750", "name": "宁德时代", "market": "CN"},
    {"symbol": "601318", "name": "中国平安", "market": "CN"},
    {"symbol": "000858", "name": "五粮液", "market": "CN"},
    {"symbol": "601899", "name": "紫金矿业", "market": "CN"},
    {"symbol": "002594", "name": "比亚迪", "market": "CN"},
    {"symbol": "600036", "name": "招商银行", "market": "CN"},
    {"symbol": "000333", "name": "美的集团", "market": "CN"},
]
