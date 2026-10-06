'use strict';
// ─────────────────────────────────────────────────────────────
// 研究包（research bundle）—— 一份**自包含、可复现**的证据快照
//
//   为什么要它：验证结论与回测指标此前只活在浏览器里（刷新即无、贴不到论文/笔记里）。
//   科研用途要的不是"截图"，而是"你可以拿着它复现，并且知道它没覆盖什么"。
//
//   🔴 三条纪律：
//     ① **纯函数**：只吃已经算好的结果（不读文件、不发请求）⇒ 前后端同源、可单测。
//     ② **缺什么就显式说**：没跑回测/没跑验证/没有实验记录时，输出 `missing[]`
//        与一句原因，而不是留空让人误以为"这项通过"。
//     ③ **局限随包走**：已知局限与"不覆盖"清单必须进包，不能只挂在界面上。
//
//   ⚠️ 身份锚点是 `modelHash`（模型**定义**身份）与 `fingerprint`（**一次实验**身份）：
//      两者都由服务端算，包里原样带上 —— 复现时凭它们核对"是同一个模型/同一次实验"。
// ─────────────────────────────────────────────────────────────

const BUNDLE_VERSION = 1;
const KIND = 'ai-deep-quant/research-bundle';

/** Markdown 单元格：竖线会撕开表格、换行会撑破行 —— 两者都必须处理 */
const mdCell = (v) => {
  const s = String(v === undefined || v === null || v === '' ? '—' : v)
    .replace(/\|/g, '\\|')
    .replace(/\s*\r?\n+\s*/g, ' ')
    .trim();
  return s || '—';
};
const fmtNum = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
const fmtPct = (v, d = 2) =>
  typeof v === 'number' && Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}%` : '—';
const fmtPctAbs = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(d)}%` : '—');

/** 从回测结果里挑出"研究要引用"的指标（不搬净值序列：那是数据不是结论） */
function baselineMetrics(result) {
  if (!result) return null;
  return {
    range: result.range || null,
    universeSize: result.universeSize ?? null,
    benchmarkUniverse: result.benchmarkUniverse ?? null,
    topN: result.topN ?? null,
    rebalanceEvery: result.rebalanceEvery ?? null,
    capital: result.capital ?? null,
    slippage: result.slippage ?? null,
    rebalances: result.rebalances ?? null,
    fills: result.fills ?? null,
    totalReturn: result.totalReturn ?? null,
    annualized: result.annualized ?? null,
    maxDrawdownPct: result.maxDrawdownPct ?? null,
    sharpe: result.sharpe ?? null,
    benchmarkReturn: result.benchmarkReturn ?? null,
    excessReturn:
      typeof result.totalReturn === 'number' && typeof result.benchmarkReturn === 'number'
        ? +(result.totalReturn - result.benchmarkReturn).toFixed(2)
        : null,
    totalFees: result.totalFees ?? null,
    feeRatePct: result.feeRatePct ?? null,
    blockedLimitUp: result.blockedLimitUp ?? null,
    blockedLimitDown: result.blockedLimitDown ?? null,
    icMean: result.ic?.icMean ?? null,
    icir: result.ic?.icir ?? null,
    icPositiveRate: result.ic?.icPositiveRate ?? null,
    icN: result.ic?.n ?? null,
    icP: result.ic?.p ?? null,
    priceBasis: result.priceBasis ?? null,
  };
}

/**
 * 组装研究包。
 *
 * @param {object} input
 * @param {object} input.model          提交用的 Model JSON（原始形态，可原样导回）
 * @param {string|null} [input.modelHash] 服务端算的模型定义哈希
 * @param {object} [input.runOpts]      回测参数 { topN, capital, slippage, startDate, endDate }
 * @param {object|null} [input.run]     成功回测响应 { engineVersion, plan, fingerprint, result }
 * @param {object|null} [input.validation] 验证报告（runValidation 的返回）
 * @param {Array} [input.experiments]   选中的实验记录
 * @param {string[]} [input.limitations] 已知局限（可来自 /api/models/schema 的 validation.limitations）
 * @param {string} [input.exportedAt]   导出时间（不传则取当前时间；便于测试固定）
 * @param {string} [input.origin]       导出环境（如 'local' / 'vercel'），用于解释"为什么没跑"
 */
function buildResearchBundle(input = {}) {
  const {
    model,
    modelHash = null,
    runOpts = {},
    run = null,
    validation = null,
    experiments = [],
    limitations = [],
    exportedAt = new Date().toISOString(),
    origin = null,
  } = input || {};

  const missing = [];
  const runOk = !!(run && run.ok);
  const hasValidation = !!(validation && validation.ok);
  /**
   * 数据**内容**版本（study/复现用）。
   * 来源：验证报告（server/validation.cjs 的 resolveDataVersion）优先，回测响应次之。
   * 🔴 它补的是 fingerprint 的一个真洞：fingerprint 只含数据**窗口**，归档修正后窗口可能不变。
   */
  const dataVersion = (validation && validation.dataVersion) || (run && run.dataVersion) || null;
  const dataVersionDigest = dataVersion && dataVersion.digest ? dataVersion.digest : null;

  if (!model) missing.push('模型定义（未提供）');
  if (!runOk) missing.push('基准回测结果（本次未执行或未成功——公网不提供执行）');
  if (!hasValidation) {
    missing.push(
      '验证结论（本次未运行验证；或运行未成功）' +
        (validation && !validation.ok && validation.error
          ? `：${String(validation.error.message || validation.error).slice(0, 80)}`
          : ''),
    );
  }
  // 有验证结果却没有数据版本 ⇒ 明确说明（否则读者会以为"结论与数据版本无关"）
  if (hasValidation && !dataVersionDigest) {
    missing.push(
      '数据版本摘要（归档内容指纹）' +
        (dataVersion && dataVersion.note ? `：${String(dataVersion.note).slice(0, 100)}` : '（未取得）'),
    );
  }
  if (!experiments.length) missing.push('历史实验记录（未勾选或模型库中尚无留痕）');

  const bundle = {
    kind: KIND,
    bundleVersion: BUNDLE_VERSION,
    exportedAt,
    ...(origin ? { origin } : {}),
    engineVersion: run?.engineVersion || validation?.engineVersion || null,
    identity: {
      modelHash,
      fingerprint: runOk ? run.fingerprint : null,
      validationFingerprint: hasValidation ? validation.fingerprint : null,
      /** 数据内容版本（见上方注释；null 表示未取得，原因写在 missing[] 里） */
      dataVersion: dataVersionDigest,
      name: model?.name || '(未命名)',
      factorCount: Array.isArray(model?.factors) ? model.factors.length : 0,
    },
    /** 原始 Model JSON：导入端应能原样读回（故不在这里塞回测参数） */
    model: model || null,
    /** 回测参数**不属于** Model JSON（规范只允许 meta.author/tags）⇒ 单独一层 */
    runOptions: {
      topN: runOpts.topN ?? null,
      capital: runOpts.capital ?? null,
      slippage: runOpts.slippage ?? null,
      startDate: runOpts.startDate ?? null,
      endDate: runOpts.endDate ?? null,
    },
    baseline: runOk
      ? { present: true, plan: run.plan || null, metrics: baselineMetrics(run.result) }
      : { present: false, plan: null, metrics: null },
    validation: hasValidation
      ? {
          present: true,
          generatedAt: validation.generatedAt,
          verdict: validation.verdict,
          sample: validation.sample,
          power: validation.power,
          cost: validation.cost,
          rules: validation.rules,
          checks: validation.checks,
          limitations: validation.limitations,
        }
      : { present: false },
    experiments: {
      present: experiments.length > 0,
      count: experiments.length,
      items: experiments,
    },
    /**
     * 「怎么复现」与「别误读」——这两节是研究包区别于截图的地方，故随包固化。
     * ⚠️ 措辞类内容**只在这里写一份**：报告各节按需引用，避免同一句话在多处各写一遍后分叉。
     */
    provenance: {
      reproduce:
        '导入 model 字段的 JSON → 用 runOptions 的参数在**本地版本**执行 → ' +
        '结果的 fingerprint 应与 identity.fingerprint 一致（同引擎版本 + 同数据窗口 ⇒ 同指纹）。',
      identityNote:
        'modelHash 只由语义核心（因子/预处理/过滤/组合/股票池/回测设置）决定，改名称不影响；' +
        'fingerprint 还含数据窗口与运行参数，标识"一次实验"。',
      /** 完整复现三件套的第三件 —— 很多人会漏掉它，所以单独解释一句 */
      dataVersionNote:
        'dataVersion 是归档**内容**摘要（逐行字段哈希）；fingerprint 只含数据**窗口**（start/end）。' +
        '归档每日同步、可追加可修正 ⇒ 窗口与池子规模不变而底下数据已换的情形真实存在，只有 dataVersion 能区分。' +
        '故完整复现凭据为：**engineVersion + fingerprint + dataVersion** 三者同时一致。',
      bundleScope: '本包不含净值序列（那是数据，不是结论）；需要曲线请用回测接口另行导出。',
      /** 最容易误读的一句：pass 只是"没报警"，不是"有效" */
      verdictCaveat:
        'verdict.pass=true 仅表示"未触发本套件覆盖的不稳定信号"，不等于模型有效，也不构成对未来收益的保证。',
      /** 验证套件**不覆盖**的面（是覆盖边界，不是模型缺点） */
      notCovered: [
        '日内信息泄露（需 tick 与时间戳数据；日线归档物理上检不出）——该风险改由引擎源码契约锁定：排名取 T-1 收盘、执行取 T 日开盘',
        '因子有效性的统计显著性（仅给出功效是否充足）',
        '真实冲击成本',
      ],
      limitations,
    },
    /** 缺什么、为什么缺 —— 显式列出，避免"没写=没这项=没问题"的误读 */
    missing,
  };

  return bundle;
}

/**
 * 渲染人可读报告（Markdown）—— 给论文/笔记用的那一份。
 * ⚠️ 所有进入表格的动态字符串都要过 mdCell（竖线与换行是表格杀手）。
 */
function renderResearchReport(bundle) {
  const b = bundle || {};
  const id = b.identity || {};
  const L = [];
  // 章节编号**动态**生成：缺项时若用字面量会出现"六、… 八、…"的跳号，
  // 读者会以为中间漏印了一章。
  const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  let sec = 0;
  const H = (t) => {
    const head = `## ${CN[sec] || String(sec + 1)}、${t}`;
    sec += 1;
    return head;
  };

  L.push(`# 模型研究报告 · ${mdCell(id.name)}`);
  L.push('');
  L.push(`- 导出时间：${mdCell(b.exportedAt)}`);
  L.push(`- 引擎版本：${mdCell(b.engineVersion)}`);
  L.push(`- 模型定义哈希（modelHash）：\`${mdCell(id.modelHash)}\``);
  L.push(`- 实验指纹（fingerprint）：\`${mdCell(id.fingerprint)}\``);
  L.push(
    `- 数据版本（dataVersion）：\`${mdCell(id.dataVersion || '（未取得）')}\`` +
      (id.dataVersion ? '' : ` —— ${mdCell('归档内容指纹未随本包导出，复现时无法逐字节核对数据底稿')}`),
  );
  L.push(`- 研究包格式：${mdCell(b.kind)} v${mdCell(b.bundleVersion)}`);
  if (b.origin) L.push(`- 导出环境：${mdCell(b.origin)}`);
  L.push('');

  L.push(H('模型定义'));
  L.push('');
  L.push('```json');
  L.push(JSON.stringify(b.model, null, 2));
  L.push('```');
  L.push('');

  const ro = b.runOptions || {};
  L.push(H('回测口径'));
  L.push('');
  L.push('| 参数 | 取值 |');
  L.push('| --- | --- |');
  L.push(`| 持仓数 topN | ${mdCell(ro.topN)} |`);
  L.push(`| 初始资金 | ${mdCell(ro.capital)} |`);
  L.push(`| 滑点 | ${mdCell(ro.slippage)} |`);
  L.push(`| 起止日期 | ${mdCell([ro.startDate, ro.endDate].filter(Boolean).join(' ~ ') || '（按归档全区间）')} |`);
  L.push('');

  const bm = b.baseline || {};
  L.push(H('基准回测结果'));
  L.push('');
  if (bm.present && bm.metrics) {
    const m = bm.metrics;
    L.push(`| 指标 | 数值 | 指标 | 数值 |`);
    L.push('| --- | --- | --- | --- |');
    L.push(`| 区间 | ${mdCell(m.range ? `${m.range.start} ~ ${m.range.end}` : null)} | 交易日数 | ${mdCell(m.range?.bars)} |`);
    L.push(`| 总收益 | ${mdCell(fmtPct(m.totalReturn))} | 年化 | ${mdCell(fmtPct(m.annualized))} |`);
    L.push(`| 最大回撤 | ${mdCell(fmtPctAbs(m.maxDrawdownPct))} | Sharpe | ${mdCell(fmtNum(m.sharpe))} |`);
    L.push(`| 等权基准 | ${mdCell(fmtPct(m.benchmarkReturn))} | 超额 | ${mdCell(fmtPct(m.excessReturn))} |`);
    L.push(`| 调仓次数 | ${mdCell(m.rebalances)} | 成交笔数 | ${mdCell(m.fills)} |`);
    L.push(`| 总费用 | ${mdCell(m.totalFees)} | 费用率 | ${mdCell(fmtPctAbs(m.feeRatePct))} |`);
    L.push(`| IC 均值 | ${mdCell(fmtNum(m.icMean, 4))} | ICIR | ${mdCell(fmtNum(m.icir))} |`);
    L.push(`| IC 期数 | ${mdCell(m.icN)} | IC>0 占比 | ${mdCell(fmtPctAbs(m.icPositiveRate == null ? null : m.icPositiveRate * 100))} |`);
    L.push(`| 涨停未买入 | ${mdCell(m.blockedLimitUp)} | 跌停未卖出 | ${mdCell(m.blockedLimitDown)} |`);
    L.push('');
    L.push(`> 股票池 ${mdCell(m.universeSize)} 只（基准 ${mdCell(m.benchmarkUniverse)} 只）；调仓间隔 ${mdCell(m.rebalanceEvery)} 根 K 线。`);
  } else {
    L.push('（本次未执行回测，故无基准结果。）');
  }
  L.push('');

  const v = b.validation || {};
  L.push(H('验证结论'));
  L.push('');
  if (v.present) {
    const verdict = v.verdict || {};
    L.push(`**结论：${verdict.pass ? '未触发本套件覆盖的不稳定信号' : `发现 ${(verdict.flags || []).length} 项需解释的信号`}**`);
    L.push('');
    L.push(`> ${mdCell(b.provenance?.verdictCaveat)}`);
    L.push('');
    const power = v.power;
    if (power) {
      L.push(`- 样本量：IC ${mdCell(power.icPeriods)} 期，调仓 ${mdCell(power.rebalances)} 次；${mdCell(power.note)}`);
    }
    if (v.cost) L.push(`- 实跑回测次数：${mdCell(v.cost.backtests)}`);
    L.push('');
    if ((verdict.flags || []).length) {
      L.push('### 信号清单');
      L.push('');
      verdict.flags.forEach((f) => L.push(`- ${f}`));
      L.push('');
    }
    const ck = v.checks || {};
    if (ck.walkForward && ck.walkForward.ok) {
      L.push('### 样本外滚动');
      L.push('');
      L.push('| 折 | 区间 | 收益 | 超额 | 回撤 | Sharpe |');
      L.push('| --- | --- | --- | --- | --- | --- |');
      (ck.walkForward.folds || []).forEach((f) => {
        L.push(
          `| ${mdCell(f.fold)} | ${mdCell(`${f.startDate}~${f.endDate}`)} | ${mdCell(fmtPct(f.totalReturn))} | ` +
            `${mdCell(fmtPct(f.excessReturn))} | ${mdCell(fmtPctAbs(f.maxDrawdownPct))} | ${mdCell(fmtNum(f.sharpe))} |`,
        );
      });
      L.push(`| 整段 | 基准 | ${mdCell(fmtPct(ck.walkForward.overall?.totalReturn))} | — | ${mdCell(fmtPctAbs(ck.walkForward.overall?.maxDrawdownPct))} | ${mdCell(fmtNum(ck.walkForward.overall?.sharpe))} |`);
      L.push('');
      L.push(`折间离散度 ${mdCell(ck.walkForward.dispersion?.spread)} 个百分点；判定 ${mdCell(ck.walkForward.verdict)}。`);
      L.push('');
    }
    if (ck.plateau && ck.plateau.ok) {
      L.push('### 参数邻域');
      L.push('');
      L.push(`| ${mdCell(ck.plateau.param)} | 比例 | 收益 | 相对基准 |`);
      L.push('| --- | --- | --- | --- |');
      (ck.plateau.points || []).forEach((p) => {
        L.push(`| ${mdCell(p.value)} | ${mdCell(`${Math.round((p.ratio || 0) * 100)}%`)} | ${mdCell(p.ok ? fmtPct(p.totalReturn) : '失败')} | ${mdCell(p.deltaPct == null ? '—' : fmtPct(p.deltaPct))} |`);
      });
      L.push('');
      const cov = ck.plateau.coverage;
      L.push(
        `判定 ${mdCell(ck.plateau.verdict)}；实际覆盖 ${mdCell(cov ? `${Math.round((cov.actual[0] || 0) * 100)}%~${Math.round((cov.actual[1] || 0) * 100)}%` : '—')}` +
          `（请求 ${mdCell(cov ? `${Math.round((cov.requested[0] || 0) * 100)}%~${Math.round((cov.requested[1] || 0) * 100)}%` : '—')}）。`,
      );
      L.push('');
    }
    if (ck.causality && ck.causality.ok) {
      const cs = ck.causality;
      L.push('### 因果性（前缀一致性）');
      L.push('');
      L.push('| 截断日 | 交易日 | 比对点 | 该段收益 | 池子 | 结论 |');
      L.push('| --- | --- | --- | --- | --- | --- |');
      (cs.cuts || []).forEach((c) => {
        const verdict = !c.mismatch ? '逐点一致' : c.universeShift ? `${c.mismatch.date} 起不一致（池子也变）` : `${c.mismatch.date} 起不一致`;
        L.push(
          `| ${mdCell(c.cut)} | ${mdCell(c.dailyBars)} | ${mdCell(c.compared)} | ${mdCell(fmtPct(c.totalReturn))} | ` +
            `${mdCell(c.universeShift ? `${c.universeSize}（≠${cs.fullUniverseSize}）` : c.universeSize)} | ${mdCell(verdict)} |`,
        );
      });
      L.push('');
      L.push(`判定 ${mdCell(cs.verdict)}。做法：把归档**物理截断**到该日再重跑，其历史净值必须与全区间跑的同一段逐点相同。`);
      if (cs.pool && cs.pool.stableFrom) {
        L.push('');
        L.push(
          `> 核心池按**全期**数据规模选定 ⇒ ${mdCell(cs.pool.stableFrom)} 之前，当时可得池子只是全集池的子集` +
            `（事后选池带来的轻微 as-of 偏差）；故默认截断点取在该日之后。`,
        );
      }
      L.push('');
    }
    L.push('### 本套件不覆盖');
    L.push('');
    (b.provenance?.notCovered || []).forEach((s) => L.push(`- ${s}`));
    L.push('');
  } else {
    L.push('（本次未运行验证，故无验证结论。请在本地版本运行验证后重新导出。）');
    L.push('');
  }

  L.push(H('已知局限'));
  L.push('');
  const lims = (v.limitations && v.limitations.length ? v.limitations : b.provenance?.limitations) || [];
  if (lims.length) lims.forEach((s) => L.push(`- ${s}`));
  else L.push('- （未提供）');
  L.push('');
  // ⚠️ 这里**不再重复**「本套件不覆盖」清单：它只在第四节渲染一次（单一源 = provenance.notCovered）

  L.push(H('如何复现'));
  L.push('');
  L.push(`- ${mdCell(b.provenance?.reproduce)}`);
  L.push(`- ${mdCell(b.provenance?.identityNote)}`);
  if (b.provenance?.dataVersionNote) L.push(`- ${mdCell(b.provenance.dataVersionNote)}`);
  L.push(`- ${mdCell(b.provenance?.bundleScope)}`);
  L.push('');
  if ((b.missing || []).length) {
    L.push(H('本报告未包含'));
    L.push('');
    b.missing.forEach((s) => L.push(`- ${s}`));
    L.push('');
  }

  const exps = b.experiments?.present ? b.experiments.items || [] : [];
  if (exps.length) {
    L.push(H('关联实验记录'));
    L.push('');
    L.push('| 时间 | 指纹 | 总收益 | 回撤 | Sharpe |');
    L.push('| --- | --- | --- | --- | --- |');
    exps.forEach((e) => {
      const m = e.metrics || e; // 兼容"完整记录"（metrics 嵌套）与"列表行"（扁平）
      L.push(
        `| ${mdCell(String(e.ts || '').slice(0, 19).replace('T', ' '))} | ${mdCell(String(e.fingerprint || '').slice(0, 12))} | ` +
          `${mdCell(fmtPct(m.totalReturn))} | ${mdCell(fmtPctAbs(m.maxDrawdownPct))} | ${mdCell(fmtNum(m.sharpe))} |`,
      );
    });
    L.push('');
  }

  return L.join('\n');
}

module.exports = { BUNDLE_VERSION, KIND, buildResearchBundle, renderResearchReport };
