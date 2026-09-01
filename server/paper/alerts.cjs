// ─────────────────────────────────────────────────────────────
// 价格监控告警系统（参考 tickflow-stock-panel 监控模块架构）
//   · 用户设置价格阈值（高于/低于），撮合循环每 5 秒检查
//   · 触发后写入 triggered 队列，前端轮询消费并弹 toast
//   · 持久化 data/paper/alerts.json（原子写入，重启不丢）
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ALERTS_FILE = path.join(__dirname, '..', '..', 'data', 'paper', 'alerts.json');

let alerts = []; // {id, uid, symbol, name, condition: 'above'|'below', price, createdAt, triggeredAt?, triggeredPrice?}
let triggered = []; // {id, alertId, uid, symbol, name, condition, price, triggeredPrice, at}

function load() {
  try {
    if (fs.existsSync(ALERTS_FILE)) {
      const d = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
      alerts = d.alerts ?? [];
      triggered = d.triggered ?? [];
    }
  } catch (e) {
    console.error('[Alerts] 加载失败:', e.message);
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(ALERTS_FILE), { recursive: true });
    const tmp = `${ALERTS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ alerts, triggered }, null, 2), 'utf8');
    fs.renameSync(tmp, ALERTS_FILE);
  } catch (e) {
    console.error('[Alerts] 持久化失败:', e.message);
  }
}

function add(uid, { symbol, name, condition, price }) {
  symbol = String(symbol || '').trim();
  condition = ['above', 'below'].includes(condition) ? condition : 'above';
  price = Number(price);
  if (!symbol) return { ok: false, error: '缺少股票代码' };
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: '价格必须为正数' };
  if (alerts.some((a) => a.uid === uid && a.symbol === symbol && a.condition === condition && a.price === price)) {
    return { ok: false, error: '相同条件的告警已存在' };
  }
  const alert = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    uid, symbol, name: name || symbol, condition, price,
    createdAt: new Date().toISOString(),
  };
  alerts.unshift(alert);
  if (alerts.length > 200) alerts.length = 200;
  save();
  return { ok: true, alert };
}

function remove(uid, id) {
  const i = alerts.findIndex((a) => a.id === id && a.uid === uid);
  if (i < 0) return { ok: false, error: '告警不存在' };
  alerts.splice(i, 1);
  save();
  return { ok: true };
}

function list(uid) {
  return alerts.filter((a) => a.uid === uid);
}

function listTriggered(uid) {
  return triggered.filter((t) => t.uid === uid).slice(-20);
}

/** 撮合循环调用：检查所有告警，触发的移入 triggered 队列 */
function checkAlerts(priceMap) {
  // priceMap: Map<symbol, price>（由撮合循环批量查询）
  const fired = [];
  for (const a of alerts) {
    if (a.triggeredAt) continue;
    const price = priceMap.get(a.symbol);
    if (!Number.isFinite(price)) continue;
    const hit = (a.condition === 'above' && price >= a.price) || (a.condition === 'below' && price <= a.price);
    if (hit) {
      a.triggeredAt = new Date().toISOString();
      a.triggeredPrice = price;
      const evt = {
        id: a.id + '-t',
        alertId: a.id,
        uid: a.uid,
        symbol: a.symbol,
        name: a.name,
        condition: a.condition,
        price: a.price,
        triggeredPrice: price,
        at: a.triggeredAt,
      };
      triggered.push(evt);
      if (triggered.length > 200) triggered.splice(0, triggered.length - 200);
      fired.push(evt);
    }
  }
  if (fired.length) save();
  return fired;
}

function clearTriggered(uid) {
  triggered = triggered.filter((t) => t.uid !== uid);
  save();
}

module.exports = { load, save, add, remove, list, listTriggered, checkAlerts, clearTriggered };
