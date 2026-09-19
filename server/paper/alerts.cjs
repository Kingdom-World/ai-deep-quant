// ─────────────────────────────────────────────────────────────
// 价格监控告警系统（参考 tickflow-stock-panel 监控模块架构）
//   · 用户设置价格阈值（高于/低于），撮合循环每 5 秒检查
//   · 触发后写入 triggered 队列，前端轮询消费并弹 toast
//   · 外发 webhook（评审 P1-6）：.env 配置 ALERT_WEBHOOK 后同步推送外部渠道——
//     此前通知只有 console + 前端 toast，无人值守场景等于没有告警。
//     支持：企业微信机器人（qyapi.weixin.qq.com）/ 钉钉（oapi.dingtalk.com）/
//     Server酱（sctapi.ftqq.com）/ 通用 {text}；5s 超时，失败仅记日志不影响本地队列
//   · 持久化 data/paper/alerts.json（原子写入，重启不丢）
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../atomic-write.cjs');

const ALERTS_FILE = path.join(__dirname, '..', '..', 'data', 'paper', 'alerts.json');

/** 触发事件列表 → 通知文案 */
function buildAlertText(firedList) {
  return firedList
    .map((e) => `${e.name}(${e.symbol}) 现价 ${e.triggeredPrice} ${e.condition === 'above' ? '≥' : '≤'} 阈值 ${e.price}`)
    .join('\n');
}

/** 按 webhook 地址适配报文格式 */
function buildWebhookPayload(url, text) {
  const u = String(url || '');
  if (u.includes('qyapi.weixin.qq.com') || u.includes('oapi.dingtalk.com')) {
    return { msgtype: 'text', text: { content: `[AI量化平台] 告警触发\n${text}` } };
  }
  if (u.includes('sctapi.ftqq.com')) {
    return { title: 'AI量化平台 · 告警触发', desp: text };
  }
  return { text: `[AI量化平台] 告警触发 ${text}` };
}

/** 通用外发（熔断/对账/衰减等系统级通知复用同一通道） */
async function sendExternalMessage(text) {
  const url = String(process.env.ALERT_WEBHOOK || '').trim();
  if (!url) return;
  try {
    const axios = require('axios');
    await axios.post(url, buildWebhookPayload(url, text), {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' },
    });
    console.log('🔔 [通知] 已推送外部渠道');
  } catch (e) {
    console.error('[Alerts] webhook 推送失败（不影响本地状态）:', e.message?.slice(0, 80));
  }
}

/** 外发通知（fire-and-forget：失败只记日志，不影响本地触发队列） */
async function notifyExternal(firedList) {
  const url = String(process.env.ALERT_WEBHOOK || '').trim();
  if (!url || !firedList?.length) return;
  await sendExternalMessage(`告警触发\n${buildAlertText(firedList)}`);
  console.log(`🔔 [告警] 已推送外部渠道 ${firedList.length} 条`);
}

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
    writeJsonAtomic(ALERTS_FILE, { alerts, triggered }, true);
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

/** 全部告警（后台撮合循环收集标的用，不按 uid 过滤——告警按用户名分账，漏掉任一用户其告警将永不触发） */
function listAll() {
  return alerts;
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

module.exports = { load, save, add, remove, list, listAll, listTriggered, checkAlerts, clearTriggered, notifyExternal, sendExternalMessage, buildAlertText, buildWebhookPayload };
