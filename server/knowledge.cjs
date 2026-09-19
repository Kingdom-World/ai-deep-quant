// ─────────────────────────────────────────────────────────────
// 知识库（M1-1.3）：结构化条目的加载与检索
//
//   设计要点：
//   ① **内容与代码同仓**：条目存 server/knowledge/*.json，随代码版本管理——
//      知识库是"可核查承诺"的载体（每条必带 source），必须可追溯、可评审、可 diff，
//      故不放 data/（data/ 在 .gitignore 内，是运行时数据）。
//   ② **线性过滤即可**：条目量级 40 上下，远未到需要倒排索引的门槛；
//      引入索引引擎只增加复杂度与出错面。实测全量扫描 <1ms。
//   ③ **打分可解释**：命中位置分档（标题 > 标签 > 正文 > 出处），
//      便于前端展示"为什么这条被检索到"，也便于用户判断相关性。
//   ④ **零依赖**：不引入检索库，纯字符串匹配 + 权重排序。
//
//   检索口径（与 UI 提示一致）：
//     · 查询串按空白/逗号切分为词项，全部词项都命中才算匹配（AND 语义，减少噪声）
//     · 大小写不敏感；中文无需分词（子串匹配）
//     · category 可选过滤（term/basis/method/paper）
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

/** 知识库目录（可用环境变量覆盖，便于测试隔离） */
const DIR = process.env.KNOWLEDGE_DIR || path.join(__dirname, 'knowledge');

const CATEGORIES = {
  term: '术语',
  basis: '口径',
  method: '方法论',
  paper: '文献',
};

/** 命中位置权重（标题最重，出处最轻） */
const WEIGHT = { title: 10, tags: 6, body: 3, source: 2 };

let cache = null; // { stamp, entries } —— 按目录 mtime 失效，无需重启

/** 读取目录下全部 json 并展平为条目数组 */
function readAll() {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return out; // 目录不存在视为空库（不抛错，调用方自然降级为空结果）
  }
  for (const f of files.sort()) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      for (const e of doc.entries || []) {
        if (!e || !e.id || !e.title) continue; // 跳过残缺条目，不让一条脏数据毁掉整库
        out.push({
          id: e.id,
          category: e.category || doc.category || 'term',
          categoryLabel: CATEGORIES[e.category || doc.category] || '其他',
          title: e.title,
          body: e.body || '',
          source: e.source || '',
          tags: Array.isArray(e.tags) ? e.tags : [],
          related: Array.isArray(e.related) ? e.related : [],
        });
      }
    } catch {
      // 单个文件损坏不影响其余（内容文件是人工编写，容错优先于报错）
    }
  }
  return out;
}

/** 目录签名：文件数 + 各文件 mtime，任一变则重建缓存 */
function dirStamp() {
  try {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
    const parts = files.map((f) => {
      try { return `${f}:${fs.statSync(path.join(DIR, f)).mtimeMs}`; } catch { return `${f}:0`; }
    });
    return parts.join('|');
  } catch {
    return '';
  }
}

/** 全部条目（带缓存） */
function load() {
  const stamp = dirStamp();
  if (!cache || cache.stamp !== stamp) {
    cache = { stamp, entries: readAll() };
  }
  return cache.entries;
}

/** 查询串切词：空白与逗号分隔，去空、去重、转小写 */
function tokenize(query) {
  return Array.from(
    new Set(
      String(query || '')
        .toLowerCase()
        .split(/[\s,，、]+/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  );
}

/** 中文停用词与疑问尾巴——自然语言提问（"PIT是什么意思"）必须能退化到关键词 */
const STOPWORDS = [
  '是什么意思', '是什么', '什么意思', '怎么处理', '怎么算', '怎么理解', '为什么', '怎么样', '如何',
  '什么意思啊', '的', '是', '啊', '呢', '吗', '请', '帮我', '解释', '说明', '介绍', '一下', '下',
  '平台', '贵平台', '你们', '我们', '这个', '那个', '讲讲', '说说', '告诉我', '查询', '搜索',
];

/**
 * 从自然语言查询中抽取关键词（降级路径）
 *   背景：模型/用户常把整句当查询（"PIT 是什么意思"），而检索是 AND 语义——
 *   整句必然匹配不到。抽出英文词块与中文 n-gram，去掉疑问尾巴，再检索。
 *
 *   ⚠️ n-gram 的噪声控制（这是本函数唯一的难点）：
 *   「zzz绝对不存在zzz」曾切出 10 个片段，其中「对不存」是**跨词边界的碎片**，
 *   凑巧命中了正文里的字串，于是无意义查询返回了 3 条结果。
 *   折中方案：只取**边界对齐**的片段——
 *     · 段首 2-gram（"绝对"）与段尾 2-gram（"存在"）—— 实词的常见形态
 *     · 整段 4-gram（"绝对不存"）—— 保留长词的辨识度
 *     · 中间 2-gram 也保留（"复权幻觉" → "权幻"无用，但"幻觉"这种词内片段必须留）
 *   完全按词典分词需要引入词典依赖（违背 ④ 零依赖），故不追求 100% 准确，
 *   而是**把是否放宽的知情权交给调用方**（mode='keyword' + matched 词项）。
 */
function extractKeywords(query) {
  let s = String(query || '').toLowerCase().trim();
  if (!s) return [];
  // 去停用词（长的先替换，避免"是什么意思"被"是"先吃掉）
  for (const w of [...STOPWORDS].sort((a, b) => b.length - a.length)) {
    s = s.split(w).join(' ');
  }
  const words = [];
  // 英文/数字词块（含内部连字符，如 newey-west）
  for (const m of s.matchAll(/[a-z][a-z0-9-]{1,}/g)) words.push(m[0]);
  // 中文连续段 → 边界对齐 n-gram
  for (const seg of s.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (seg.length >= 2) words.push(seg); // 整段优先（最可信）
    if (seg.length <= 4) continue;
    for (let i = 2; i <= 3; i++) {
      for (let j = 0; j + i <= seg.length; j++) {
        const g = seg.slice(j, j + i);
        // 去掉首尾被中文包夹的碎片：只保留贴着段边界、或本身是完整实词候选的片段
        const atStart = j === 0;
        const atEnd = j + i === seg.length;
        // 中间的 2-gram 一律保留（"复权幻觉"→"幻觉"就是这样切出来的），
        // 但 3-gram 只保留贴边界的（"对不存"这类跨边界 3-gram 噪声最大，直接弃用）
        if (i === 3 && !atStart && !atEnd) continue;
        words.push(g);
      }
    }
  }
  return Array.from(new Set(words.filter((w) => w.length >= 2 || /^[a-z]/.test(w))));
}

/** 单词项在单条上的命中得分（0 表示未命中该词） */
function scoreToken(entry, tok) {
  let s = 0;
  if (entry.title.toLowerCase().includes(tok)) s += WEIGHT.title;
  if (entry.tags.some((t) => String(t).toLowerCase().includes(tok))) s += WEIGHT.tags;
  if (entry.body.toLowerCase().includes(tok)) s += WEIGHT.body;
  if (entry.source.toLowerCase().includes(tok)) s += WEIGHT.source;
  return s;
}

/** 对候选池执行一次 AND 检索 */
function runAnd(pool, tokens) {
  const hits = [];
  for (const e of pool) {
    let total = 0;
    const matched = [];
    let allHit = true;
    for (const t of tokens) {
      const s = scoreToken(e, t);
      if (s === 0) { allHit = false; break; } // AND 语义：任一词未命中即淘汰
      total += s;
      matched.push(t);
    }
    if (allHit) hits.push({ ...e, score: total, matched });
  }
  return hits;
}

/**
 * 检索条目
 *   两级策略（因为自然语言提问与 AND 检索语义天然冲突）：
 *     ① 严格：按查询切词做 AND（用户输入多关键词时精准）
 *     ② 降级：严格无命中时，抽关键词再做 OR（取任一命中，按得分排序）——
 *        这是"PIT是什么意思"这类整句提问能工作的关键，否则模型/用户会得到空结果。
 *   响应带 mode 字段说明本次走的哪条路径，便于 UI 提示"已按关键词放宽匹配"。
 * @param query 查询串（可空——空查询返回该分类全部条目，供 UI 首屏浏览）
 * @param opts { category, limit }
 */
function search(query, opts = {}) {
  const all = load();
  const { category, limit = 50 } = opts;
  const pool = category ? all.filter((e) => e.category === category) : all;

  const tokens = tokenize(query);
  if (!tokens.length) {
    // 空查询：按分类顺序返回全部（浏览模式），score 置 0
    return {
      mode: 'browse',
      total: pool.length,
      items: pool.slice(0, limit).map((e) => ({ ...e, score: 0, matched: [] })),
    };
  }

  // ① 严格 AND
  let mode = 'and';
  let hits = runAnd(pool, tokens);

  // ② 降级：抽关键词 + OR
  //    ⚠️ 闸门：OR 很宽松，需要控制噪声（否则无意义的串也会命中一堆条目）。
  //    判据：结果必须满足其一——
  //      a) 有词命中标题或标签（强相关信号）；
  //      b) 至少 2 个不同关键词命中正文（多词共现，比单词偶现可信）；
  //      c) 命中词数 ≥ 关键词总数的 1/3（覆盖率门禁——查询里的实词大多被命中才算相关）。
  //    三者取或：a/b 管"命中得深"，c 管"命中得广"。
  //    即便全不满足，也不假装精确：响应显式带 mode='keyword' 与 matched 词项，
  //    让调用方知道这是放宽匹配的结果（本平台对降级的一贯口径：降级必须可见）。
  if (!hits.length) {
    const kws = extractKeywords(query);
    const strong = kws.filter((k) => k.length >= 2);
    if (strong.length) {
      const byId = new Map();
      for (const kw of strong) {
        for (const h of runAnd(pool, [kw])) {
          const prev = byId.get(h.id);
          byId.set(h.id, prev
            ? { ...prev, score: prev.score + h.score, matched: Array.from(new Set([...prev.matched, ...h.matched])), _bodyHits: (prev._bodyHits || 0) + 1 }
            : { ...h, _bodyHits: 1 });
        }
      }
      const minCov = Math.max(2, Math.ceil(strong.length / 3));
      hits = Array.from(byId.values()).filter(
        (h) =>
          h.score >= WEIGHT.title ||
          h.score >= WEIGHT.body + WEIGHT.tags ||
          (h._bodyHits || 0) >= 2 ||
          h.matched.length >= minCov,
      );
      for (const h of hits) delete h._bodyHits;
      if (hits.length) mode = 'keyword';
    }
  }

  // 同分时按 id 稳定排序，保证结果可复现
  hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return { mode, total: hits.length, items: hits.slice(0, limit) };
}

/** 按 id 批量取条目（关联口径跳转用；不存在的 id 静默忽略） */
function byIds(ids = []) {
  const all = load();
  const map = new Map(all.map((e) => [e.id, e]));
  return ids.map((id) => map.get(id)).filter(Boolean);
}

/** 统计（自检/页头展示用） */
function stats() {
  const all = load();
  const byCategory = {};
  for (const e of all) byCategory[e.category] = (byCategory[e.category] || 0) + 1;
  return { total: all.length, byCategory, withSource: all.filter((e) => e.source).length };
}

/** 分类元数据（供前端渲染过滤器） */
function categories() {
  const all = load();
  const present = new Set(all.map((e) => e.category));
  return Object.keys(CATEGORIES)
    .filter((k) => present.has(k))
    .map((k) => ({ key: k, label: CATEGORIES[k], count: all.filter((e) => e.category === k).length }));
}

module.exports = { search, byIds, stats, categories, CATEGORIES, extractKeywords, DIR };
