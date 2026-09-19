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
const { writeJsonAtomic } = require('../atomic-write.cjs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'ai');
const SEED_FILE = path.join(__dirname, '..', '..', 'ai-training', 'dataset', 'fin_seed.jsonl');
const KNOWLEDGE_FILE = path.join(DATA_DIR, 'knowledge.json');
const TAGS_FILE = path.join(DATA_DIR, 'knowledge-tags.json');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.jsonl');
const FEEDBACK_ARCHIVE_FILE = path.join(DATA_DIR, 'feedback-archive.jsonl');
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const TRAIN_LOG = path.join(DATA_DIR, 'train.log');
const MAX_ENTRIES = 500;

let knowledge = { entries: [] }; // {id, q, a, source, createdAt, hits, weight}
let state = { trainedAt: null, trainCount: 0, lastNightly: null, pendingQuestions: [] };

function init() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // 内置种子知识（ai-training 数据集同步注入：无需云端，本地知识库即拥有金融领域问答能力）
    if (fs.existsSync(SEED_FILE)) {
      for (const line of fs.readFileSync(SEED_FILE, 'utf8').trim().split('\n').filter(Boolean)) {
        try {
          const o = JSON.parse(line);
          const u = (o.messages ?? []).find((m) => m.role === 'user');
          const a = (o.messages ?? []).find((m) => m.role === 'assistant');
          if (u && a && !knowledge.entries.some((e) => normalizeQ(e.q) === normalizeQ(u.content))) {
            knowledge.entries.push({
              id: 'seed-' + normalizeQ(u.content).slice(0, 16),
              q: u.content, a: a.content, source: 'builtin',
              createdAt: new Date().toISOString(), hits: 0, weight: 1.2,
            });
          }
        } catch { /* 跳过坏行 */ }
      }
    }
    if (fs.existsSync(KNOWLEDGE_FILE)) {
      try {
        const saved = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
        // 增量合并：种子知识 + 用户教学/反馈条目（按问题去重，不互相覆盖）
        if (Array.isArray(saved.entries)) {
          for (const e of saved.entries) {
            if (!knowledge.entries.some((x) => normalizeQ(x.q) === normalizeQ(e.q))) knowledge.entries.push(e);
          }
        }
      } catch {
        /* 忽略损坏文件 */
      }
    }
    // A2 · 加载知识标签映射（确定性标签器产出），使 lookup() 中「标签参与分词」的分支真正生效。
    //      此前 50 条知识全部无 tags，标签分支从未触发，同义问法检索不到。
    if (fs.existsSync(TAGS_FILE)) {
      try {
        const tagMap = JSON.parse(fs.readFileSync(TAGS_FILE, 'utf8')).tags ?? {};
        let tagged = 0;
        for (const e of knowledge.entries) {
          const t = tagMap[normalizeQ(e.q)];
          if (Array.isArray(t) && t.length && !(e.tags ?? []).length) {
            e.tags = t;
            tagged += 1;
          }
        }
        console.log(`[AI Brain] 知识标签已装载: ${tagged}/${knowledge.entries.length} 条`);
      } catch (err) {
        console.warn('[AI Brain] 标签映射加载失败:', err.message);
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
    writeJsonAtomic(KNOWLEDGE_FILE, knowledge, true);
    writeJsonAtomic(STATE_FILE, state, true);
  } catch (e) {
    console.warn('[AI Brain] 持久化失败:', e.message);
  }
}

/** 追加一行 JSONL；仅当文件体积超过阈值时才读取并裁剪（避免每次写入都全量读盘） */
const LINE_LOG_MAX_BYTES = Math.max(Number(process.env.AI_LOG_MAX_BYTES) || 1_500_000, 200_000);
function appendLine(file, obj) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
    // 语料上限保护：先用 statSync 做廉价门禁，超过阈值才读取并裁掉前一半。
    // 原实现在每次追加后都 readFileSync 整个文件再数行——而 recordQA/recordFeedback
    // 都在问答热路径上，文件越大单次请求越慢，且同步读会阻塞事件循环。
    const { size } = fs.statSync(file);
    if (size > LINE_LOG_MAX_BYTES) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(file, lines.slice(-Math.floor(lines.length / 2)).join('\n') + '\n', 'utf8');
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

/**
 * 条目匹配打分：2-gram 重合度 + 标签直击加成
 *   · 2-gram 重合度对「同义改写」鲁棒性差（问句里大量口语噪声 gram 会稀释分值）；
 *   · A2 补齐的标签是领域同义词（ROE/净资产收益率、MACD/金叉…），标签原文出现在问句中
 *     是远比 2-gram 更可靠的命中信号，因此作为加成项参与打分——这也是标签体系的实际价值所在。
 */
function scoreEntry(e, words, rawQ) {
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
  const nq = normalizeQ(rawQ);
  let tagHits = 0;
  if (nq) {
    for (const t of e.tags ?? []) {
      const nt = normalizeQ(t);
      if (nt.length >= 2 && nq.includes(nt)) tagHits += 1;
    }
  }
  const base = overlap / Math.max(words.length, 1);
  const score = Math.min(1, base + Math.min(tagHits, 3) * 0.35);
  return { overlap, tagHits, score, weighted: score * (0.6 + (0.4 * Math.min(e.weight ?? 1, 3)) / 3) };
}

/** 取最匹配条目（threshold 为加权分门槛） */
function bestEntry(q, threshold) {
  const words = tokenize(q);
  if (!words.length) return null;
  let best = null;
  let bestScore = 0;
  for (const e of knowledge.entries) {
    const { overlap, weighted } = scoreEntry(e, words, q);
    if (overlap >= 1 && weighted > bestScore) {
      bestScore = weighted;
      best = e;
    }
  }
  return best && bestScore >= threshold ? { entry: best, score: bestScore } : null;
}

/**
 * A1 · 反馈定位对应知识条目：优先精确匹配，其次模糊匹配（阈值与检索一致）。
 * 语义依据：反馈针对的是「用户实际拿到的回答」——若该回答来自知识库，检索必然已命中（≥0.45）；
 * 若未命中（云端/规则引擎作答），则无条目可调，反馈转入归档语料，属于正确行为而非缺陷。
 * 原实现只做精确匹配 —— 用户问句与知识条目几乎不可能逐字相同，导致反馈权重永不生效、闭环空转。
 */
function findEntryFor(q) {
  const exact = knowledge.entries.find((x) => normalizeQ(x.q) === normalizeQ(q));
  if (exact) return { entry: exact, matched: 'exact' };
  const hit = bestEntry(q, 0.45);
  return hit ? { entry: hit.entry, matched: 'fuzzy' } : null;
}

/** 模糊检索知识库：返回 {entry, score} 或 null */
function lookup(q) {
  const hit = bestEntry(q, 0.45);
  if (!hit) return null;
  hit.entry.hits = (hit.entry.hits ?? 0) + 1;
  persist();
  return { entry: hit.entry, score: +Math.min(hit.score, 1).toFixed(2) };
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
  // A1 · 实时反馈：调整「最匹配」知识条目的权重（精确 → 模糊两级定位，见 findEntryFor）
  const hit = findEntryFor(question);
  if (!hit) {
    return { ok: true, applied: false, reason: '未匹配到对应知识条目（反馈已落盘，将在夜间重放时再次尝试）' };
  }
  const delta = rating === 'up' ? 0.5 : -0.7;
  hit.entry.weight = +((hit.entry.weight ?? 1) + delta).toFixed(2);
  persist();
  return { ok: true, applied: true, matched: hit.matched, entryId: hit.entry.id, weight: hit.entry.weight };
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
          const hit = findEntryFor(f.question);
          if (hit) {
            if (f.rating === 'up') { hit.entry.weight = +((hit.entry.weight ?? 1) + 0.2).toFixed(2); report.promoted += 1; }
            if (f.rating === 'down') { hit.entry.weight = +((hit.entry.weight ?? 1) - 0.3).toFixed(2); report.demoted += 1; }
          }
        } catch { /* 跳过坏行 */ }
      }
      // A1 · 重放后**归档**而非丢弃：反馈是全平台最稀缺的监督信号，必须沉淀为训练语料。
      //      原实现直接清空，等同把数据烧掉——反馈闭环「有回流、无沉淀」。
      if (lines.length) {
        try {
          fs.appendFileSync(FEEDBACK_ARCHIVE_FILE, lines.join('\n') + '\n', 'utf8');
          report.archived = lines.length;
        } catch { /* 归档失败不阻塞主流程 */ }
      }
      fs.writeFileSync(FEEDBACK_FILE, '', 'utf8'); // 清空待处理队列（原始数据已归档）
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
  const archiveLines = (() => {
    try { return fs.readFileSync(FEEDBACK_ARCHIVE_FILE, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; }
  })();
  return {
    knowledge: knowledge.entries.length,
    tagsCovered: knowledge.entries.filter((e) => (e.tags ?? []).length > 0).length,
    feedbackArchive: archiveLines,
    trainCount: state.trainCount ?? 0,
    trainedAt: state.trainedAt,
    lastNightly: state.lastNightly,
    pendingQuestions: (state.pendingQuestions ?? []).length,
    sample: knowledge.entries.slice(0, 5).map((e) => ({ q: e.q, source: e.source, weight: +(e.weight ?? 1).toFixed(2), tags: (e.tags ?? []).length })),
  };
}

module.exports = { init, addEntry, lookup, recordQA, recordFeedback, nightlyTrain, stats, findEntryFor };
