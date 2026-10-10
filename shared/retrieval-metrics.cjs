// ─────────────────────────────────────────────────────────────
// 知识库检索质量指标（**纯规则、零LLM**）
//
// 🔴 为什么需要（2026-10-10 借鉴 ragas 的发现）：
//   `agent-eval` 已有37 条 5 层用例，但只判「答没答对」——
//   **不判「召回的条目对不对」**。检索把A 条排在 B 条前面，我们完全不知道。
//   知识库刚做完出处核验（verified 86/ 0 缺陷），此时最该量化的就是检索质量。
//
// 🔴 借鉴与守正的边界（本文件的来历）：
//   读 `vibrantlabsai/ragas` 的 `src/ragas/metrics/_context_precision.py` 得到两件事：
//   ✅ **公式值得抄**：`_calculate_average_precision` 是纯数学 ——
//      verdicts(0/1) → cumsum → Σ(cumsum/(i+1)) / Σverdicts，即 **MAP@k**。
//      LLM 只负责产出 0/1 判定，不参与算术。
//   ❌ **判定方式绝不抄**：它用 **LLM 逐条判断「这段上下文对答案有用吗」**，
//      正好撞上本项目红线③「验证门永不读 LLM 输出」。
//   ⇒ 本文件取其公式、换其判定：**verdict 由规则给出**（是否命中查询词/标题/正文），
//      因此**零 LLM、零成本、可复现**，且能直接进 CI。
//
//   ⚠️ 与真实相关性的区别（必须说清，否则指标会被误读）：
//   这里的 verdict 是「该条目**是否与查询相关**」的**代理判定**，
//   不是人工标注的 ground truth。⇒ 适合做**回归护栏**（改动是否让检索变差），
//   不适合宣称「检索准确率 92%」。真实相关度需要人工黄金集（见 `golden` 目录约定）。
// ─────────────────────────────────────────────────────────────
'use strict';

/**
 * 单条查询的 relevance 判定（规则版，替代 ragas 的 LLM 判定）。
 *
 * 判据按可靠度排序 —— 命中越靠前，verdict 越应为 1：
 *   1. 标题/书名命中查询词 → 强相关
 *   2. tags 命中 → 中等相关
 *   3. 正文命中（长查询的兜底）→ 弱相关
 *   4. 什么都没命中 → 不相关
 *
 * @param {object} entry 知识库条目（{title, tags, body, summary, ...}）
 * @param {string[]} terms 查询词（小写、去标点后的词项）
 * @returns {boolean} verdict
 */
function verdictFor(entry, terms) {
  if (!entry || !Array.isArray(terms) || terms.length === 0) return false;
  const title = String(entry.title || '').toLowerCase();
  const tags = (entry.tags || []).map((t) => String(t).toLowerCase());
  const body = `${entry.body || ''}\n${entry.summary || ''}`.toLowerCase();

  for (const t of terms) {
    if (!t) continue;
    if (title.includes(t)) return true;         // 标题命中
  }
  for (const t of terms) {
    if (t && tags.some((g) => g.includes(t) || t.includes(g))) return true;   // tags 命中
  }
  for (const t of terms) {
    if (t && body.includes(t)) return true;     // 正文兜底
  }
  return false;
}

/**
 * Average Precision @ k（纯数学，与 ragas 的 _calculate_average_precision 同构）
 * 公式：Σ(precision@i × rel_i) / min(R, k)，其中 precision@i = Σ_{j<=i} rel_j / i
 *
 * @param {boolean[]} relevances 按检索顺序的 0/1 判定
 * @returns {number} AP@k ∈ [0,1]
 */
function averagePrecision(relevances) {
  if (!Array.isArray(relevances) || relevances.length === 0) return 0;
  let cumsum = 0;
  let numerator = 0;
  for (let i = 0; i < relevances.length; i++) {
    if (relevances[i]) {
      cumsum += 1;
      numerator += cumsum / (i + 1);   // precision@i
    }
  }
  const denominator = cumsum + 1e-10;
  return numerator / denominator;
}

/**
 * Precision@k：前 k 条里相关的比例。
 * @param {boolean[]} relevances
 * @param {number} k
 */
function precisionAtK(relevances, k) {
  const head = (relevances || []).slice(0, k);
  if (!head.length) return 0;
  return head.filter(Boolean).length / head.length;
}

/**
 * 把 knowledge.search 的结果转成 verdicts。
 * @param {{items: object[]}} searchResult
 * @param {string[]} terms
 */
function verdictsFrom(searchResult, terms) {
  const items = (searchResult && searchResult.items) || [];
  return items.map((e) => verdictFor(e, terms));
}

/**
 * 一次完整评估：给定查询、期望相关条目 id 集合，返回各项指标。
 *🔴 `expectedIds` 是**人工给定**的相关条目 id（黄金集）；没有它就只算无监督的
 *   hit-rate，不能当"准确率"用。
 *
 * @param {{search:(q:string, o?:object)=>object}} kb 知识库 search 函数
 * @param {{query:string, terms:string[], expectedIds?:string[], k?:number}} spec
 */
function evaluateQuery(kb, spec) {
  const k = spec.k || 5;
  const res = kb.search(spec.query, { limit: k });
  const items = (res && res.items) || [];
  const verdicts = verdictsFrom(res, spec.terms);
  const out = {
    query: spec.query,
    k,
    mode: res && res.mode,
    total: res && res.total,
    returned: items.length,
    precisionAtK: precisionAtK(verdicts, k),
    averagePrecision: averagePrecision(verdicts),
  };
  if (Array.isArray(spec.expectedIds) && spec.expectedIds.length) {
    const hit = new Set(spec.expectedIds);
    const got = items.slice(0, k);
    const hitCount = got.filter((e) => hit.has(e.id)).length;
    out.hitCount = hitCount;
    // recall@k 以「期望集里有多少条出现在前 k」为分母
    out.recallAtK = hitCount / Math.min(hit.size, k);
    out.missingIds = [...hit].filter((id) => !got.some((e) => e.id === id));
  }
  out.verdicts = verdicts;
  out.ids = items.map((e) => e.id);
  return out;
}

/** 多次评估取均值（macro平均，不按查询长度加权） */
function aggregate(rows) {
  if (!Array.isArray(rows) || !rows.length) return { queries: 0 };
  const avg = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  const withRecall = rows.filter((r) => typeof r.recallAtK === 'number');
  return {
    queries: rows.length,
    meanPrecisionAtK: avg((r) => r.precisionAtK),
    meanAveragePrecision: avg((r) => r.averagePrecision),
    ...(withRecall.length
      ? {
          meanRecallAtK: withRecall.reduce((s, r) => s + r.recallAtK, 0) / withRecall.length,
        }
      : {}),
  };
}

module.exports = {
  verdictFor,
  averagePrecision,
  precisionAtK,
  verdictsFrom,
  evaluateQuery,
  aggregate,
};
