'use strict';
// ─────────────────────────────────────────────────────────────
// 口径单一源清单（Phase 2 · 数据治理 · 固化）
//
//   🔴 为什么要"固化"而不是"写文档"：
//     文档会过期，而且过期了没人知道。项目里真正的风险不是"没有约定"，而是
//     **同一口径在第二处被悄悄重写一份**（例：手续费数字被复制进前端文案、
//     入池门槛被复制进体检代码），此后两处各自漂移，测试还是绿的。
//     本模块把"唯一权威在哪"变成**可执行的门**：
//       · 清单里的文件必须存在
//       · 清单里的导出符号必须真的存在（重构改名后清单立刻失效 → 测试红）
//       · 关键数值的**重新定义**不得出现在白名单之外（防分叉）
//
//   ⚠️ 纪律：guards 只放**高辨识度**的数值/标识符（如 0.00025、MAX_COMPARE = N），
//     不放宽泛模式（如裸 `80`）—— 误报会让门变成噪声，进而被习惯性忽略，
//     那比没有门更糟。
//
//   ⚠️ 本模块只读：不写文件、不落库、不改任何状态。
// ─────────────────────────────────────────────────────────────
const fs = require('node:fs');
const path = require('node:path');

/** 扫描时跳过的目录（与仓库结构耦合，改动需同步 test/single-source.test.cjs） */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'data',
  'reports',
  'coverage',
  '.workbuddy',
  '.vercel',
  'tmp',
  'assets',
]);

/** 参与"重复定义扫描"的扩展名（json 噪声太大，不扫） */
const SCAN_EXT = new Set(['.cjs', '.mjs', '.ts', '.tsx', '.js']);

/**
 * 单一源清单。
 *   source   —— 唯一权威文件（相对仓库根，**不含绝对路径**）
 *   exports  —— 必须在该文件里出现的导出名（防重构后清单过期）
 *   guards   —— 该口径的数值/标识符不得在 allow 之外被**重新定义**
 *   mustExist—— 必须存在的文件（数据类单一源用）
 */
const SINGLE_SOURCES = [
  {
    id: 'fees',
    label: '交易费用口径',
    source: 'server/paper/fees.cjs',
    exports: ['calcFees', 'marketOf', 'SCHEDULES'],
    note: 'CN：佣金万2.5（最低5元）+ 印花税万5仅卖出 + 过户费0.001%双边；HK/US 各有费率表。',
    guards: [
      {
        pattern: '0\\.00025',
        reason: '佣金率（万2.5）只能在 fees.cjs 定义一次',
        allow: ['server/paper/fees.cjs', 'test/'],
      },
    ],
  },
  {
    id: 'universe-min-rows',
    label: '核心池入池门槛',
    source: 'server/crosssect.cjs',
    exports: ['UNIVERSE_MIN_ROWS', 'resolveArchiveDir', 'withAdjustedPrices', 'FACTOR_WINDOWS'],
    note: '标的需至少 UNIVERSE_MIN_ROWS（80）个交易日才入池；该门槛也是"as-of 池子偏差"的来源。',
    guards: [
      {
        pattern: 'UNIVERSE_MIN_ROWS\\s*=\\s*\\d',
        reason: '入池门槛只能定义一次（引用请 import，不要重写数值）',
        allow: ['server/crosssect.cjs', 'test/'],
      },
    ],
  },
  {
    id: 'factor-windows',
    label: '因子窗口定义',
    source: 'server/crosssect.cjs',
    exports: ['FACTOR_WINDOWS', 'REVERSAL_FACTORS', 'resolveFactor'],
    note: 'mom20/60/120 与 rev20/60/120 的窗口长度；预置因子名必须与之同源。',
    guards: [
      {
        pattern: 'FACTOR_WINDOWS\\s*=\\s*\\{',
        reason: '因子窗口表只能有一份（modelspec 的预置因子名有等价锁）',
        allow: ['server/crosssect.cjs', 'test/'],
      },
    ],
  },
  {
    id: 'archive-dir',
    label: '归档目录解析',
    source: 'server/crosssect.cjs',
    exports: ['resolveArchiveDir'],
    note: '归档路径的唯一拼接点（支持 LOCAL_HISTORY_DIR 覆盖）；新增读取归档的模块必须走它。',
    guards: [],
  },
  {
    id: 'adjusted-prices',
    label: '复权口径',
    source: 'server/crosssect.cjs',
    exports: ['withAdjustedPrices'],
    note: '不复权价 + 复权因子的唯一实现；无因子覆盖时退化为不复权并置 adjFallback（该退化必须被统计与披露）。',
    guards: [],
  },
  {
    id: 'calendar',
    label: '交易日历',
    source: 'server/calendar.cjs',
    exports: ['cnDateString', 'isCnHoliday', 'isCnTradingDay', 'nextCnTradingDay'],
    note: 'data/calendar.json（每日同步，覆盖范围内以集合为准）→ shared/cn-holidays.json（兜底）。',
    guards: [],
    mustExist: ['shared/cn-holidays.json'],
  },
  {
    id: 'validation-rules',
    label: '验证阈值与已知局限',
    source: 'server/validation.cjs',
    exports: ['RULES', 'LIMITATIONS'],
    note: '所有判定阈值具名并随报告返回；已知局限由服务端下发，界面不另抄一份。',
    guards: [],
  },
  {
    id: 'compare-limit',
    label: '实验对比上限',
    source: 'shared/experiments.cjs',
    exports: ['MAX_COMPARE', 'nextSelection', 'diffParams'],
    note: '一次最多对比几条实验记录（前后端共用同一常量）。',
    guards: [
      {
        pattern: 'MAX_COMPARE\\s*=\\s*\\d',
        reason: '对比上限只能定义一次',
        allow: ['shared/experiments.cjs', 'test/'],
      },
    ],
  },
  {
    id: 'symbol-normalization',
    label: '标的归一化',
    source: 'server/symbolnorm.cjs',
    exports: ['normalizeSymbol'],
    note: '各市场代码 → 统一形态的唯一实现（行情/归档/模拟盘共用）。',
    guards: [],
  },
  {
    id: 'engine-version',
    label: '回测引擎版本',
    source: 'server/modelrun.cjs',
    exports: ['ENGINE_VERSION', 'runModel', 'modelHash'],
    note: '复现三件套之一；引擎改动会影响历史净值，故必须随结果交付。',
    guards: [
      {
        pattern: 'ENGINE_VERSION\\s*=\\s*[\'"]',
        reason: '引擎版本只能定义一次',
        allow: ['server/modelrun.cjs', 'test/'],
      },
    ],
  },
  {
    id: 'model-spec',
    label: '模型规范版本与限额',
    source: 'shared/modelspec.cjs',
    exports: ['SCHEMA_VERSION', 'LIMITS', 'PRESET_FACTORS', 'REBALANCE_BARS'],
    note: '表单与校验器共用的规范单一源（服务端下发，前端不手抄白名单）。',
    guards: [
      {
        pattern: 'SCHEMA_VERSION\\s*=\\s*\\d',
        reason: '规范版本只能定义一次',
        allow: ['shared/modelspec.cjs', 'test/'],
      },
    ],
  },
  {
    id: 'data-issues',
    label: '数据层面已知问题清单',
    source: 'server/archiveindex.cjs',
    exports: ['DATA_ISSUES', 'INDEX_ALGORITHM', 'buildArchiveIndex'],
    note: '幸存者偏差 / as-of 池子 / 复权退化 / 日线不可检日内泄露 / ST 未识别 —— 随索引与研究包返回，不另抄。',
    guards: [],
  },
  {
    id: 'data-version',
    label: '数据版本指纹算法',
    source: 'server/archiveindex.cjs',
    exports: ['INDEX_ALGORITHM', 'peekArchiveVersion', 'invalidateArchiveIndex'],
    note: '归档内容摘要（逐行字段哈希）；与 fingerprint 的分工见 identityNote。',
    guards: [],
  },
];

/** 递归枚举仓库里的可扫描文件（返回**相对路径**，避免泄露绝对路径） */
function listRepoFiles(root, opts = {}) {
  const out = [];
  const skip = opts.skipDirs || SKIP_DIRS;
  const exts = opts.exts || SCAN_EXT;
  const walk = (abs, rel) => {
    let items;
    try {
      items = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (it.isDirectory()) {
        // 跳过已知目录 + 一切点开头目录（.git/.workbuddy/.tmp* 等临时与配置目录）
        if (skip.has(it.name) || it.name.startsWith('.')) continue;
        walk(path.join(abs, it.name), rel ? `${rel}/${it.name}` : it.name);
      } else if (it.isFile()) {
        if (exts.has(path.extname(it.name))) out.push(rel ? `${rel}/${it.name}` : it.name);
      }
    }
  };
  walk(root, '');
  return out;
}

const isAllowed = (relFile, allow = []) => allow.some((a) => relFile === a || relFile.startsWith(a));

/**
 * 校验单条清单项。
 * @param {object} entry
 * @param {string} root 仓库根（**不进入返回值**）
 * @param {string[]} files 相对路径列表
 */
function verifyEntry(entry, root, files) {
  const issues = [];
  const absSource = path.join(root, entry.source);
  if (!fs.existsSync(absSource)) {
    issues.push(`单一源文件不存在：${entry.source}（清单已过期，须更新清单或恢复文件）`);
  }
  // 导出符号存在性（文本级检查足够，且不需要执行该模块）
  let src = '';
  try {
    src = fs.readFileSync(absSource, 'utf8');
  } catch {
    /* 上面的 exists 已报 */
  }
  const exportsOut = (entry.exports || []).map((name) => {
    const found = src.length > 0 && new RegExp(`\\b${name}\\b`).test(src);
    if (!found && src.length > 0) issues.push(`导出符号不存在：${entry.source} 里找不到 ${name}`);
    return { name, found };
  });
  for (const f of entry.mustExist || []) {
    if (!fs.existsSync(path.join(root, f))) issues.push(`必须存在的数据文件缺失：${f}`);
  }
  // 防分叉：数值不得在 allow 之外被**重新定义**
  //   ⚠️ allow = "允许出现的地方"（定义处 + 测试）⇒ 这些要**跳过**，查的是其余文件。
  const guardsOut = (entry.guards || []).map((g) => {
    const re = new RegExp(g.pattern);
    const violations = [];
    for (const f of files) {
      if (isAllowed(f, g.allow)) continue;
      let text;
      try {
        text = fs.readFileSync(path.join(root, f), 'utf8');
      } catch {
        continue;
      }
      // 逐行判断，跳过注释行（注释里提到数字是允许的）
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (/^\s*(\/\/|\*|\/\*)/.test(ln)) continue;
        if (re.test(ln)) {
          violations.push({ file: f, line: i + 1, text: ln.trim().slice(0, 120) });
        }
      }
    }
    if (violations.length) {
      issues.push(`「${g.reason}」被违反：在 ${violations.map((v) => `${v.file}:${v.line}`).join('、')} 又重新定义了一次`);
    }
    return { pattern: g.pattern, reason: g.reason, allow: g.allow || [], violations };
  });

  return {
    id: entry.id,
    label: entry.label,
    source: entry.source,
    note: entry.note,
    ok: issues.length === 0,
    issues,
    exports: exportsOut,
    guards: guardsOut,
  };
}

/**
 * 全量校验（治理门）。
 * @param {string} root 仓库根
 * @param {object[]} [entries] 清单项（默认全部）
 */
function verifySingleSources(root, entries = SINGLE_SOURCES) {
  const files = listRepoFiles(root);
  const results = entries.map((e) => verifyEntry(e, root, files));
  return {
    ok: results.every((r) => r.ok),
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    scannedFiles: files.length,
    entries: results,
    note:
      '本清单是**可执行的门**，不是文档：条目过期（文件/符号改名）或口径被重新定义一份 ⇒ 校验失败。' +
      'guards 只放高辨识度数值，不放宽泛模式（误报会让门失去意义）。',
  };
}

module.exports = { SINGLE_SOURCES, SKIP_DIRS, SCAN_EXT, listRepoFiles, verifyEntry, verifySingleSources };
