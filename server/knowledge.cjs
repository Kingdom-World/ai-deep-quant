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
//     · layers 可选多值过滤（教学五层，供学习路径批量取）；category 保留单类筛选
//
// ── 知识库 2.0（计划书 §11.1）新增的三条硬约束 ──
//   ① **两个维度**：教学五层（LAYERS：术语/方法/原理/案例/周期专题）与平台辅助类
//      （AUX：口径/文献）分开。存量 basis 是"平台自身的计算口径"，属辅助类而非教学层 ——
//      混进五层会让学习路径出现"平台费率口径"这种教学上无意义的内容。
//   ② **发布门**：无 source（出处）的条目标记 `draft:true`，**不进检索结果**，
//      只计入 `stats().draft`。这给「AI 生成初稿 → 人工审核补出处 → 发布」提供
//      数据模型支撑，而不是靠人记着"这条还没审"。
//   ③ **结构化字段可选**：summary/formula/applicability/limitations/teachingModel
//      缺失时按"降级到 body"展示，不强制回填（回填历史内容属内容工作，不在地基范围）。
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

/** 知识库目录（可用环境变量覆盖，便于测试隔离） */
const DIR = process.env.KNOWLEDGE_DIR || path.join(__dirname, 'knowledge');

/**
 * 🔴 知识库 2.0 的**两个维度**（计划书 §11.1）：
 *   ① 教学五层（LAYERS）—— 学科知识，是 Learn 学习路径的编排依据；
 *  ② 平台辅助类（AUX）—— 平台自身的计算口径与权威文献，**不是教学层**。
 *
 *   为什么必须分维：存量 `basis`（"本平台每一项计算所采用的具体口径与依据"）
 *   是**平台特有**的，既不是术语也不是方法。硬塞进五层会让学习路径混入
 *   "平台的费率口径"这种教学上无意义的内容。
 *
 *   ⚠️ 存量 label 刻意**不改**（方法论/口径/文献），避免影响前端既有显示；
 *      新增三层才用计划书措辞（原理/案例/周期专题）。
 *
 *   ⚠️ 下面的常量**不在本文件定义**（#70）：单一源在 shared/knowledge-layers.cjs，
 *      前端也从那里 import —— 否则前端那份联合类型会缺 3 个层而后端加层时静默失效。
 *      本文件继续 re-export（既有 require 方零变化）。
 */
const { LAYERS, AUX, CATEGORIES, LAYER_KEYS, isTeachingLayer } = require('../shared/knowledge-layers.cjs');
// 🔴 出处结构化是**派生**的，不是另存一份（#71）。
//   为什么不把解析结果写进 JSON 与 source 并存：两份表示必然分叉，
//   而"哪个是真的"无法判定 —— 违背口径单一源纪律。派生保证同源同果。
const { parseSource, citationStrength } = require('../shared/knowledge-source.cjs');

/** 命中位置权重（标题最重，出处最轻） */
const WEIGHT = { title: 10, tags: 6, body: 3, source: 2 };

/** 出处强度档位顺序（弱 → 强）。取最强时按序比大小，勿写死布尔比较。 */
const STRENGTH_ORDER = ['none', 'existential', 'structured', 'verifiable'];

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
        const cat = e.category || doc.category || 'term';
        const source = typeof e.source === 'string' ? e.source.trim() : '';
        out.push({
          id: e.id,
          category: cat,
          categoryLabel: CATEGORIES[cat] || '其他',
          isTeachingLayer: isTeachingLayer(cat),
          title: e.title,
          body: e.body || '',
          // ── 知识库 2.0 结构化字段（§11.1：定义/公式/适用场景/局限/出处）──
          //   全部**可选**：存量 49 条只有 body，缺失时按"降级到 body"展示，
          //   不强制回填（回填 49 条历史内容是内容工作，不属于地基）。
          summary: typeof e.summary === 'string' ? e.summary : '',
          formula: typeof e.formula === 'string' ? e.formula : '',
          applicability: typeof e.applicability === 'string' ? e.applicability : '',
          limitations: typeof e.limitations === 'string' ? e.limitations : '',
          /** 教学用模型（Phase 1 Model JSON 的 key）：cycle/case 条目可挂教学实验 */
          teachingModel: e.teachingModel || null,
          /**
           * 教学说明：挂着这个模型，学生**具体观察什么**（2026-10-07 补）。
           * 🔴 为什么必需：独立审查发现 4 条 case 的 teachingModel 全指向
           *   `mom20-baseline`，而条目讲的是崩盘机制/杠杆相关性/估值重定价 ——
           *   看着像"随便挑了个存在的模板"。原先那条测试只校验 key 存在，
           *   区分不了"语义贴切"与"碰巧合法"，属**假通过**。
           *   有了 note，链接就从断言变成了可核查的教学设计；
           *   模板确实不适用时置 teachingModel: null 并在 note 里说明理由（不硬凑）。
           */
          teachingNote: typeof e.teachingNote === 'string' ? e.teachingNote : '',
          /**
           * 🔴 出处结构化（#71，**派生**而非另存）：从 source 文本解析出来，
           *   不写进 JSON —— 两份表示必然分叉，且分叉后无法判定哪个是真的。
           *   供前端展示「本条出处可核查到什么强度」，也让 tools/verify-sources.cjs
           *   能直接复用，不必二次解析（避免两处解析规则漂移）。
           */
          sourceRefs: (() => {
            const p = parseSource(source);
            return p.refs.map((r) => ({
              kind: r.kind,
              strength: citationStrength(r),
              doi: r.doi,
              year: r.year,
              container: r.container,
              title: r.title,
            }));
          })(),
          /** 本条 source 里最强的一条引用强度（verifiable > structured > existential > none） */
          citationStrength: (() => {
            const p = parseSource(source);
            if (!p.refs.length) return 'none';
            const order = ['none', 'existential', 'structured', 'verifiable'];
            return p.refs.reduce(
              (best, r) => (order.indexOf(citationStrength(r)) > order.indexOf(best) ? citationStrength(r) : best),
              'none',
            );
          })(),
          source,
          /**
           * 🔴 发布门（§11.1「无出处的条目不发布」）：
           *    无 source ⇒ 标记为**草稿**，不进检索结果，只计入 stats.draft。
           *    这给「AI 生成初稿 → 人工审核补出处 → 发布」一个数据模型支撑，
           *    而不是靠人记着"这条还没审"。
           */
          draft: !source,
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

// 🔴 本函数专用的疑问词剥离（比 extractKeywords 的 STOPWORDS 更狠）。
//   实测踩过：「米哈游是什么」切成 2 字片后，残留的「什么」命中了
//   标题「多重比较：**什么**是试得越多越容易骗自己」⇒ 无关查询被判命中。
//   根因：疑问词不是实词，让它参与片段匹配必然产生这类假阳性。
//   与 extractKeywords 用同一份词表（口径单一源），但这里**额外**保留
//   「/」等未在其列表中的高频疑问形态。
const QUESTION_TAILS = [
  '这是什么意思', '是什么意思', '什么意思', '是什么', '什么是', '怎么理解', '怎么算', '怎么处理', '如何理解',
  '为什么', '怎么样', '有什么', '为什么是', '是什么呀', '到底',
  '的', '是', '啊', '呢', '吗', '呀', '了', '请问', '请', '帮我', '一下', '下',
];

/**
 * 🔴 复合词兜底（#72）：查询被拆成「连续片段」，逐片在条目里找，
 *   绕开 2-gram 的跨词边界噪声。
 *
 *   实测缺陷：`基钦周期` 检索不到，而 `基钦` 能（条目 cycle-kitchin「基钦库存周期」存在）。
 *   根因：`基钦周期` → tokens `["基钦","钦周","周期"]`，其中 `钦周` 是**跨词边界垃圾**
 *   （基钦|周期 的跨界组合），任何条目都不含它 ⇒ AND 语义下整条被淘汰。
 *
 *   ⚠️⚠️ 第一版实现是错的（自己踩过）：原写成「查询整串必须是条目的子串」，
 *   但 `基钦周期` **不是** `基钦库存周期` 的子串（中间隔了「库存」）⇒ 修复无效。
 *   第二版把 4 字整段当单片也不对（`基钦周期` 整段同样找不到）。
 *   最终版：**整段与 2 字切分同时产出**，由「命中片段数」门槛来筛 ——
 *   只取整段会漏，只取切分会引入噪声，两者都产出才稳。
 *
 *   🔴 为什么不能只靠"加进白名单"：任何 n-gram 方案都会产出跨边界碎片，
 *   枚举是打地鼠（下一个词还会漏）。
 *   🔴 为什么插在 OR 降级**之前**：OR 会把碎片噪声一起放进来
 *   （"zzz绝对不存在zzz" 曾返回 3 条）。片段命中是**强信号**。
 */
function runSubstring(pool, query) {
  // 🔴 必须先剥离疑问尾巴，否则「周期是什么」这类正常问法会失效
  let cleaned = String(query || '').toLowerCase().trim();
  for (const w of [...QUESTION_TAILS].sort((a, b) => b.length - a.length)) {
    cleaned = cleaned.split(w).join(' ');
  }
  cleaned = cleaned.replace(/[？?！!。，,、.：:（）()【】\[\]]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 2) return []; // 过短（如"夏"）噪声太大，不走这层

  // 切连续片段：英文词块 + 中文连续段
  // 🔴 中文段**总是**同时产出「整段」与「2 字切分」两种片段，交给打分去争：
  //   「基钦周期」(4 字) 整段在标题里找不到（标题是「基钦库存周期」），
  //   但切出的「基钦」+「周期」两片都能命中 —— 只取整段会漏，只取切分会引入噪声，
  //   两者都产出、由"命中片段数"门槛来筛，才是稳的。
  const frags = [];
  for (const m of cleaned.matchAll(/[a-z][a-z0-9-]{1,}/g)) frags.push(m[0]);
  for (const seg of cleaned.match(/[一-龥]+/g) || []) {
    if (seg.length >= 3) frags.push(seg); // 整段（长词辨识度高，如「最大回撤」）
    for (let i = 0; i + 2 <= seg.length; i += 2) frags.push(seg.slice(i, i + 2)); // 2 字片
  }
  const uniq = Array.from(new Set(frags.filter((f) => f.length >= 2)));
  if (!uniq.length) return [];

  const hits = [];
  for (const e of pool) {
    const title = e.title.toLowerCase();
    const tags = e.tags.map((t) => String(t).toLowerCase());
    const body = e.body.toLowerCase();
    let score = 0;
    const matched = [];
    for (const f of uniq) {
      // 出处不参与（是英文文献名，中文查询几乎不可能命中，计进去只添噪声）
      let s = 0;
      if (title.includes(f)) s = Math.max(s, WEIGHT.title);
      if (tags.some((t) => t.includes(f))) s = Math.max(s, WEIGHT.tags);
      if (body.includes(f)) s = Math.max(s, WEIGHT.body);
      if (s > 0) { score += s; matched.push(f); }
    }
    if (!matched.length) continue;
    // 🔴 命中门槛：≥2 片命中，或单片命中标题/标签。
    //   只命中 1 片且只在正文 ⇒ 大概率是撞词，不足以作为"复合词命中"。
    const inTitle = matched.some((f) => title.includes(f));
    const inTags = matched.some((f) => tags.some((t) => t.includes(f)));
    if (matched.length < 2 && !inTitle && !inTags) continue;
    hits.push({ ...e, score: score * (1 + (matched.length - 1) * 0.5), matched });
  }
  return hits;
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
  const { category, layers, limit = 50, includeDraft = false } = opts;
  // 🔴 发布门：草稿（无出处）不进检索；includeDraft 仅供管理/审核视图
  let pool = includeDraft ? all : all.filter((e) => !e.draft);
  // layers 优先于 category（学习路径按层批量取；category 保留给单类筛选的既有调用方）
  if (Array.isArray(layers) && layers.length) pool = pool.filter((e) => layers.includes(e.category));
  else if (category) pool = pool.filter((e) => e.category === category);

  const tokens = tokenize(query);
  if (!tokens.length) {
    // 空查询：按分类顺序返回全部（浏览模式），score 置 0
    return {
      mode: 'browse',
      total: pool.length,
      items: pool.slice(0, limit).map((e) => ({ ...e, score: 0, matched: [] })),
    };
  }

  // ①-b 复合词兜底（#72）：AND 全失败时，先试「查询片段命中」。
  //   🔴 关键修正（实测回归）：本层最初插在 OR 降级**之前**，结果抢走了排序位 ——
  //     「PIT是什么意思」原本 term-pit 排第 1，被 basis-financial-pubdate 挤到第 2；
  //     「涨跌停规则怎么处理的」basis-limit-guard 也丢了首位。
  //   原因：OR 降级会**按词项覆盖度打分**，天然把"命中多个词"的条目排前面，质量更高；
  //   而片段层只按片段数累加，容易让"命中标题一个字"的长条目虚高。
  //   ⇒ 顺序必须是：**AND → OR（既有路径，语义最宽且打分最好）→ 复合词兜底**。
  //   这样复合词层只在既有两条路都空手而归时才兜底，绝不影响既有排序。
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

  // ③ 复合词兜底（#72）：AND 与 OR 都空手时才跑。
  //   🔴 顺序理由见上方①-b 注释：抢在 OR 之前会夺走既有排序位（实测 term-pit 被挤到第 2）。
  //   ⚠️ mode 独立标记为'substring'：调用方需要区分「放宽到词项」与「识别出复合词」——
  //   后者置信度更高（查询片段确实出现在标题/标签里）。
  if (!hits.length) {
    const sub = runSubstring(pool, query);
    if (sub.length) {
      hits = sub;
      mode = 'substring';
    }
  }

  // 同分时按 id 稳定排序，保证结果可复现
  hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return { mode, total: hits.length, items: hits.slice(0, limit) };
}

/**
 * 按 id 批量取条目（关联口径跳转用；不存在的 id 静默忽略）
 *
 * 🔴 发布门同样适用于此（2026-10-07 修）：原先这里直接 `load()` 全量返回，
 *   等于**绕过 search 的发布门**——草稿（无出处、尚未过审）只要知道 id 就能读出全文。
 *   攻击面不是"内容涉密"而是"审核流程形同虚设"：草稿的存在本身就是"还没审完"的信号，
 *   一旦可读，被审中的错误结论（如审查中发现公式写错的那几条）就与已发布内容无法区分。
 *   故默认与 search 对齐过滤 draft；管理/审核视图显式传 includeDraft 才拿得到。
 *
 * ⚠️ 这里**不自带鉴权**：调用方（路由层）必须自己把 includeDraft 绑到 admin 校验上，
 *    否则等于白改。见 server/routes/knowledge-screener.cjs。
 * @param {string[]} ids
 * @param {{includeDraft?:boolean}} [opts] includeDraft 仅供管理/审核视图
 */
function byIds(ids = [], opts = {}) {
  const all = load();
  const { includeDraft = false } = opts;
  const pool = includeDraft ? all : all.filter((e) => !e.draft);
  const map = new Map(pool.map((e) => [e.id, e]));
  return ids.map((id) => map.get(id)).filter(Boolean);
}

/** 统计（自检/页头展示用） */
function stats() {
  const all = load();
  const byCategory = {};
  for (const e of all) byCategory[e.category] = (byCategory[e.category] || 0) + 1;
  // 教学五层各自规模（Phase 2.5 的规模目标就以此为准：term 80-120 / method 80-100 / …）
  const byLayer = {};
  for (const k of LAYER_KEYS) byLayer[k] = byCategory[k] || 0;
  const published = all.filter((e) => !e.draft);
  // 🔴 已发布口径的分层计数（2026-10-07 补）。
  //   为什么必须与 byLayer 并存：byLayer 走全量（含草稿），是**内容工作量**视角；
  //   publishedByLayer 走已发布，是**学习路径可用量**视角。学习路径编排只能读后者
  //   ——按全量排会排出"这一章有 12 节"然后点进去发现 4 节是草稿的空章节。
  //   规模目标（term 80-120 等）应按已发布计，否则数字虚高。
  const publishedByCategory = {};
  for (const e of published) publishedByCategory[e.category] = (publishedByCategory[e.category] || 0) + 1;
  const publishedByLayer = {};
  for (const k of LAYER_KEYS) publishedByLayer[k] = publishedByCategory[k] || 0;

  // 🔴 出处强度分布（#71）："有多少条出处机器可逐字段核验"。
  //   为什么进 stats 而不是只留在 tools 的报告里：它是**内容质量指标**，
  //   和 withSource 同级 —— withSource 只说"有出处"，strength 说"出处能核到什么程度"。
  //   页面据此显示"可核验 N 条"，用户才知道该不该信任本库的引用。
  //   ⚠️ 这不是发布门：现在只观测、不拦截（收紧门禁会一次性把存量打回，需人工补出处）。
  const byStrength = { verifiable: 0, structured: 0, existential: 0, none: 0 };
  for (const e of published) {
    const p = parseSource(e.source);
    const best = p.refs.length
      ? p.refs.reduce((b, r) => (STRENGTH_ORDER.indexOf(citationStrength(r)) > STRENGTH_ORDER.indexOf(b) ? citationStrength(r) : b), 'none')
      : 'none';
    byStrength[best] = (byStrength[best] || 0) + 1;
  }
  return {
    total: all.length,
    published: published.length,
    /** 🔴 草稿数（无出处、未过审）：知识库 2.0 的待办工作量一目了然 */
    draft: all.length - published.length,
    /** 存量字段，语义未变：draft 恒等于 !source ⇒ withSource 与 published 恒等，写成后者是强调「带出处 = 已发布」这一个门禁 */
    withSource: published.length,
    byCategory,
    byLayer,
    publishedByCategory,
    publishedByLayer,
    teachingTotal: published.filter((e) => e.isTeachingLayer).length,
    /** 挂教学模型的条目数（§11.1 教学因子联动的落地进度；只算已发布，否则会挂到看不见的草稿上） */
    withTeachingModel: published.filter((e) => e.teachingModel).length,
    /** 出处强度分布（已发布口径）：verifiable = 有 DOI 可逐字段机器比对 */
    byCitationStrength: byStrength,
  };
}

/**
 * 分类元数据（供前端渲染过滤器）
 * 🔴 count = **已发布**数（2026-10-07 改）。原先走全量，于是草稿一出现，
 *   过滤器上的数字就和"点进去能看到几条"对不上（草稿不进 search）——
 *   数字能点、点出来是空的，这比数字偏大更伤信任。
 *   现在 count 与 search 严格一致；全量在 total 上，需要展示待办量时用 draft。
 */
function categories() {
  const all = load();
  const published = all.filter((e) => !e.draft);
  // 只列**有已发布条目**的分类：全草稿的分类渲染出来是个点不动的死 chip
  const present = new Set(published.map((e) => e.category));
  return Object.keys(CATEGORIES)
    .filter((k) => present.has(k))
    .map((k) => ({
      key: k,
      label: CATEGORIES[k],
      count: published.filter((e) => e.category === k).length,
      total: all.filter((e) => e.category === k).length,
      draft: all.filter((e) => e.category === k && e.draft).length,
    }));
}

/**
 * 取某一教学层的全部**已发布**条目（Learn 学习路径编排用）。
 * 🔴 非教学层（basis/paper）传入一律返回空数组 —— 它们不属于课程内容。
 * @param {string} layer 五层之一
 * @param {{limit?:number}} [opts]
 */
function listByLayer(layer, opts = {}) {
  if (!isTeachingLayer(layer)) return [];
  const lim = Math.max(1, Math.min(Number(opts.limit) || 200, 500));
  return load()
    .filter((e) => e.category === layer && !e.draft)
    .slice(0, lim);
}

module.exports = {
  search,
  byIds,
  stats,
  categories,
  listByLayer,
  isTeachingLayer,
  LAYERS,
  AUX,
  LAYER_KEYS,
  CATEGORIES,
  extractKeywords,
  DIR,
};
