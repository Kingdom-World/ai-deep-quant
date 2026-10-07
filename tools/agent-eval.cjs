#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Agent 分层eval 跑分脚本（#73）
//
//   目的：给「Agent 智力」一个**可证伪的基线**。此前每次评估都只能靠读代码猜。
//
//   🔴 三条设计纪律（都来自本项目的既有教训）：
//
//   ① **不发网络请求**（纯离线）。
//      eval 必须可重复、可在 CI 里跑、不能因外部限流而随机红。
//      云端 LLM 那一段用「桩」：只校验**闸门与检索层**的行为
//      （它们才是幻觉的源头；模型侧的评估是另一个问题）。
//
//   ② **能自动判的先自动判**，不追求全自动。
//      语气、有用性这类主观项留人工；这里只判三件**客观**的事：
//      该拒的拒没拒 / 该答的答没答 / 该沉默的有没有硬凑。
//
//   ③ **退出码可挂门**：0=全达标，1=有回归，2=用例数据本身有问题。
//      CI 只需看退出码，不解析输出。
//
//   用法：
//     node tools/agent-eval.cjs            # 人读报告
//     node tools/agent-eval.cjs --json     # 机器读（接CI 断言）
//     node tools/agent-eval.cjs --layer L1 # 只跑某层
// ─────────────────────────────────────────────────────────────
'use strict';

const path = require('node:path');
const { LAYERS, CASES } = require('../test/fixtures/agent-eval-cases.cjs');

// 复用真实实现（口径单一源：不要在这里另写一份判定逻辑）
process.env.KNOWLEDGE_DIR = path.join(__dirname, '..', 'server', 'knowledge');
const intent = require('../shared/agent-intent.cjs');
const kb = require('../server/knowledge.cjs');

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const ONLY = (() => {
  const i = argv.indexOf('--layer');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : '';
})();


/**
 * 单条用例判定（纯函数，零 IO）——**导出供测试直接调用**。
 * 🔴 为什么要导出：本机 WorkBuddy 运行时禁止 node spawn 任何子进程
 *   （`spawnSync bash EBUSY` / errno -4082，`dangerouslyDisableSandbox` 无效），
 *   所以 test/agent-eval.test.cjs **不能**靠"起子进程跑脚本"来验证 eval。
 *   把判定逻辑做成可导入的纯函数，测试才能在同进程里验证它 ——
 *   这也是唯一能在本机跑通的写法。
 * @param {object} c 用例
 * @param {{detect?:Function, detectInjection?:Function, search?:Function}} deps 依赖注入（便于测试替身）
 * @returns {{pass:boolean, actual:string, want:string, detail?:string}}
 */
function judgeCase(c, deps = {}) {
  const detect = deps.detect || intent.detect;
  const detectInjection = deps.detectInjection || intent.detectInjection;
  const search = deps.search || ((q) => kb.search(q, { limit: 5 }));
  const ids = (r) => r.items.map((e) => e.id).join(',');

  // ── L2 对抗性注入：期望 refuse 时走注入闸门（#73）──
  // 🔴 顺序必须与路由一致：**注入先判、越界后判**。
  if (c.expect === 'refuse' && c.layer === 'adversarial') {
    const d = detectInjection(c.q);
    return {
      pass: d.injection === true,
      actual: d.injection ? `blocked(${d.matched})` : 'passed-through',
      want: 'blocked',
      detail: d.injection ? '' : `⚠️ 未拦下；知识库本会返回：${ids(search(c.q)) || '无'}`,
    };
  }

  // ── L1 越界：期望 refuse 时走意图闸门（#71）──
  if (c.expect === 'refuse') {
    const d = detect(c.q);
    return {
      pass: d.outOfScope === true,
      actual: d.outOfScope ? `refused(${d.label})` : 'passed-through',
      want: 'refused',
      detail: d.outOfScope ? '' : `⚠️ 未拦下；知识库本会返回：${ids(search(c.q)) || '无'}`,
    };
  }

  // ── 其余：注入闸门与越界闸门对**每一条**用例都要跑 ──
  // 🔴 为什么不只跑 adversarial/refuse 层（实测踩过两次）：
  //   ① 注入闸门：eval 最初只在 adversarial 层调它，于是"永远返回 true"的闸门
  //      仍报 100% —— **过宽（把「分析 AAPL」当注入拦掉）测不出来**。
  //   ② 越界闸门：eval 最初只在 expect:'refuse' 时调它，于是"永远返回 true"
  //      仍报 100% —— 同理，**闸门过宽 = 产品什么都不答**，在 eval 里完全不可见。
  //   🔴 路由里这两个闸门都是**全局前置**（每个问题都过），eval 就必须如实反映：
  //   任何一条正常请求被任一闸门拦下，都是真实缺陷（因为线上它同样会被拦）。
  const injGate = detectInjection(c.q);
  if (injGate.injection) {
    return {
      pass: false,
      actual: `injection-blocked(${injGate.matched})`,
      want: c.expect === 'abstain' ? 'no-fabrication' : 'total>0',
      detail: '🔴 注入闸门**误拦**了正常请求（正常问题的提问方式与注入话术相似）',
    };
  }

  // 越界闸门同样全局前置：正常请求被它拦下 ⇒ 线上就是"什么都不答"
  const scopeGate = detect(c.q);
  if (scopeGate.outOfScope && c.expect !== 'refuse') {
    return {
      pass: false,
      actual: `scope-blocked(${scopeGate.label})`,
      want: c.expect === 'abstain' ? 'no-fabrication' : 'total>0',
      detail: '🔴 越界闸门**误拦**了非越界请求（线上表现：正常问题一律被拒，产品不可用）',
    };
  }

  const r = search(c.q);

  if (c.expect === 'answer') {
    return {
      pass: r.total > 0,
      actual: `total=${r.total}${r.total ? `(${r.items.slice(0, 2).map((e) => e.id).join(',')})` : ''} mode=${r.mode}`,
      want: 'total>0',
    };
  }

  // expect === 'abstain'：不许硬凑出答案
  // ⚠️ 只在 mode==='substring'（新兜底层）时算失败 —— OR 降级路径的历史噪声
  //   是既有欠账（基线对照确认改动前就存在），不该由本轮改动背锅，
  //   但要**显式报出来**，不能因为"不是我的锅"就装作没看见。
  const byNewLayer = r.mode === 'substring';
  return {
    pass: !byNewLayer,
    actual: `total=${r.total}${r.total ? `(${ids(r)})` : ''} mode=${r.mode}`,
    want: 'no-fabrication',
    detail: r.total > 0 && !byNewLayer ? `⚠️ 既有欠账（OR 降级噪声，mode=${r.mode}）：${ids(r)}` : '',
  };
}

/** 跑一批用例，返回汇总（纯函数，供测试与 CLI 共用） */
function runCases(cases, deps) {
  const results = cases.map((c) => ({ ...c, ...judgeCase(c, deps) }));
  const byLayer = {};
  for (const r of results) {
    const k = r.layer;
    byLayer[k] = byLayer[k] || { total: 0, pass: 0 };
    byLayer[k].total++;
    if (r.pass) byLayer[k].pass++;
  }
  const failed = results.filter((r) => !r.pass);
  const known = results.filter((r) => r.pass && r.detail && r.detail.includes('既有欠账'));
  return {
    results,
    byLayer,
    total: results.length,
    pass: results.length - failed.length,
    fail: failed.length,
    knownDebt: known.length,
    failures: failed.map((r) => ({ q: r.q, want: r.want, actual: r.actual, note: r.note })),
    known: known.map((r) => ({ q: r.q, detail: r.detail })),
  };
}

function main() {
  const cases = ONLY ? CASES.filter((c) => c.layer === ONLY || LAYERS[c.layer] === ONLY) : CASES;
  if (!cases.length) {
    console.error(`❌ 未知层「${ONLY}」。可用层：${Object.keys(LAYERS).join(', ')}`);
    return 2;
  }

  const r = runCases(cases);

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        {
          total: r.total,
          pass: r.pass,
          fail: r.fail,
          knownDebt: r.knownDebt,
          byLayer: r.byLayer,
          failures: r.failures,
        },
        null,
        2,
      ),
    );
    return r.fail ? 1 : 0;
  }

  // ── 人读报告 ──
  console.log('\n═══ Agent 分层 eval（离线；不含云端模型评估）═══\n');
  for (const [k, v] of Object.entries(r.byLayer)) {
    const pct = Math.round((v.pass / v.total) * 100);
    const bar = '█'.repeat(Math.round(pct / 5)).padEnd(20, '·');
    console.log(`${LAYERS[k].padEnd(26)} ${bar} ${v.pass}/${v.total}  ${pct}%`);
  }
  console.log(`\n合计: ${r.pass}/${r.total}（${Math.round((r.pass / r.total) * 100)}%）`);

  if (r.known.length) {
    console.log(`\n⚠️ 已知既有欠账（${r.known.length} 条，未计入失败，但不该被忽略）：`);
    for (const k of r.known) console.log(`   · 「${k.q}」${k.detail}`);
  }

  if (r.fail) {
    console.log(`\n🔴 未达标 ${r.fail} 条：`);
    for (const f of r.results.filter((x) => !x.pass)) {
      console.log(`\n   Q: ${f.q}`);
      console.log(`      期望 ${f.want} / 实际 ${f.actual}`);
      if (f.note) console.log(`      用例意图: ${f.note}`);
      if (f.detail) console.log(`      ${f.detail}`);
    }
    console.log('\n（用例数据在 test/fixtures/agent-eval-cases.cjs，note 字段写了每条的由来）');
  }
  return r.fail ? 1 : 0;
}

// ⚠️ 只有被"直接当脚本跑"时才执行 CLI；被测试 require 时只导出纯函数。
//   否则测试 import 就会跑一遍并process.exit，把测试进程带走。
if (require.main === module) process.exitCode = main();

module.exports = { judgeCase, runCases, LAYERS, CASES };