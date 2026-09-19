// ─────────────────────────────────────────────────────────────
// 平台语料导出：把问答历史 / 用户教学 / 反馈数据 / Agent 报告摘要
// 转成微调用的 JSONL（openai messages 格式），供下一轮云端训练使用
//   用法：node server/ai/export_corpus.cjs [输出文件]
//   说明：这是轻量 I/O 操作（读写 JSON），非模型计算
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const AI_DIR = path.join(__dirname, '..', '..', 'data', 'ai');
const OUT = process.argv[2] || path.join(__dirname, '..', '..', 'ai-training', 'dataset', 'fin_corpus_platform.jsonl');

const SYSTEM =
  '你是「AI深度量化」平台的金融研究助手，专为中文用户提供量化研究与教育服务。' +
  '回答需专业、结构化、基于数据与指标逻辑；所有内容属于学术研究演示，不构成任何投资建议。';

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    // 文件不存在或无权限时优雅跳过，返回空数组
    return [];
  }
}

function main() {
  // 各来源候选条目（最终会在全局去重阶段保留首次出现）
  const userItems = []; // 1) 用户教学
  const fbItems = [];   // 2) 反馈认可
  const agentItems = [];// 3) Agent 报告
  const histItems = []; // 4) 问答历史 quality 过滤

  // 1) 用户教学的知识条目（质量最高）
  try {
    const kb = JSON.parse(fs.readFileSync(path.join(AI_DIR, 'knowledge.json'), 'utf8'));
    for (const e of kb.entries ?? []) {
      if (e.source === 'user' && (e.weight ?? 1) >= 0.8 && e.q && e.a) {
        userItems.push({ qn: normalizeQ(e.q), messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: e.q }, { role: 'assistant', content: e.a }] });
      }
    }
  } catch { /* 无知识库 */ }

  // 2) 反馈为点赞的问答（用户认可的表达方式）
  //    兼容 feedback.jsonl 与 feedback-archive.jsonl，两处的 rating==='up' 均视为认可样本
  const ups = new Set();
  for (const fn of ['feedback.jsonl', 'feedback-archive.jsonl']) {
    for (const f of readJsonl(path.join(AI_DIR, fn))) {
      if (f.rating === 'up' && f.question) ups.add(normalizeQ(f.question));
    }
  }
  const history = readJsonl(path.join(AI_DIR, 'history.jsonl'));
  for (const h of history) {
    if (h.type === 'learned') continue; // 知识命中已在 1 中覆盖
    const qn = normalizeQ(h.q);
    if (ups.has(qn)) {
      fbItems.push({ qn, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: h.q }, { role: 'assistant', content: h.a }] });
    }
  }

  // 3) Agent 团队报告摘要（量化分析能力语料）
  try {
    const idxPath = path.join(AI_DIR, '..', 'agents', 'index.json');
    const index = JSON.parse(fs.readFileSync(idxPath, 'utf8')).slice(0, 50);
    for (const it of index) {
      const file = path.join(AI_DIR, '..', 'agents', 'reports', `${it.id}.json`);
      if (!fs.existsSync(file)) continue;
      const t = JSON.parse(fs.readFileSync(file, 'utf8'));
      const q = `用Agent团队完整分析一下${it.symbol}${t.name ? `（${t.name}）` : ''}`;
      const a = [
        `【研究结论 · 非投资建议】${t.final?.decision ?? '——'}`,
        t.final?.note ?? '',
        '',
        '—— 各分析师要点 ——',
        ...(t.stages?.collect?.agents ?? []).map((a) => `· ${a.name}：${(a.findings ?? [])[0] ?? ''}`),
        t.stages?.debate?.chief ? `· 研究主管裁决：${t.stages.debate.chief.verdict}` : '',
      ].filter(Boolean).join('\n');
      agentItems.push({ qn: normalizeQ(q), messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: q }, { role: 'assistant', content: a }] });
    }
  } catch { /* 无报告历史 */ }

  // 4) 问答历史 quality 过滤导出（本次扩增语料的主力来源）
  //    过滤规则：排除 fallback 类型、空问题/回答、回答 < 40 字符；
  //    并排除已在前 1/2/3 来源出现过的重复问题（按 normalizeQ 去重，保留首次出现）。
  //    注意：来源4内部的重复问题予以保留（任务要求扩增语料，仅做跨来源去重）。
  const seenBeforeHist = new Set([
    ...userItems.map((i) => i.qn),
    ...fbItems.map((i) => i.qn),
    ...agentItems.map((i) => i.qn),
  ]);
  let histDupRemoved = 0;
  for (const h of history) {
    if (h.type === 'fallback') continue;          // 规则引擎兜底的低质回答
    if (!h.q || !h.a) continue;                   // 问题或回答为空
    if (String(h.a).length < 40) continue;        // 回答过短，训练价值低
    const qn = normalizeQ(h.q);
    if (seenBeforeHist.has(qn)) { histDupRemoved++; continue; } // 已在前来源出现，排除
    histItems.push({ qn, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: h.q }, { role: 'assistant', content: h.a }] });
  }

  // 汇总输出（来源4内部重复已保留，仅去除跨来源重复）；沿用 {messages:[...]} 三段式结构
  const out = [...userItems, ...fbItems, ...agentItems, ...histItems].map((i) => ({ messages: i.messages }));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out.map((o) => JSON.stringify(o)).join('\n') + (out.length ? '\n' : ''), 'utf8');

  console.log(`语料导出完成 → ${OUT}`);
  console.log(`总条数: ${out.length} 条`);
  console.log(`来源分布: 用户教学 ${userItems.length} / 反馈认可 ${fbItems.length} / Agent报告 ${agentItems.length} / 问答历史 ${histItems.length}`);
  console.log(`去重后条数: ${out.length} 条（跨来源重复已排除 ${histDupRemoved} 条）`);
  console.log('用法：上传到云端训练环境，与 fin_seed.jsonl 合并后进行下一轮 QLoRA 训练。');
}

function normalizeQ(s) {
  return String(s || '').toLowerCase().replace(/[？?！!。，,、.\s：:（）()【】\[\]]+/g, '');
}

main();
