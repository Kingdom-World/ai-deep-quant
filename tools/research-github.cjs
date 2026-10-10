#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// GitHub 借鉴检索（**本地手动工具**，不进服务端、不进 Agent 工具链）
//
// 🔴 定位与边界（2026-10-10 用户裁定「本地手动查」）：
//   用户约定「执行方案书过程中，只要有不确定的地方就去 GitHub 查」。
//   要让这条约定**真的能执行**，需要一个检索手段；但把它接进 Agent 就等于
//   给 LLM 开了一个出网面（第二个 SSRF 入口），且与本项目铁律
//   「确定性计算全在规则层 / 出网面最小化」冲突。
//   ⇒ 本工具**只由人手动跑**，产物是给人读的调研结论，不是运行时依赖。
//
//   与 `verify-sources.cjs` 同为离线工具，但那个只查 Crossref；这个查代码仓。
//
//   用法：
//     node tools/research-github.cjs <关键词...>
//     node tools/research-github.cjs --repo <owner/name>       # 看指定仓的结构
//     node tools/research-github.cjs --read <owner/name> <路径> # 读仓内某个文件
//     node tools/research-github.cjs --stars 2000             # 按 star 过滤
//
//   ⚠️ 需要出网（api.github.com）。本机经验：`github.com` 会被 SNI 阻断，
//      但 **api.github.com 可达**（2026-10 多次实测），所以本工具走 API 而非网页抓取。
// ─────────────────────────────────────────────────────────────
'use strict';

const https = require('https');

const UA = 'adq-research/1.0';
const API = 'https://api.github.com';

// ── 借鉴时的硬性红线（从项目铁律倒推，不是本工具自创）──
/**
 * 这些是"抄之前先问"的判据。本工具在输出里带上它们，
 * 避免下次只记住"这个项目不错"而忘了它哪里不能抄。
 */
const RED_LINES = [
  {
    id: 'no-llm-math',
    rule: '禁止让 LLM 做算术/确定性计算',
    why: '本项目铁律：规则引擎算一切，LLM 只解读。开源若把计算交给模型，抄进来就是引入幻觉面。',
    check: (r) => r.tech.some((t) => /llm.*calculat|agent.*compute|自主计算/i.test(t)),
  },
  {
    id: 'no-vector-over-rule',
    rule: '不要用向量检索替换现有规则检索链',
    why: '本项目检索是 AND→OR→substring 三级降级，纯规则、离线可判、出处可核验；换向量会加 3 个重依赖且降低出处可核验性。',
    check: (r) => r.tech.some((t) => /faiss|chroma|qdrant|pgvector|milvus|pinecone/i.test(t)) &&
      !r.tech.some((t) => /bm25|hybrid|keyword/i.test(t)),
  },
  {
    id: 'no-llm-as-judge',
    rule: '不要用 LLM-as-Judge 评估推理质量',
    why: '本项目 eval 判定必须是导出纯函数（agent-eval.cjs），且验证门永不读 LLM 输出。让 LLM 评 LLM = 把被验证对象接进验证门。',
    check: (r) => r.tech.some((t) => /deepeval|llm-as-judge|llm.?as.?a.?judge/i.test(t)),
  },
];

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${API}${path}`,
      { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode} ${path}`));
          }
          try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function searchRepos(q, minStars = 0) {
  // GitHub 搜索接口对无认证请求限流较严（10 次/分钟）⇒ 只取前10 条，够用。
  const url = `/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=10`;
  const data = await getJson(url);
  return (data.items || [])
    .filter((r) => (r.stargazers_count || 0) >= minStars)
    .map((r) => ({
      name: r.full_name,
      stars: r.stargazers_count,
      updated: (r.updated_at || '').slice(0, 10),
      lang: r.language || '?',
      tech: [r.language || '', ...(r.topics || []), ...(r.description || '').split(/[,;·\/]/)]
        .map((s) => String(s).trim()).filter(Boolean),
      desc: (r.description || '').slice(0, 160),
      url: r.html_url,
    }));
}

async function repoTree(fullName, branch = 'main') {
  for (const b of [branch, 'master']) {
    try {
      const d = await getJson(`/repos/${fullName}/git/trees/${b}?recursive=1`);
      if (d.tree) {
        return {
          branch: b,
          files: d.tree.filter((f) => f.type === 'blob').map((f) => f.path),
          truncated: !!d.truncated,
        };
      }
    } catch { /* 试下一个分支 */ }
  }
  throw new Error(`无法读取 ${fullName} 的文件树（分支 ${branch}/master 都不行）`);
}

async function readFile(fullName, filePath, branch = 'main') {
  const d = await getJson(`/repos/${fullName}/contents/${filePath}?ref=${branch}`);
  if (!d || d.type !== 'file' || !d.content) throw new Error(`${filePath} 不是可读文件或超出大小限制`);
  return Buffer.from(d.content, d.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
}

function screen(rows) {
  console.log('\n══ 借鉴红线筛查 ══');
  console.log('（命中= 该项目在这条上与本项目铁律冲突，抄之前必须想清楚）\n');
  for (const rl of RED_LINES) {
    const hit = rows.filter(rl.check);
    const mark = hit.length ? '⚠️' : '✅';
    console.log(`${mark} ${rl.rule}`);
    if (hit.length) console.log(`     涉及：${hit.map((h) => h.name).join(', ')}`);
    console.log(`     理由：${rl.why}\n`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    console.log('用法：');
    console.log('  node tools/research-github.cjs <关键词...> [--stars N]');
    console.log('  node tools/research-github.cjs --repo <owner/name>');
    console.log('  node tools/research-github.cjs --read <owner/name> <路径>');
    return 0;
  }

  if (argv[0] === '--repo') {
    const name = argv[1];
    if (!name) { console.error('✗ --repo 需要 <owner/name>'); return 1; }
    const t = await repoTree(name);
    console.log(`\n══ ${name}（分支 ${t.branch}${t.truncated ? '，列表已截断' : ''}）══`);
    console.log(`文件数 ${t.files.length}\n`);
    t.files.forEach((f) => console.log('  ' + f));
    return 0;
  }

  if (argv[0] === '--read') {
    const [, name, path] = argv;
    if (!name || !path) { console.error('✗ --read 需要 <owner/name> <路径>'); return 1; }
    const txt = await readFile(name, path);
    const lim = Number(argv[3] || 0);
    console.log(`\n══ ${name}/${path} ══\n`);
    console.log(lim && txt.length > lim ? txt.slice(0, lim) + '\n\n…（已截断）' : txt);
    return 0;
  }

  const si = argv.indexOf('--stars');
  const minStars = si > 0 ? Number(argv[si + 1] || 0) : 0;
  const q = argv.filter((a, i) => a !== '--stars' && i !== si + 1).join(' ');
  if (!q) { console.error('✗ 缺少关键词'); return 1; }

  console.log(`\n══ 检索：${q}（star ≥ ${minStars}）══`);
  const rows = await searchRepos(q, minStars);
  if (!rows.length) { console.log('无结果'); return 0; }
  rows.forEach((r, i) => {
    console.log(`\n${i + 1}. ${r.name}  ★${r.stars}  ${r.lang}  (${r.updated})`);
    console.log(`   ${r.desc}`);
    console.log(`   ${r.url}`);
  });
  screen(rows);
  console.log('下一步：对候选用 --repo 看结构、用 --read 读关键文件，再判断抄不抄。');
  return 0;
}

if (require.main === module) {
  main().then((c) => { process.exitCode = c; })
    .catch((e) => { console.error('检索失败：', e.message); process.exitCode = 1; });
} else {
  module.exports = { searchRepos, repoTree, readFile, RED_LINES, screen };
}