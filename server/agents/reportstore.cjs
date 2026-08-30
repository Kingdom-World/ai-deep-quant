// ─────────────────────────────────────────────────────────────
// Agent 团队报告持久化：每次运行保存完整 trace，支持详情查询与历史列表
//   · data/agents/reports/{id}.json —— 完整 trace
//   · data/agents/index.json —— 轻量索引（列表页用，原子写入，上限 200 条）
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'data', 'agents', 'reports');
const INDEX = path.join(__dirname, '..', '..', 'data', 'agents', 'index.json');

function ensure() {
  fs.mkdirSync(DIR, { recursive: true });
}

function saveReport(trace) {
  try {
    ensure();
    const id = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 8);
    const file = path.join(DIR, `${id}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(trace), 'utf8');
    fs.renameSync(tmp, file);
    // 索引
    let index = [];
    try {
      if (fs.existsSync(INDEX)) index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    } catch {
      index = [];
    }
    index.unshift({
      id,
      symbol: trace.symbol,
      name: trace.name ?? '',
      mode: trace.mode,
      decision: trace.final?.decision ?? '',
      ranAt: trace.ranAt,
    });
    if (index.length > 200) index.length = 200;
    const itmp = `${INDEX}.${process.pid}.tmp`;
    fs.writeFileSync(itmp, JSON.stringify(index, null, 2), 'utf8');
    fs.renameSync(itmp, INDEX);
    return id;
  } catch (e) {
    console.error('[AgentReportStore] 保存失败:', e.message);
    return null;
  }
}

function getReport(id) {
  try {
    const file = path.join(DIR, `${String(id).replace(/[^a-z0-9-]/gi, '')}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listReports({ symbol, limit = 20 } = {}) {
  try {
    ensure();
    if (!fs.existsSync(INDEX)) return [];
    let index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    if (symbol) index = index.filter((x) => x.symbol === symbol || x.name === symbol);
    return index.slice(0, Math.min(Math.max(limit, 1), 100));
  } catch {
    return [];
  }
}

module.exports = { saveReport, getReport, listReports };
