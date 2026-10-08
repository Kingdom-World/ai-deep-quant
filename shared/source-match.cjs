// ─────────────────────────────────────────────────────────────
// 出处核验的共用判定（单一源 · 零 IO 零网络）
//
//   🔴 为什么必须抽出来（2026-10-08 审查发现）：
//     `titleSim` 曾在 `tools/verify-sources.cjs` 与 `tools/backfill-doi.cjs`
//     各写一份、逐字相同。**当前一致不代表将来一致** —— 改一处忘另一处即静默分叉，
//     而这两个工具用的是**相反方向**的同一把尺：
//       · verify-sources 用它"事后抓错 DOI"
//       · backfill-doi  用它"事前决定要不要写 DOI"
//     尺子一旦不一致，就会出现"backfill 写进去、verify 又报错"的自相矛盾，
//     排查时极难定位（两个工具各自都"看起来对"）。
//     ⇒ 判定口径统一到本文件，两处 require 它（遵 Serverless 红线：.cjs）。
// ─────────────────────────────────────────────────────────────
'use strict';

/** 归一：小写、非字母数字/中日韩字符一律变空格、压缩空白 */
function normTitle(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').trim();
}

/**
 * 标题相似度（词级 Jaccard）。
 * 标题被期刊名/DOI/说明文字污染时仍能给出有意义的分数。
 * @returns {number} 0..1
 */
function titleSim(a, b) {
  const A = normTitle(a), B = normTitle(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const sa = new Set(A.split(' ')), sb = new Set(B.split(' '));
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 0;
}

/**
 * 标题"实质相同"：完全一致，或一方是另一方的**前缀**（副标题关系）。
 *
 * 🔴 副标题容差是实测逼出来的：学术引用通行写法带副标题，
 *    而 Crossref 常只存主标题 ——
 *    Ang《Asset Management: A Systematic Approach to Factor Investing》
 *    vs 权威「Asset Management」。若不放行，等于逼人把正确引用砍成残缺形式。
 * @returns {boolean}
 */
function titleEquivalent(a, b) {
  const A = normTitle(a), B = normTitle(b);
  if (!A || !B) return false;
  return A === B || A.startsWith(B) || B.startsWith(A);
}

/** 标题相似度门禁阈值（**唯一值**；两工具共用，不许各自定义） */
const SIM_GATE = 0.75;

module.exports = { titleSim, titleEquivalent, normTitle, SIM_GATE };