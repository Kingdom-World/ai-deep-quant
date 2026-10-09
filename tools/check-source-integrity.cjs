#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// 知识库出处自洽门（**离线**，CI 步骤用）
//
// 🔴 为什么需要它（2026-10-09 事故链）：
//   本轮在知识库里发现四类真缺陷 —— 幻觉引用（Campbell 2011查无此文）、
//   DOI 挂错（Lintner 的 DOI 挂在 Sharpe 名下）、两篇论文共用一个 DOI、
//   官方标题与正式标题不符（Baker 论文 A Solution vs Understanding）。
//   根因是**写入路径没有任何自动拦截**：全靠我写完再手动跑联网核验。
//   `verify-sources.cjs` 已能抓这些，但它是**联网工具**——
//   放进 CI 会因 Crossref 限流/抖动让 CI 变红，而内容其实没问题。
//
// ⇒ 本工具只做**离线可判**的自洽检查，可安全进 CI：
//   ① 同一 DOI 不得对应多个不同标题（抓"两篇论文共用一个 DOI"）；
//   ② 同一 DOI 的年份不得冲突（跨条目复用同DOI 时最容易错挂）；
//   ③ DOI 形态必须合法（前缀/后缀、字符集），挡手写笔误；
//   ④ 引用段不得是「纯注释」——无标题、无 DOI/ISBN 且以中文标点起手的段落，
//      通常是把说明文字写进了 source 字段（实测导致幽灵引用 + needs-doi 噪声）；
//   ⑤ 解析器必须能识别每条出处的文献类型（kind 不得为空）。
//
// ⚠️ 本门**不能**替代联网核验：它抓不到"DOI 存在但指向另一篇论文"
//   （那需要真查 Crossref）。因此它的定位是"挡住结构性错误"，
//   联网核验仍在本地跑、由人判断。
//
//   用法：
//     node tools/check-source-integrity.cjs          # 人读的报告
//     node tools/check-source-integrity.cjs --ci     # CI 用：有问题 exit 1
// ─────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KB_DIR = path.join(ROOT, 'server', 'knowledge');
const CI_MODE = process.argv.includes('--ci');

const { parseSource } = require(path.join(ROOT, 'shared', 'knowledge-source.cjs'));

const FILES = ['terms', 'methods', 'principle', 'case', 'cycle', 'basis', 'paper'];

// 🔴 DOI 形态判据（**能力有限，见下方注释，勿高估**）：
//   前缀 10.\d{4,9}，后缀允许字母数字与 `. ( ) ; : - $ [ ]`，允许**最多一个**斜杠。
//   - 括号是常态（如 10.1016/0304-405x(93)90023-5）；斜杠在旧刊里也出现
//     （如 10.1002/(SICI)1099-0522(199909)17:4<...>3.0.CO;2-T）。
//   - 🔴 **抓不到「尾部多余路径段」**（`10.1086/260061/extra` 与
//     `10.1002/x/y` 都合法）—— 因为"旧刊含斜杠"与"手写多打了一段"在字符层面
//     无法区分。曾试图收紧，结果连正常 DOI 都拒（`+` 在字符类里被当量词）。
//     ⇒ 判定这件事只能靠联网核验，别指望这里。
//   - 拒绝得掉的是：前缀错（11.x）、缺后缀（10.1086）、混入 URL 前缀、带空格尾巴。
const DOI_RE = /^10\.\d{4,9}\/[\w.():;\-$[\]]+(?:\/[\w.():;\-$[\]]+)?$/;

/**
 * 判断一个引用段是否更像「说明文字」而非「文献/公告名」。
 * 🔴 刻意保守：宁可漏报也不误报（噪声门禁会被习惯性忽略，比没门更糟）。
 * 命中条件（任一）：
 *   · 以「注：/说明：/补充：/另见：」起手 —— 明确的注释标记；
 *   · 含解释性连接词（已…故/因此/所以/误引/判定为/经…检索）；
 *   · 句中有分号且两侧都不是书名号内容 —— 多句并列的说明。
 */
function looksLikeComment(raw) {
  const s = String(raw || '');
  if (!s) return false;
  if (/^(注|说明|补充|另见|备注)\s*[：:]/.test(s)) return true;
  if (/(已.*?故|因此|所以|误引|判定为|经.*?检索|改用|原出处)/.test(s)) return true;
  // 分号两侧都不像文献（《…》或含年份）⇒ 多半是说明句
  if (s.includes('；') || s.includes(';')) {
    const parts = s.split(/[；;]/).map((x) => x.trim()).filter(Boolean);
    const docLike = parts.filter((p) => /《|19\d{2}|20\d{2}|DOI/i.test(p)).length;
    if (parts.length >= 2 && docLike === 0) return true;
  }
  return false;
}

/** 收集全库出处，返回 { byDoi, problems } */
function collect() {
  const byDoi = new Map();     // doi → { titles:Set, years:Set, refs:[] }
  const problems = [];
  const fileOf = (id) => `${id}`;

  for (const f of FILES) {
    const p = path.join(KB_DIR, f + '.json');
    if (!fs.existsSync(p)) continue;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      problems.push({ kind: 'json', file: f, msg: `JSON 解析失败：${e.message}` });
      continue;
    }

    for (const e of doc.entries || []) {
      const where = `${f} / ${e.id}`;
      const parsed = parseSource(e.source || '');
      if (!parsed || !Array.isArray(parsed.refs) || parsed.refs.length === 0) {
        problems.push({ kind: 'no-refs', where, msg: '出处解析不出任何引用段' });
        continue;
      }

      parsed.refs.forEach((ref, i) => {
        const loc = `${where} #${i}`;

        // ⑤ 类型必须识别
        if (!ref.kind) {
          problems.push({ kind: 'no-kind', where: loc, msg: `文献类型未识别：${(ref.raw || '').slice(0, 50)}` });
        }

        // ④ 纯注释段：既无标题也无 DOI/ISBN/container，且原文**含解释性标点**。
        //   🔴 判据必须窄（本工具第一版曾误报 20 处）：「官方公告」「本项目某文件」
        //   这类引用**合法且必要**，它们没有标题、没有 DOI 是正常的。
        //   真正的幽灵引用是**说明文字**——它会解释"为什么这么改"、
        //   含分号/句号并列多句、或以"注："起手。
        //   ⇒ 只在「无任何标识」+「含解释性标点」同时成立时报警。
        if (!ref.title && !ref.doi && !ref.isbn && !ref.container && looksLikeComment(ref.raw)) {
          problems.push({
            kind: 'comment-as-ref',
            where: loc,
            msg: `疑似把说明文字写进了 source：${(ref.raw || '').slice(0, 60)}`,
          });
        }

        if (!ref.doi) return;

        // ③ 形态
        if (!DOI_RE.test(ref.doi)) {
          problems.push({ kind: 'doi-shape', where: loc, msg: `DOI 形态不合法：${ref.doi}` });
          return;
        }

        const key = ref.doi.toLowerCase();
        if (!byDoi.has(key)) byDoi.set(key, { titles: new Set(), years: new Set(), refs: [] });
        const slot = byDoi.get(key);
        const t = (ref.title || '').trim();
        if (t) slot.titles.add(t);
        if (ref.year) slot.years.add(ref.year);
        slot.refs.push(loc);
      });
    }
  }

  // ① 同 DOI 多标题
  for (const [doi, slot] of byDoi) {
    if (slot.titles.size > 1) {
      problems.push({
        kind: 'doi-multi-title',
        where: slot.refs.join(' | '),
        msg: `同一 DOI 对应 ${slot.titles.size} 个标题：${doi}`,
        detail: [...slot.titles].map((t) => '· ' + t).join('\n    '),
      });
    }
    // ② 同 DOI 年份冲突
    if (slot.years.size > 1) {
      problems.push({
        kind: 'doi-multi-year',
        where: slot.refs.join(' | '),
        msg: `同一 DOI 对应 ${slot.years.size} 个年份：${doi} → ${[...slot.years].join(', ')}`,
      });
    }
  }

  return { byDoi, problems };
}

function main() {
  const { byDoi, problems } = collect();

  if (!CI_MODE) {
    console.log('\n══ 知识库出处自洽检查（离线）══');
    console.log(`文件 ${FILES.length} 个 |唯一 DOI ${byDoi.size} 个`);
    if (!problems.length) {
      console.log('🔴 问题 0\n\n✅ 通过');
      return 0;
    }
    console.log(`🔴 问题 ${problems.length}\n`);
    for (const p of problems) {
      console.log(`  [${p.kind}] ${p.where}`);
      console.log(`      ${p.msg}`);
      if (p.detail) console.log(`    ${p.detail}`);
    }
    return 1;
  }

  if (problems.length) {
    console.error(`🔴 出处自洽检查失败：${problems.length} 个问题`);
    for (const p of problems) {
      console.error(`  [${p.kind}] ${p.where} — ${p.msg}`);
      if (p.detail) console.error(`    ${p.detail}`);
    }
    return 1;
  }
  console.log(`✅ 出处自洽检查通过（${byDoi.size} 个唯一 DOI，0 问题）`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
} else {
  module.exports = { collect, main, DOI_RE, FILES, looksLikeComment };
}