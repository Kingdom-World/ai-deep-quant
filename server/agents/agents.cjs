// ─────────────────────────────────────────────────────────────
// Agent 团队分析系统（主理人调度制 · 五阶段流水线）
//   ── 铁律：成员之间严禁直连，所有信息必须经主理人中转 ──
//
//   主理人 Arbiter：不做分析，只负责调度 / 中转 / 编报告
//   第一阶段 数据收集（四分析师并行）：技术 Alpha · 基本面 Beta · 新闻 Gamma · 情绪 Delta
//   第二阶段 多空辩论：多头 Bull-1 → 空头 Bear-1 → 研究主管 Sensus 裁决（铁律：不和稀泥，必须 BUY/SELL/HOLD）
//   第三阶段 交易决策：交易员 Vector（入场/目标/止损，风险回报比 < 1:1 直接 pass）
//   第四阶段 风险评估：激进 Ra / 保守 Co / 中性 Ne（分批建仓方案）
//   第五阶段 风险主管 Aegis：综合三方 → 最终决策
//
//   四种模式：full 完整分析 / quick 快速分析（技术+基本面+交易员）/ debate 辩论模式 / risk 风险诊断
//   以及 single：单点调用某类分析师
//
//   合规（脱敏）：全部输出为程序化规则生成的研究演示；免费行情源无财报/新闻/资金流，
//   对应分析师基于价格行为代理指标工作，并在 limitations 中明确标注；结论一律标注"非投资建议"。
// ─────────────────────────────────────────────────────────────
const DISCLAIMER =
  '本页所有内容（含各 Agent 的报告、辩论与结论）均为本地程序化规则引擎生成的学术研究演示，不构成任何投资建议，不代表任何真实机构或分析师观点。数据来自公开行情接口，未接入财报、新闻与资金流数据。';

const sma = (arr, n) => {
  if (arr.length < n) return null;
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
};

function rsiLast(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / n / (losses / n));
}

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let ema = null;
  for (const v of values) {
    ema = ema === null ? v : v * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

function macdLast(closes) {
  if (closes.length < 35) return null;
  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  const dif = closes.map((_, i) => e12[i] - e26[i]);
  const dea = emaSeries(dif, 9);
  const i = closes.length - 1;
  return { dif: dif[i], dea: dea[i], hist: 2 * (dif[i] - dea[i]), prevHist: 2 * (dif[i - 1] - dea[i - 1]) };
}

function atr14(klines) {
  if (klines.length < 2) return null;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const k = klines[i];
    const pc = klines[i - 1].close;
    trs.push(Math.max(k.high - k.low, Math.abs(k.high - pc), Math.abs(k.low - pc)));
  }
  const last = trs.slice(-14);
  return last.reduce((a, b) => a + b, 0) / Math.max(last.length, 1);
}

/** 250 日线性回归斜率（%/根），衡量长期趋势方向与强度 */
function trendSlope(closes, n = 120) {
  const seg = closes.slice(-n);
  if (seg.length < 20) return null;
  const mean = seg.reduce((a, b) => a + b, 0) / seg.length;
  let num = 0;
  let den = 0;
  seg.forEach((v, i) => {
    const x = i - (seg.length - 1) / 2;
    num += x * (v - mean);
    den += x * x;
  });
  return den === 0 ? null : (num / den / mean) * 100;
}

function maxDrawdown(closes, n = 250) {
  const seg = closes.slice(-n);
  let peak = -Infinity;
  let mdd = 0;
  for (const v of seg) {
    peak = Math.max(peak, v);
    mdd = Math.max(mdd, (peak - v) / peak);
  }
  return mdd * 100;
}

// ═══════════ 第一阶段 · 数据收集 ═══════════

function techAnalyst(symbol, klines, quote) {
  const closes = klines.map((k) => k.close);
  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const macd = macdLast(closes);
  const rsi = rsiLast(closes, 14);
  const price = quote?.price ?? closes[closes.length - 1];

  const findings = [];
  let bull = 0;
  let bear = 0;

  if (ma5 != null && ma20 != null && ma60 != null) {
    if (ma5 > ma20 && ma20 > ma60) {
      findings.push(`均线多头排列（MA5 ${ma5.toFixed(2)} > MA20 ${ma20.toFixed(2)} > MA60 ${ma60.toFixed(2)}），中期趋势向上`);
      bull += 2;
    } else if (ma5 < ma20 && ma20 < ma60) {
      findings.push(`均线空头排列（MA5 ${ma5.toFixed(2)} < MA20 ${ma20.toFixed(2)} < MA60 ${ma60.toFixed(2)}），中期趋势向下`);
      bear += 2;
    } else {
      findings.push('均线纠缠，方向未选择，处于震荡结构');
    }
  }
  if (macd) {
    if (macd.hist > 0 && macd.hist >= macd.prevHist) {
      findings.push(`MACD 红柱放大（柱值 ${macd.hist.toFixed(3)}），动能增强`);
      bull += 1;
    } else if (macd.hist < 0 && macd.hist <= macd.prevHist) {
      findings.push(`MACD 绿柱放大（柱值 ${macd.hist.toFixed(3)}），动能走弱`);
      bear += 1;
    } else {
      findings.push(`MACD 柱值收敛（${macd.hist.toFixed(3)}），动能转折观察期`);
    }
  }
  if (rsi != null) {
    if (rsi >= 70) {
      findings.push(`RSI=${rsi.toFixed(1)} 处于超买区，短期回调风险积聚`);
      bear += 1;
    } else if (rsi <= 30) {
      findings.push(`RSI=${rsi.toFixed(1)} 处于超卖区，存在技术性反弹诉求`);
      bull += 1;
    } else {
      findings.push(`RSI=${rsi.toFixed(1)} 中性区间，涨跌动能均衡`);
    }
  }

  // 趋势健康值：近 20 日站上 MA20 的比例 + 低点抬升次数
  const seg = closes.slice(-20);
  const ma20Seg = closes.slice(-24);
  let above = 0;
  for (let i = 0; i < seg.length; i++) {
    const m = sma(ma20Seg.slice(0, 20 + i + 1).slice(-(20)), 20);
    if (m != null && seg[i] > m) above += 1;
  }
  const health = Math.round((above / seg.length) * 60 + Math.min(Math.max(bull - bear, 0), 2) * 20);
  findings.push(`趋势健康值 ${Math.min(health, 100)}/100（近20日站上MA20比例 ${Math.round((above / seg.length) * 100)}%）`);

  const bias = bull > bear ? 'bullish' : bear > bull ? 'bearish' : 'neutral';
  return {
    name: 'Alpha · 技术分析师',
    role: '盯 K 线 / MACD / RSI，评估趋势与健康值',
    findings,
    bias,
    confidence: Math.min(55 + Math.abs(bull - bear) * 15, 90),
    metrics: { ma5, ma20, ma60, rsi, health: Math.min(health, 100), macdHist: macd?.hist ?? null, price },
    limitations: ['仅基于日线行情数据，未覆盖盘中 tick 与更高维度量价结构'],
  };
}

function fundamentalAnalyst(symbol, klines, quote) {
  const closes = klines.map((k) => k.close);
  const price = quote?.price ?? closes[closes.length - 1];
  const slope = trendSlope(closes, 120);
  const mdd = maxDrawdown(closes, 250);
  const high52 = Math.max(...klines.slice(-250).map((k) => k.high));
  const drawdownFromHigh = ((high52 - price) / high52) * 100;

  const findings = [];
  let bias = 'neutral';
  if (slope != null) {
    if (slope > 0.08) {
      findings.push(`120 日趋势斜率 +${slope.toFixed(3)}%/根，长期定价中枢持续上移`);
      bias = 'bullish';
    } else if (slope < -0.08) {
      findings.push(`120 日趋势斜率 ${slope.toFixed(3)}%/根，长期定价中枢下移`);
      bias = 'bearish';
    } else {
      findings.push(`长期趋势斜率 ${slope?.toFixed(3)}%/根，接近零轴，基本面定价变化平淡`);
    }
  }
  findings.push(`现价距 52 周高点回撤 ${drawdownFromHigh.toFixed(1)}%，250 日最大回撤 ${mdd.toFixed(1)}%`);
  if (mdd < 20) findings.push('历史回撤特征温和，价格行为显示经营波动预期较低（代理判断）');
  if (mdd > 45) findings.push('历史回撤剧烈，价格行为隐含较高的基本面不确定性（代理判断）');

  return {
    name: 'Beta · 基本面分析师',
    role: '财报 / ROE / 真实价值评估（数据受限，使用价格行为代理指标）',
    findings,
    bias,
    confidence: 45, // 无真实财报数据，置信度强制封顶
    metrics: { slope, maxDrawdown: mdd, drawdownFromHigh },
    limitations: [
      '未接入财报 / ROE / PE / PB 等基本面数据源，无法计算真实估值',
      '本报告全部为价格行为代理指标，不能替代基本面研究',
    ],
  };
}

function newsAnalyst(symbol, klines, quote) {
  const recent = klines.slice(-10);
  const avgVol20 = sma(klines.slice(-30).map((k) => k.volume), 20) ?? 0;
  const findings = [];
  let bias = 'neutral';
  let events = 0;

  for (const k of recent) {
    const volRatio = avgVol20 > 0 ? k.volume / avgVol20 : 0;
    const chg = ((k.close - k.open) / k.open) * 100;
    if (volRatio > 2 && chg > 5) {
      findings.push(`${k.date} 放量上涨（量比 ${volRatio.toFixed(1)}×，涨幅 ${chg.toFixed(1)}%），疑似存在利好事件驱动`);
      events += 1;
      bias = 'bullish';
    } else if (volRatio > 2 && chg < -5) {
      findings.push(`${k.date} 放量下跌（量比 ${volRatio.toFixed(1)}×，跌幅 ${chg.toFixed(1)}%），疑似存在利空事件驱动`);
      events += 1;
      bias = 'bearish';
    }
  }
  if (events === 0) findings.push('近 10 个交易日未检出放量异动事件，价格走势平稳，无异常事件信号');
  findings.push(`近 10 日事件检出 ${events} 起（基于量价异动的统计学推断，非真实公告）`);

  return {
    name: 'Gamma · 新闻分析师',
    role: '追公告 / 政策 / 行业风向（数据受限，使用量价事件检测代理）',
    findings,
    bias,
    confidence: 40,
    metrics: { events },
    limitations: ['未接入任何新闻 / 公告 / 政策数据源，无法获取真实消息面', '事件检测为量价异动的统计推断，存在误报可能'],
  };
}

function sentimentAnalyst(symbol, klines, quote) {
  const closes = klines.map((k) => k.close);
  const vols = klines.map((k) => k.volume);
  const upVols = [];
  const downVols = [];
  for (let i = Math.max(1, klines.length - 20); i < klines.length; i++) {
    (klines[i].close >= klines[i - 1].close ? upVols : downVols).push(klines[i].volume);
  }
  const avgUp = upVols.length ? upVols.reduce((a, b) => a + b, 0) / upVols.length : 0;
  const avgDown = downVols.length ? downVols.reduce((a, b) => a + b, 0) / downVols.length : 0;
  const pvRatio = avgDown > 0 ? avgUp / avgDown : 1;
  const rsi = rsiLast(closes, 14);
  const price = quote?.price ?? closes[closes.length - 1];
  const high52 = Math.max(...klines.slice(-250).map((k) => k.high));
  const posInRange = ((price - Math.min(...klines.slice(-250).map((k) => k.low))) / (high52 - Math.min(...klines.slice(-250).map((k) => k.low)))) * 100;

  const findings = [];
  let bias = 'neutral';
  if (pvRatio > 1.25) {
    findings.push(`量价配合度 ${pvRatio.toFixed(2)}：上涨日平均成交量显著大于下跌日，资金参与意愿偏多（代理指标）`);
    bias = 'bullish';
  } else if (pvRatio < 0.8) {
    findings.push(`量价配合度 ${pvRatio.toFixed(2)}：下跌日放量更明显，抛压情绪占优（代理指标）`);
    bias = 'bearish';
  } else {
    findings.push(`量价配合度 ${pvRatio.toFixed(2)}，多空情绪均衡`);
  }
  if (rsi != null && rsi > 75) findings.push(`RSI=${rsi.toFixed(1)} 情绪过热，追高意愿拥挤，警惕情绪退潮`);
  if (posInRange > 90) findings.push(`现价处于 52 周区间 ${posInRange.toFixed(0)}% 分位，接近年内高位，市场关注度高位`);
  findings.push('主力资金 / 北向资金数据未接入，以上为量价结构代理的情绪推断');

  return {
    name: 'Delta · 情绪分析师',
    role: '主力资金 / 北向资金 / 市场情绪（数据受限，使用量价结构代理）',
    findings,
    bias,
    confidence: 42,
    metrics: { pvRatio, rsi, posInRange },
    limitations: ['未接入主力资金 / 北向资金 / 融资融券数据源', '情绪判断为量价代理指标，可能与真实资金行为背离'],
  };
}

// ═══════════ 主理人中转摘要（Stage 2 只能看到这个） ═══════════

function buildDigest(reports, quote, klines) {
  const closes = klines.map((k) => k.close);
  let w = 0;
  const votes = { bullish: 0, bearish: 0, neutral: 0 };
  const keyPoints = [];
  for (const r of reports) {
    votes[r.bias] += 1;
    w += (r.bias === 'bullish' ? 1 : r.bias === 'bearish' ? -1 : 0) * (r.confidence / 100);
    keyPoints.push({ from: r.name, points: r.findings.slice(0, 2), limitations: r.limitations });
  }
  return {
    relayedBy: 'Arbiter · 主理人',
    note: '以下为四份报告经主理人提炼后的中转摘要（成员间无直连，空头研究员看不到多头报告原文）',
    weightedBias: +(w / reports.length).toFixed(3),
    votes,
    keyPoints,
    price: quote?.price ?? closes[closes.length - 1],
    limitations: [...new Set(reports.flatMap((r) => r.limitations))],
  };
}

// ═══════════ 第二阶段 · 多空辩论 ═══════════

function bullResearcher(digest) {
  const args = [];
  if (digest.votes.bullish > 0) args.push(`${digest.votes.bullish} 份收集报告倾向多方，加权偏多度 ${digest.weightedBias}，趋势与资金结构存在共振基础`);
  digest.keyPoints.forEach((kp) => {
    const p = kp.points.find((x) => /多头|向上|增强|偏多|反弹|放大|上移|温和|关注度高/.test(x));
    if (p) args.push(p);
  });
  args.push('量价结构若延续，动量策略存在顺周期空间；回撤可控时风险收益占优');
  return { name: 'Bull-1 · 多头研究员', arguments: args.slice(0, 4), stance: '买入逻辑：趋势 × 动能 × 参与度三要素' };
}

function bearResearcher(digest, bull) {
  const args = [];
  if (digest.votes.bearish > 0) args.push(`${digest.votes.bearish} 份收集报告倾向空方，反向信号不可忽视`);
  digest.keyPoints.forEach((kp) => {
    const p = kp.points.find((x) => /超买|超卖|回撤|走弱|下移|退潮|抛压|不确定性/.test(x));
    if (p) args.push(p);
  });
  args.push(`对多头论点的反驳：其论据多为顺周期外推，一旦量价配合度回落，动量逻辑将迅速失效`);
  args.push('四份报告中三份置信度被数据局限强制压低（≤45），证据链并不牢固');
  return { name: 'Bear-1 · 空头研究员', arguments: args.slice(0, 4), stance: '卖出/防守逻辑：证伪多头证据链的薄弱环节' };
}

function researchChief(digest, bull, bear) {
  const w = digest.weightedBias;
  let verdict = 'HOLD';
  let reason;
  if (w >= 0.35) {
    verdict = 'BUY';
    reason = `多方证据加权优势明显（加权偏多度 ${w}），且无足够强的反向证据，裁决为 BUY（研究倾向）`;
  } else if (w <= -0.35) {
    verdict = 'SELL';
    reason = `空方证据加权优势明显（加权偏多度 ${w}），多头论证未能自洽，裁决为 SELL（研究倾向）`;
  } else {
    reason = `多空证据加权后接近均衡（加权偏多度 ${w}），但依据"不和稀泥"铁律，明确裁决为 HOLD（研究倾向），等待更强的方向信号`;
  }
  return { name: 'Sensus · 研究主管', verdict, reason, score: w, rule: '铁律：不和稀泥，必须给出 BUY / SELL / HOLD 之一' };
}

// ═══════════ 第三阶段 · 交易决策 ═══════════

function trader(verdict, price, klines) {
  if (verdict === 'HOLD') {
    return {
      name: 'Vector · 交易员',
      approved: false,
      note: '研究主管裁决为 HOLD，不出具委托参数，进入观望',
      entry: price, target: null, stop: null, rr: null,
    };
  }
  const atr = atr14(klines) ?? price * 0.02;
  const dir = verdict === 'BUY' ? 1 : -1;
  const entry = price;
  const stop = entry - dir * 2 * atr;
  const target = entry + dir * 3 * atr;
  const rr = Math.abs((target - entry) / (entry - stop));
  return {
    name: 'Vector · 交易员',
    approved: rr >= 1,
    note: rr >= 1 ? `风险回报比 1:${rr.toFixed(2)} ≥ 1:1，委托参数通过审核` : `风险回报比 1:${rr.toFixed(2)} < 1:1，该笔直接 pass`,
    entry: +entry.toFixed(2),
    target: +target.toFixed(2),
    stop: +stop.toFixed(2),
    rr: +rr.toFixed(2),
  };
}

// ═══════════ 第四阶段 · 风险评估 ═══════════

function riskTrio(trade, digest, klines) {
  const entry = trade?.entry ?? digest.price;
  const mdd = maxDrawdown(klines.map((k) => k.close), 250);
  const worstPct = trade?.stop != null ? Math.abs((trade.entry - trade.stop) / trade.entry) * 100 : 5;
  const atr = atr14(klines) ?? entry * 0.02;
  return {
    aggressive: {
      name: 'Ra · 激进风险分析师',
      stance: '不能保守，错过机会同样是风险',
      opinion: trade?.approved
        ? `信号已通过 1:${trade.rr} 风险回报审核，建议按上限仓位执行，错过本轮机会的机会成本更高`
        : '当前无信号即是最大的风险——建议保持关注清单待命，信号触发立即跟进',
    },
    conservative: {
      name: 'Co · 保守风险分析师',
      stance: '最坏的情况是什么？要保守一点',
      opinion: `单笔最坏情形为止损触发亏损 ${worstPct.toFixed(1)}%；250 日最大回撤 ${mdd.toFixed(1)}%；叠加隔夜跳空与流动性风险，实际亏损可能超出止损位，建议压缩仓位并预设总账户回撤熔断`,
    },
    neutral: {
      name: 'Ne · 中性风险分析师',
      stance: '有没有更稳妥的分批建仓方案？',
      plan:
        trade?.approved && digest.weightedBias > 0
          ? `建议三分批建仓：首批 40% 于 ${entry.toFixed(2)}，二批 30% 于 ${(entry - 0.8 * atr).toFixed(2)}，三批 30% 于 ${(entry - 1.6 * atr).toFixed(2)}；跌破 ${(entry - 2 * atr).toFixed(2)} 全部止损`
          : '当前不满足分批建仓前提，建议仅跟踪观察，等待更优的赔率结构',
    },
  };
}

function riskChief(trade, trio, verdict, digest) {
  let decision = verdict;
  let sizing = '——';
  const worst = /止损触发亏损 ([0-9.]+)%/.exec(trio.conservative.opinion);
  const worstPct = worst ? parseFloat(worst[1]) : 5;
  if (!trade?.approved) {
    decision = '观望';
    sizing = '0（无信号不出手）';
  } else if (verdict === 'SELL') {
    decision = 'SELL';
    sizing = '建议逢反弹分批减仓离场（研究演示的仓位语义）';
  } else if (worstPct > 8) {
    decision = '降级·分批试探';
    sizing = '按中性方案分批，首批 ≤10%';
  } else {
    sizing = '按中性分批方案执行（首批 40%）';
  }
  return {
    name: 'Aegis · 风险主管',
    decision,
    sizing,
    notes: `综合激进（机会成本）、保守（最坏情形 ${worstPct.toFixed(1)}%）、中性（分批节奏）三方意见；加权偏多度 ${digest.weightedBias}；最终决策 ${decision}（研究结论 · 非投资建议）`,
  };
}

// ═══════════ 主理人编排器 ═══════════

function run({ symbol, klines, quote, mode = 'full', agent, entryPrice }) {
  const price = quote?.price ?? klines[klines.length - 1]?.close ?? null;
  const stages = {};
  let final = null;

  const ALL_ANALYSTS = [
    techAnalyst(symbol, klines, quote),
    fundamentalAnalyst(symbol, klines, quote),
    newsAnalyst(symbol, klines, quote),
    sentimentAnalyst(symbol, klines, quote),
  ];

  if (mode === 'single') {
    const map = { tech: '技术', fundamental: '基本面', news: '新闻', sentiment: '情绪' };
    const key = map[agent];
    const one = ALL_ANALYSTS.find((a) => a.name.includes(key)) ?? ALL_ANALYSTS[0];
    stages.collect = {
      title: '单点调用 · ' + key + '分析师',
      rule: '单点模式：只调度该类分析师，报告直接回传主理人',
      agents: [one],
    };
    final = {
      decision: '——',
      note: `单点调研完成。${one.name} 的报告已归档至主理人，可供后续完整分析调用`,
      disclaimer: DISCLAIMER,
    };
    return { symbol, mode, ranAt: new Date().toISOString(), price, stages, final, disclaimer: DISCLAIMER };
  }

  if (mode === 'quick') {
    const two = [ALL_ANALYSTS[0], ALL_ANALYSTS[1]];
    const digest = buildDigest(two, quote, klines);
    stages.collect = {
      title: '第一阶段 · 数据收集（快速模式：技术 + 基本面）',
      rule: '两名分析师并行开工，报告只交主理人',
      agents: two,
      digest,
    };
    const w = digest.weightedBias;
    const verdict = w >= 0.3 ? 'BUY' : w <= -0.3 ? 'SELL' : 'HOLD';
    stages.debate = { title: '（快速模式跳过多空辩论，主理人直接加权裁决）', chief: { name: 'Arbiter · 主理人', verdict, reason: `快速模式：按加权偏多度 ${w} 直接裁决`, score: w } };
    const trade = trader(verdict, digest.price, klines);
    stages.trade = trade;
    final = {
      decision: trade.approved ? verdict : '观望',
      note: `快速分析：${verdict}（研究倾向），${trade.note}`,
      disclaimer: DISCLAIMER,
    };
    return { symbol, mode, ranAt: new Date().toISOString(), price, stages, final, disclaimer: DISCLAIMER };
  }

  // 完整 / 辩论 / 风险模式：先跑第一阶段
  stages.collect = {
    title: '第一阶段 · 数据收集（四分析师并行开工）',
    rule: '四份报告全部交回主理人，才进入下一站；成员间严禁直连',
    agents: ALL_ANALYSTS,
    digest: buildDigest(ALL_ANALYSTS, quote, klines),
  };

  if (mode === 'risk') {
    // 风险诊断：跳过多空辩论，基于当前价格生成委托参数再做风控
    const assumedVerdict = digestWeight(stages.collect.digest) >= 0 ? 'BUY' : 'SELL';
    const trade = trader(assumedVerdict, entryPrice ?? price, klines);
    stages.trade = { ...trade, note: `风险诊断模式：按持仓成本/现价 ${trade.entry} 假设 ${assumedVerdict} 方向。${trade.note}` };
    const trio = riskTrio(trade, stages.collect.digest, klines);
    stages.risk = { ...trio, chief: riskChief(trade, trio, assumedVerdict, stages.collect.digest) };
    final = {
      decision: stages.risk.chief.decision,
      note: stages.risk.chief.notes,
      disclaimer: DISCLAIMER,
    };
    return { symbol, mode, ranAt: new Date().toISOString(), price, stages, final, disclaimer: DISCLAIMER };
  }

  // debate / full：第二阶段多空辩论
  const bull = bullResearcher(stages.collect.digest);
  const bear = bearResearcher(stages.collect.digest, bull);
  const chief = researchChief(stages.collect.digest, bull, bear);
  stages.debate = {
    title: '第二阶段 · 多空辩论（多头先行 → 空头反驳 → 主管裁决）',
    rule: '多头与空头互不直连，论战材料均经主理人中转',
    bull,
    bear,
    chief,
  };

  if (mode === 'debate') {
    final = {
      decision: chief.verdict,
      note: `辩论模式完成：研究主管裁决 ${chief.verdict} —— ${chief.reason}`,
      disclaimer: DISCLAIMER,
    };
    return { symbol, mode, ranAt: new Date().toISOString(), price, stages, final, disclaimer: DISCLAIMER };
  }

  // full：第三至第五阶段
  const trade = trader(chief.verdict, digestPrice(stages.collect.digest), klines);
  stages.trade = trade;
  const trio = riskTrio(trade, stages.collect.digest, klines);
  stages.risk = { ...trio, chief: riskChief(trade, trio, chief.verdict, stages.collect.digest) };
  final = {
    decision: stages.risk.chief.decision,
    note: stages.risk.chief.notes,
    teamScore: Math.round(50 + stages.collect.digest.weightedBias * 50),
    disclaimer: DISCLAIMER,
  };
  return { symbol, mode, ranAt: new Date().toISOString(), price, stages, final, disclaimer: DISCLAIMER };
}

function digestWeight(digest) {
  return digest.weightedBias;
}
function digestPrice(digest) {
  return digest.price;
}

module.exports = { run, DISCLAIMER };
