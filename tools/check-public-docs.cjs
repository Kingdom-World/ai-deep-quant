#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// 公开面文档守门（**离线**，CI 步骤用）
//
// 🔴 为什么需要它（2026-10-10 事故链）：
//   仓库是 public。审计 README.md 时逐行核对，发现它对外写了：
//     · 「密码留空即关闭」   → 明确告诉读者可以裸奔
//     · SITE_USERNAME / SITE_PASSWORD / API_RATE_LIMIT → 给出绕过路径
//     · 公网部署地址 + 部署脚本与维护任务注册方式   → 交出部署拓扑
//     · 五因子权重 / 风控阈值 / 佣金数值            → 内部口径的第二份副本
//   这些**每一处单看都像正常文档**，所以逐行人工审会漏；
//   而且 MEMORY.md 早就有纪律「改口径必须全仓搜文字表述」，
//   但 README 里那几行数值恰恰是代码口径的**手工副本**，改代码不会同步。
//
// ⇒ 本门把「公开面不得出现什么」变成**可执行断言**，改动 README 即刻验证。
//
//   设计要点（都是踩过的）：
//   · 判据**只扫公开版**（README.public.md）—— 本地完整版不入库，不受约束；
//   · 扫的是**会被读者看到的文本**，因此注释与代码块内的变量名占位不误报；
//   · 每条规则都给出 `why`，避免后人看不懂而删掉门。
//
//   用法：
//     node tools/check-public-docs.cjs          # 人读报告
//     node tools/check-public-docs.cjs --ci     # CI：有问题 exit 1
// ─────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CI_MODE = process.argv.includes('--ci');

// 🔴 只检查这一份。对外的 README 若换文件名，这里要同步改——
//  这是有意的摩擦：公开面改名应当是个需要想一下的决定。
const TARGETS = ['README.public.md'];

/**
 * 规则表。每一项：
 *   id/why  —— 出处与理由（删门前请先读 why）
 *   re      —— 命中即违规的正则
 *   label   —— 报告里给人看的说明
 */
const RULES = [
  {
    id: 'no-real-domain',
    why: '仓库公开 ⇒ 部署域名等于对所有人公开。红线：真实域名不入库。',
    re: /vercel\.app|\b[a-z0-9-]+\.xyz\b|ai-deep-quant|deepquant/i,
    label: '真实部署域名 / 站点标识',
  },
  {
    id: 'no-env-var-names',
    why: '写出鉴权变量名 = 告诉读者改哪个环境变量就能改管理员名或关掉登录。',
    re: /SITE_USERNAME|SITE_PASSWORD|AUTH_ENABLED|API_RATE_LIMIT|PAPER_[A-Z_]+|BOOTSTRAP_ADMIN/,
    label: '部署环境变量名',
  },
  {
    id: 'no-auth-off-switch',
    why: '「密码留空即关闭」等于公开宣布本站可以无鉴权裸奔（本项目真实发生过忘开鉴权的事故）。',
    // 🔴 判据必须只抓「**告知可以关闭**」的表述，不能抓「**要求必须开启**」的警告 ——
    //   第一版写成/未启用鉴权/，结果把「公开部署时必须启用鉴权」这句警告也报了（噪声门禁= 没门）。
    //   ⇒ 锚定「关闭/留空」这类**动作词**与句子的组合，排除带「必须/应/禁止」等要求词的句子。
    re: /(?<![须应禁])[^。\n]{0,20}(留空|为空|不设)[^。\n]{0,10}(即|就)?关闭/,
    label: '鉴权可关闭的表述',
  },
  {
    id: 'no-private-ip',
    why: '内网 IP 暴露基础设施拓扑。',
    re: /\b(10|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b169\.254\.\d{1,3}\.\d{1,3}\b/,
    label: '内网 / 元数据地址',
  },
  {
    id: 'no-ops-topology',
    why: '部署入口、构建配置、维护任务注册属于运维拓扑，不随公开仓库分发。',
    re: /vercel\.json|api\/index\.js|register-maintenance|start_py\.bat|vercel-build/,
    label: '部署/运维拓扑细节',
  },
  {
    id: 'no-internal-thresholds',
    why: '口径必须单一源。README 再抄一份数值，代码改了文档不会跟着变（=口径分叉）。',
    re: /万\s?2\.5|万\s?5|≤\s?20%|≤\s?30%|趋势\s?30|动量\s?25|量能\s?15|波动\s?15|位置\s?15|PAPER_TRADE_247/,
    label: '内部阈值 / 因子权重 / 费率数值',
  },
  {
    id: 'no-absolute-path',
    why: '绝对部署路径泄露本机目录结构。',
    re: /[A-Za-z]:\\|\/(Users|home)\//,
    label: '绝对部署路径',
  },
];

function scan(text) {
  const hits = [];
  const lines = text.split('\n');
  for (const rule of RULES) {
    lines.forEach((ln, i) => {
      if (rule.re.test(ln)) {
        hits.push({ id: rule.id, label: rule.label, why: rule.why, line: i + 1, text: ln.trim().slice(0, 100) });
      }
    });
  }
  return hits;
}

function main() {
  const problems = [];
  let scanned = 0;

  for (const rel of TARGETS) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      problems.push({ id: 'missing', file: rel, msg: '公开版文档不存在 —— 公开面将只剩本地完整版' });
      continue;
    }
    scanned++;
    for (const h of scan(fs.readFileSync(abs, 'utf8'))) {
      problems.push({ id: h.id, file: rel, line: h.line, text: h.text, msg: h.label, why: h.why });
    }
  }

  if (!CI_MODE) {
    console.log('\n══ 公开面文档守门 ══');
    console.log(`检查 ${scanned}/${TARGETS.length} 个文件 | 规则 ${RULES.length} 条`);
    if (!problems.length) {
      console.log('🔴 问题 0\n\n✅ 通过');
      return 0;
    }
    console.log(`🔴 问题 ${problems.length}\n`);
    for (const p of problems) {
      console.log(`  [${p.id}] ${p.file}${p.line ? ':' + p.line : ''}`);
      console.log(`      ${p.msg}：${p.text || p.msg}`);
      if (p.why) console.log(`      理由：${p.why}`);
    }
    return 1;
  }

  if (problems.length) {
    console.error(`🔴 公开面文档守门失败：${problems.length} 个问题`);
    for (const p of problems) {
      console.error(`  [${p.id}] ${p.file}${p.line ? ':' + p.line : ''} — ${p.msg}：${p.text || ''}`);
    }
    return 1;
  }
  console.log(`✅ 公开面文档守门通过（${scanned} 个文件，${RULES.length} 条规则，0 问题）`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
} else {
  module.exports = { main, scan, RULES, TARGETS };
}