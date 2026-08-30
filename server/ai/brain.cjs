// ─────────────────────────────────────────────────────────────
// AI 助手大脑：知识库 / 反馈学习 / 会话记录 / 每日自训练
//   · lookup()：中文 2-gram 模糊匹配知识库，命中则直接回答（带学习标注）
//   · recordQA()：所有问答落入 history.jsonl，作为训练语料
//   · recordFeedback()：点赞/点踩 → 实时调整对应知识条目权重
//   · nightlyTrain()：每日 02:30（维护窗口内）自我迭代——重放反馈、升降权、
//     剪枝低质条目、汇总高频未命中问题到待学习清单，训练报告写入 train.log 并反哺平台
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'ai');
const KNOWLEDGE_FILE = path.join(DATA_DIR, 'knowledge.json');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.jsonl');
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const TRAIN_LOG = path.join(DATA_DIR, 'train.log');
const MAX_ENTRIES = 500;

let knowledge = { entries: [] }; // {id, q, a, source, createdAt, hits, weight}
let state = { trainedAt: null, trainCount: 0, lastNightly: null, pendingQuestions: [] };

function init() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(KNOWLEDGE_FILE)) {
      try {
        knowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
        if (!Array.isArray(knowledge.entries)) knowledge = { entries: [] };
      } catch {
        knowledge = { entries: [] };
      }
    }
    if (fs.existsSync(STATE_FILE)) {
      try {
        state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
      } catch { /* 保持默认 */ }
    }
  } catch (e) {
    console.warn('[AI Brain] 初始化降级（只读文件系统）:', e.message);
  }
}

function persist() {
  try {
    const tmp = `${KNOWLEDGE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(knowledge, null, 2), 'utf8');
    fs.renameSync(tmp, KNOWLEDGE_FILE);
    const st = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(st, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(st, STATE_FILE);
  } catch (e) {
    console.warn('[AI Brain] 持久化失败:', e.message);
  }
}

function appendLine(file, obj) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
    // 语料上限保护：超过 4000 行时只保留最近 2000 行
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      if (lines.length > 4000) fs.writeFileSync(file, lines.slice(-2000).join('\n') + '\n', 'utf8');
    }
  } catch { /* 只读 FS 忽略 */ }
}

/** 中文 2-gram 分词（兼顾英文单词） */
function tokenize(s) {
  const t = String(s || '')
    .toLowerCase()
    .replace(/[？?！!。，,、.\s：:（）()【】\[\]]+/g, '');
  const grams = [];
  for (let i = 0; i < t.length - 1; i++) grams.push(t.slice(i, i + 2));
  if (t.length === 1) grams.push(t);
  const words = String(s || '').toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
  return [...grams, ...words];
}

function normalizeQ(s) {
  return String(s || '').toLowerCase().replace(/[？?！!。，,、.\s：:（）()【】\[\]]+/g, '');
}

function addEntry(q, a, source = 'user') {
  const nq = normalizeQ(q);
  if (!nq || !String(a || '').trim()) return { ok: false, error: '问题和答案都不能为空' };
  const dup = knowledge.entries.find((e) => normalizeQ(e.q) === nq);
  if (dup) {
    dup.a = String(a).trim(); // 覆盖更新
    dup.weight = (dup.weight ?? 1) + 0.5;
    dup.updatedAt = new Date().toISOString();
    persist();
    return { ok: true, updated: true };
  }
  knowledge.entries.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    q: String(q).trim(),
    a: String(a).trim(),
    source,
    createdAt: new Date().toISOString(),
    hits: 0,
    weight: 1,
  });
  if (knowledge.entries.length > MAX_ENTRIES) knowledge.entries.length = MAX_ENTRIES;
  persist();
  return { ok: true };
}

/** 模糊检索知识库：返回 {entry, score} 或 null */
function lookup(q) {
  const words = tokenize(q);
  if (!words.length) return null;
  let best = null;
  let bestScore = 0;
  for (const e of knowledge.entries) {
    const eWords = new Set(tokenize(e.q + ' ' + (e.tags ?? []).join(' ')));
    let overlap = 0;
    for (const w of words) {
      for (const ew of eWords) {
        if (ew.includes(w) || w.includes(ew)) {
          overlap += 1;
          break;
        }
      }
    }
    const score = overlap / Math.max(words.length, 1);
    const weighted = score * (0.6 + (0.4 * Math.min(e.weight ?? 1, 3)) / 3);
    if (overlap >= 1 && weighted > bestScore) {
      bestScore = weighted;
      best = e;
    }
  }
  if (!best || bestScore < 0.45) return null;
  best.hits = (best.hits ?? 0) + 1;
  persist();
  return { entry: best, score: +Math.min(bestScore, 1).toFixed(2) };
}

function bumpHits(id) {
  const e = knowledge.entries.find((x) => x.id === id);
  if (e) e.hits = (e.hits ?? 0) + 1;
}

function recordQA(question, answer, meta = {}) {
  appendLine(HISTORY_FILE, { t: new Date().toISOString(), q: String(question || '').slice(0, 200), a: String(answer || '').slice(0, 500), ...meta });
}

function recordFeedback({ question, answer, rating, comment }) {
  appendLine(FEEDBACK_FILE, { t: new Date().toISOString(), rating, question: String(question || '').slice(0, 200), answer: String(answer || '').slice(0, 300), comment: String(comment || '').slice(0, 200) });
  // 实时反馈：调整匹配知识条目的权重（正反馈增强、负反馈削弱）
  const nq = normalizeQ(question);
  const e = knowledge.entries.find((x) => normalizeQ(x.q) === nq);
  if (e) {
    e.weight = (e.weight ?? 1) + (rating === 'up' ? 0.5 : -0.7);
    persist();
  }
  return { ok: true };
}

/** 每日自训练（02:30 维护窗口内调用）：反馈重放 → 升降权 → 剪枝 → 待学习清单 → 反哺 */
function nightlyTrain() {
  const report = {
    at: new Date().toISOString(),
    entriesBefore: knowledge.entries.length,
    promoted: 0,
    demoted: 0,
    pruned: 0,
    pendingAdded: 0,
  };
  try {
    // 1) 重放反馈日志，按累计情绪修正权重
    if (fs.existsSync(FEEDBACK_FILE)) {
      const lines = fs.readFileSync(FEEDBACK_FILE, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const f = JSON.parse(line);
          const e = knowledge.entries.find((x) => normalizeQ(x.q) === normalizeQ(f.question));
          if (e) {
            if (f.rating === 'up') { e.weight = (e.weight ?? 1) + 0.2; report.promoted += 1; }
            if (f.rating === 'down') { e.weight = (e.weight ?? 1) - 0.3; report.demoted += 1; }
          }
        } catch { /* 跳过坏行 */ }
      }
      fs.writeFileSync(FEEDBACK_FILE, '', 'utf8'); // 重放后清空
    }
    // 2) 剪枝：权重过低且被多次使用仍被踩的条目
    const before = knowledge.entries.length;
    knowledge.entries = knowledge.entries.filter((e) => (e.weight ?? 1) > -1 || (e.hits ?? 0) < 3);
    report.pruned = before - knowledge.entries.length;
    // 3) 未命中问题汇总（来自问答历史中规则引擎兜底 type=fallback 的记录）
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        const misses = lines.filter((h) => h.type === 'fallback').map((h) => h.q);
        const uniq = [...new Set(misses)].slice(-30);
        const pending = new Set(state.pendingQuestions ?? []);
        for (const q of uniq) if (!pending.has(q)) { pending.add(q); report.pendingAdded += 1; }
        state.pendingQuestions = [...pending].slice(-30);
      }
    } catch { /* 语料不可用跳过 */ }
    state.trainedAt = report.at;
    state.trainCount = (state.trainCount ?? 0) + 1;
    state.lastNightly = report;
    persist();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(TRAIN_LOG, `[${report.at}] 自训练完成: 条目 ${report.entriesBefore}→${knowledge.entries.length}, 提升 ${report.promoted}, 降权 ${report.demoted}, 剪枝 ${report.pruned}, 待学习 +${report.pendingAdded}\n`, 'utf8');
  } catch (e) {
    console.warn('[AI Brain] 自训练失败:', e.message);
  }
  return report;
}

function stats() {
  return {
    knowledge: knowledge.entries.length,
    trainCount: state.trainCount ?? 0,
    trainedAt: state.trainedAt,
    lastNightly: state.lastNightly,
    pendingQuestions: (state.pendingQuestions ?? []).length,
    sample: knowledge.entries.slice(0, 5).map((e) => ({ q: e.q, source: e.source, weight: +(e.weight ?? 1).toFixed(2) })),
  };
}

module.exports = { init, addEntry, lookup, recordQA, recordFeedback, nightlyTrain, stats };
