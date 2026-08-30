// ─────────────────────────────────────────────────────────────
// Agent 团队分析系统 v3（主理人调度制 · 五阶段 · 两轮辩论 · 场景推演 · 报告持久化）
//   参考 TradingAgents（tauricresearch）与 ai-hedge-fund（virattt）的多 Agent 架构模式：
//   分析师全文报告 → 结构化多轮辩论 → 交易员场景推演 → 风险辩论与终审 → 报告落盘可分享
//   ── 铁律（内部执行，前端不展示）：成员间严禁直连，所有信息经主理人中转 ──
//
//   合规（脱敏）：全部输出为本地程序化规则引擎生成的学术研究演示，不构成投资建议；
//   数据来自公开行情与东方财富公开接口（财务/公告/资金流/融资融券/新闻），未覆盖项明确标注降级。
// ─────────────────────────────────────────────────────────────
const reportstore = require('./reportstore.cjs');

const DISCLAIMER =
  '本报告及全部 Agent 内容由本地程序化规则引擎自动生成的学术研究演示，不构成任何投资建议，不代表任何真实机构或分析师观点。' +
  '数据来自公开行情接口与东方财富公开数据（财务/公告/资金流/融资融券/新闻），未覆盖项已在文中明确标注降级。';

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

const yi = (v) => (Number.isFinite(v) ? (v / 1e8).toFixed(2) + ' 亿' : '--');

// ═══════════ 第一阶段 · 数据收集（四分析师，各出全文报告） ═══════════

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

  const seg = closes.slice(-20);
  let above = 0;
  for (let i = 0; i < seg.length; i++) {
    const m = sma(closes.slice(Math.max(0, closes.length - 24 + i + 1)), 20);
    if (m != null && seg[i] > m) above += 1;
  }
  const health = Math.min(100, Math.round((above / seg.length) * 60 + Math.min(Math.max(bull - bear, 0), 2) * 20));
  findings.push(`趋势健康值 ${health}/100（近20日站上MA20比例 ${Math.round((above / seg.length) * 100)}%）`);

  const bias = bull > bear ? 'bullish' : bear > bull ? 'bearish' : 'neutral';
  const report = [
    `## 摘要`,
    `${symbol} 当前价 ${price?.toFixed?.(2) ?? price}。技术面偏 ${bias === 'bullish' ? '多' : bias === 'bearish' ? '空' : '中性'}，趋势健康值 ${health}/100。`,
    `## 核心发现`,
    ...findings.map((f) => `- ${f}`),
    `## 数据快照`,
    `- MA5/MA20/MA60: ${ma5?.toFixed(2) ?? '--'} / ${ma20?.toFixed(2) ?? '--'} / ${ma60?.toFixed(2) ?? '--'}`,
    `- MACD: DIF ${macd?.dif?.toFixed(3) ?? '--'} | DEA ${macd?.dea?.toFixed(3) ?? '--'} | 柱 ${macd?.hist?.toFixed(3) ?? '--'}`,
    `- RSI(14): ${rsi?.toFixed(1) ?? '--'}`,
    `- 样本: 日 K ${klines.length} 根（${klines[0]?.date} ~ ${klines[klines.length - 1]?.date}）`,
    `## 局限`,
    `- 仅基于日线行情数据，未覆盖盘中 tick 与更高维度量价结构`,
  ].join('\n');

  return {
    name: 'Alpha · 技术分析师',
    role: '盯 K 线 / MACD / RSI，评估趋势与健康值',
    findings,
    report,
    bias,
    confidence: Math.min(55 + Math.abs(bull - bear) * 15, 90),
    metrics: { ma5, ma20, ma60, rsi, health, macdHist: macd?.hist ?? null, price },
    limitations: ['仅基于日线行情数据，未覆盖盘中 tick 与更高维度量价结构'],
    sources: ['腾讯/新浪公开行情（日线）'],
  };
}

function fundamentalAnalyst(symbol, klines, quote, feed) {
  const closes = klines.map((k) => k.close);
  const price = quote?.price ?? closes[closes.length - 1];
  const fund = feed?.fundamentals ?? null;
  const val = feed?.valuation ?? null;

  if (fund && (fund.roe != null || val?.pe != null)) {
    const findings = [];
    let bull = 0;
    let bear = 0;
    if (fund.roe != null) {
      if (fund.roe >= 15) { findings.push(`加权 ROE ${fund.roe.toFixed(1)}%（${fund.reportDate}），盈利能力优秀`); bull += 2; }
      else if (fund.roe >= 8) { findings.push(`加权 ROE ${fund.roe.toFixed(1)}%，盈利能力良好`); bull += 1; }
      else { findings.push(`加权 ROE ${fund.roe != null ? fund.roe.toFixed(1) : '--'}%，盈利能力偏弱`); bear += 1; }
    }
    if (fund.profitYoY != null) {
      if (fund.profitYoY >= 20) { findings.push(`归母净利润同比 +${fund.profitYoY.toFixed(1)}%，业绩高增长`); bull += 2; }
      else if (fund.profitYoY <= -20) { findings.push(`归母净利润同比 ${fund.profitYoY.toFixed(1)}%，业绩明显下滑`); bear += 2; }
      else findings.push(`归母净利润同比 ${fund.profitYoY != null ? fund.profitYoY.toFixed(1) + '%' : '--'}，业绩平稳`);
    }
    if (fund.grossMargin != null) findings.push(`销售毛利率 ${fund.grossMargin.toFixed(1)}%${fund.grossMargin >= 40 ? '（高毛利生意属性）' : ''}`);
    if (fund.debt != null) findings.push(`资产负债率 ${fund.debt.toFixed(1)}%${fund.debt > 70 ? '，杠杆偏高需警惕' : fund.debt <= 45 ? '，财务结构稳健' : ''}`);
    if (val?.pe != null && val.pe > 0) {
      if (val.pe < 15) { findings.push(`市盈率(动) ${val.pe.toFixed(1)}，处于低估值区间`); bull += 1; }
      else if (val.pe > 60) { findings.push(`市盈率(动) ${val.pe.toFixed(1)}，估值偏高，透支预期风险`); bear += 1; }
      else findings.push(`市盈率(动) ${val.pe.toFixed(1)}，估值处于市场常见区间`);
    }
    if (val?.pb != null) findings.push(`市净率 ${val.pb.toFixed(2)}${val.marketCap ? ` · 总市值 ${(val.marketCap / 1e8).toFixed(0)} 亿` : ''}`);
    const bias = bull > bear ? 'bullish' : bear > bull ? 'bearish' : 'neutral';

    const trendLines = (fund.trend ?? []).slice(0, 4).map((t) => `- ${t.date}: 归母净利 ${t.profit != null ? yi(t.profit) : '--'} · ROE ${t.roe != null ? t.roe.toFixed(1) + '%' : '--'}`);
    const report = [
      `## 摘要`,
      `基于 ${fund.reportDate} 财报与最新估值快照：基本面偏 ${bias === 'bullish' ? '多' : bias === 'bearish' ? '空' : '中性'}。`,
      `## 核心发现`,
      ...findings.map((f) => `- ${f}`),
      `## 财务趋势（近几期）`,
      ...trendLines,
      `## 数据来源`,
      `- 东方财富 F10 主要财务指标（报告期 ${fund.reportDate}）`,
      `- 东方财富估值快照（PE(动)/PB/总市值）`,
      `## 局限`,
      fund.quarters < 4 ? ['- 公开财报期数较少，历史可比性有限'] : ['- 期数充足，但未覆盖非财务维度的基本面信息'],
    ].join('\n');

    return {
      name: 'Beta · 基本面分析师',
      role: '财报 ROE / EPS / 毛利率 / 估值（东方财富真实数据）',
      findings,
      report,
      bias,
      confidence: Math.min(60 + Math.abs(bull - bear) * 8, 82),
      metrics: { roe: fund.roe, eps: fund.eps, pe: val?.pe ?? null, pb: val?.pb ?? null, profitYoY: fund.profitYoY },
      limitations: fund.quarters < 4 ? ['公开财报期数较少，历史可比性有限'] : [],
      sources: ['东方财富 F10 主要财务指标', '东方财富估值快照'],
    };
  }

  // 降级分支：价格行为代理指标
  const slope = trendSlope(closes, 120);
  const mdd = maxDrawdown(closes, 250);
  const high52 = Math.max(...klines.slice(-250).map((k) => k.high));
  const drawdownFromHigh = ((high52 - price) / high52) * 100;
  const findings = [];
  let bias = 'neutral';
  if (slope != null) {
    if (slope > 0.08) { findings.push(`120 日趋势斜率 +${slope.toFixed(3)}%/根，长期定价中枢持续上移`); bias = 'bullish'; }
    else if (slope < -0.08) { findings.push(`120 日趋势斜率 ${slope.toFixed(3)}%/根，长期定价中枢下移`); bias = 'bearish'; }
    else findings.push(`长期趋势斜率 ${slope?.toFixed(3)}%/根，接近零轴，基本面定价变化平淡`);
  }
  findings.push(`现价距 52 周高点回撤 ${drawdownFromHigh.toFixed(1)}%，250 日最大回撤 ${mdd.toFixed(1)}%`);
  if (mdd < 20) findings.push('历史回撤特征温和，价格行为显示经营波动预期较低（代理判断）');
  if (mdd > 45) findings.push('历史回撤剧烈，价格行为隐含较高的基本面不确定性（代理判断）');

  const report = [
    `## 摘要`,
    `⚠️ 本次财务与估值数据源不可用，已降级为价格行为代理分析，置信度受限。`,
    `## 核心发现`,
    ...findings.map((f) => `- ${f}`),
    `## 局限`,
    `- 无法计算真实 ROE / PE / PB，不能替代基本面研究`,
  ].join('\n');

  return {
    name: 'Beta · 基本面分析师',
    role: '财报 / ROE / 真实价值评估（数据受限，使用价格行为代理指标）',
    findings,
    report,
    bias,
    confidence: 45,
    metrics: { slope, maxDrawdown: mdd, drawdownFromHigh },
    limitations: ['本次财务/估值数据源暂时不可用，已降级为价格行为代理指标，不能替代基本面研究'],
    sources: ['公开行情（代理指标）'],
  };
}

function newsAnalyst(symbol, klines, quote, feed) {
  const recent = klines.slice(-10);
  const avgVol20 = sma(klines.slice(-30).map((k) => k.volume), 20) ?? 0;
  const anns = feed?.announcements ?? null;
  const news = feed?.stockNews ?? null;

  const findings = [];
  let bias = 'neutral';
  let good = 0;
  let bad = 0;
  let events = 0;

  const GOOD = /中标|预增|增长|增持|回购|分红|派息|合作|获批|签订|向好|突破/;
  const BAD = /减持|质押|诉讼|处罚|亏损|预减|下滑|警示|问询|违规|退市/;
  if (anns && anns.length) {
    for (const a of anns) {
      if (GOOD.test(a.title)) good += 1;
      if (BAD.test(a.title)) bad += 1;
    }
    if (good + bad > 0) {
      findings.push(`近 ${anns.length} 条公告情绪扫描：利好类关键词 ${good} 条 / 利空类 ${bad} 条`);
      for (const a of anns.slice(0, 3)) findings.push(`· [${a.date}] ${a.title.slice(0, 40)}`);
      if (good > bad) bias = 'bullish';
      else if (bad > good) bias = 'bearish';
    } else {
      findings.push(`近 ${anns.length} 条公告未检出明显利好/利空关键词，消息面平静`);
    }
  }
  if (news && news.length) {
    findings.push(`全网新闻检索到 ${news.length} 条相关报道（${news[0].date} 起），已纳入事件交叉验证`);
    for (const n of news.slice(0, 3)) findings.push(`· [${n.date}] ${n.title.slice(0, 40)}（${n.media}）`);
  }

  for (const k of recent) {
    const volRatio = avgVol20 > 0 ? k.volume / avgVol20 : 0;
    const chg = ((k.close - k.open) / k.open) * 100;
    if (volRatio > 2 && chg > 5) {
      findings.push(`${k.date} 放量上涨（量比 ${volRatio.toFixed(1)}×，涨幅 ${chg.toFixed(1)}%），与消息面互相印证价值高`);
      events += 1;
      if (bias === 'neutral') bias = 'bullish';
    } else if (volRatio > 2 && chg < -5) {
      findings.push(`${k.date} 放量下跌（量比 ${volRatio.toFixed(1)}×，跌幅 ${chg.toFixed(1)}%），注意与消息面交叉验证`);
      events += 1;
      if (bias === 'neutral') bias = 'bearish';
    }
  }
  if (events === 0 && !anns && !news) findings.push('近 10 个交易日未检出放量异动事件，价格走势平稳，无异常事件信号');

  const report = [
    `## 摘要`,
    anns || news ? `消息面样本：公告 ${anns?.length ?? 0} 条 / 全网新闻 ${news?.length ?? 0} 条；量价异动 ${events} 起。` : '⚠️ 公告与新闻数据源本次均不可用，已降级为量价事件检测。',
    `## 核心发现`,
    ...findings.map((f) => `- ${f}`),
    `## 数据来源`,
    anns ? `- 东方财富公告接口（${anns.length} 条）` : '- 公告接口本次不可用',
    news ? `- 东方财富新闻搜索（${news.length} 条）` : '- 新闻搜索本次不可用',
    `## 局限`,
    `- 仅扫描标题关键词，未做全文语义理解，存在误判可能`,
  ].join('\n');

  return {
    name: 'Gamma · 新闻分析师',
    role: anns || news ? '公告情绪扫描 + 全网新闻检索 + 量价事件检测（真实数据）' : '追公告 / 政策 / 行业风向（数据受限，使用量价事件检测代理）',
    findings,
    report,
    bias,
    confidence: anns || news ? Math.min(50 + (good + bad) * 4 + (news?.length ? 8 : 0), 74) : 40,
    metrics: { events, good, bad, annCount: anns?.length ?? 0, newsCount: news?.length ?? 0 },
    limitations: ['仅扫描标题关键词，未做全文语义理解，存在误判可能'],
    sources: ['东方财富公告接口', ...(news ? ['东方财富新闻搜索'] : [])],
  };
}

function sentimentAnalyst(symbol, klines, quote, feed) {
  const closes = klines.map((k) => k.close);
  const flow = feed?.moneyFlow ?? null;
  const margin = feed?.marginData ?? null;
  const north = feed?.northHold ?? null;
  const price = quote?.price ?? closes[closes.length - 1];
  const high52 = Math.max(...klines.slice(-250).map((k) => k.high));
  const low52 = Math.min(...klines.slice(-250).map((k) => k.low));
  const posInRange = ((price - low52) / (high52 - low52)) * 100;

  const upVols = [];
  const downVols = [];
  for (let i = Math.max(1, klines.length - 20); i < klines.length; i++) {
    (klines[i].close >= klines[i - 1].close ? upVols : downVols).push(klines[i].volume);
  }
  const avgUp = upVols.length ? upVols.reduce((a, b) => a + b, 0) / upVols.length : 0;
  const avgDown = downVols.length ? downVols.reduce((a, b) => a + b, 0) / downVols.length : 0;
  const pvRatio = avgDown > 0 ? avgUp / avgDown : 1;
  const rsi = rsiLast(closes, 14);

  const findings = [];
  let bias = 'neutral';

  if (flow) {
    if (flow.streak > 0) {
      findings.push(`主力资金已连续 ${flow.streak} 日净流入，近 5 日合计 ${yi(flow.sum5)}，近 10 日 ${yi(flow.sum10)}`);
      if (flow.sum10 > 0) bias = 'bullish';
    } else if (flow.streak < 0) {
      findings.push(`主力资金已连续 ${-flow.streak} 日净流出，近 5 日合计 ${yi(flow.sum5)}，近 10 日 ${yi(flow.sum10)}`);
      if (flow.sum10 < 0) bias = 'bearish';
    } else {
      findings.push(`主力资金近 5 日 ${yi(flow.sum5)} / 近 10 日 ${yi(flow.sum10)}，方向反复，多空分歧大`);
    }
  }
  if (margin) {
    findings.push(`融资余额 ${yi(margin.rzye)}（${margin.latestDate}）${margin.change5 != null ? `，近 10 日变动 ${margin.change5 > 0 ? '+' : ''}${margin.change5.toFixed(1)}%` : ''}，杠杆资金情绪${(margin.change5 ?? 0) > 0 ? '偏积极' : '偏谨慎'}`);
    if ((margin.change5 ?? 0) > 3 && bias === 'neutral') bias = 'bullish';
    if ((margin.change5 ?? 0) < -3 && bias === 'neutral') bias = 'bearish';
  }
  if (north) {
    findings.push(`北向持股${north.date ? `（${north.date}）` : ''}：${north.marketValue ? yi(north.marketValue) : '数据缺失'}${north.ratio ? ` · 占流通比 ${north.ratio.toFixed(2)}%` : ''}`);
  }
  if (pvRatio > 1.25) {
    findings.push(`量价配合度 ${pvRatio.toFixed(2)}：上涨日平均成交量显著大于下跌日，参与意愿偏多（代理指标）`);
    if (bias === 'neutral') bias = 'bullish';
  } else if (pvRatio < 0.8) {
    findings.push(`量价配合度 ${pvRatio.toFixed(2)}：下跌日放量更明显，抛压情绪占优（代理指标）`);
    if (bias === 'neutral') bias = 'bearish';
  } else {
    findings.push(`量价配合度 ${pvRatio.toFixed(2)}，多空情绪均衡`);
  }
  if (rsi != null && rsi > 75) findings.push(`RSI=${rsi.toFixed(1)} 情绪过热，追高意愿拥挤，警惕情绪退潮`);
  if (posInRange > 90) findings.push(`现价处于 52 周区间 ${posInRange.toFixed(0)}% 分位，接近年内高位，市场关注度高位`);

  const report = [
    `## 摘要`,
    `情绪面偏 ${bias === 'bullish' ? '多' : bias === 'bearish' ? '空' : '中性'}。数据覆盖：${[flow && '主力资金', margin && '融资融券', north && '北向持股'].filter(Boolean).join('、') || '无真实资金数据（降级为量价代理）'}。`,
    `## 核心发现`,
    ...findings.map((f) => `- ${f}`),
    `## 数据来源`,
    flow ? '- 东方财富个股资金流（近 20 日）' : '- 资金流接口本次不可用',
    margin ? '- 东方财富融资融券明细' : '',
    north ? '- 东方财富北向持股统计' : '- 北向持股接口不可用（自动降级）',
    `## 局限`,
    `- 北向资金分时 / 融资融券全网口径未完整覆盖，情绪画像仍有盲区`,
  ].filter(Boolean).join('\n');

  return {
    name: 'Delta · 情绪分析师',
    role: `主力资金 / 融资融券${north ? ' / 北向持股' : ''} + 量价结构情绪`,
    findings,
    report,
    bias,
    confidence: Math.min(45 + (flow ? 15 : 0) + (margin ? 10 : 0) + (north ? 8 : 0), 80),
    metrics: { pvRatio, rsi, posInRange, sum5: flow?.sum5 ?? null, streak: flow?.streak ?? null, rzye: margin?.rzye ?? null },
    limitations: [north ? '' : '北向持股数据不可用（已降级）', '资金面全网口径未完整覆盖，情绪画像仍有盲区'].filter(Boolean),
    sources: [flow ? '东方财富个股资金流' : '', margin ? '东方财富融资融券明细' : '', north ? '东方财富北向持股统计' : ''].filter(Boolean),
  };
}

// ═══════════ 主理人中转摘要 ═══════════

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
    weightedBias: +(w / reports.length).toFixed(3),
    votes,
    keyPoints,
    price: quote?.price ?? closes[closes.length - 1],
    limitations: [...new Set(reports.flatMap((r) => r.limitations))],
  };
}

// ═══════════ 第二阶段 · 两轮多空辩论 ═══════════

function bullResearcher(digest) {
  const args = [];
  if (digest.votes.bullish > 0) args.push(`${digest.votes.bullish} 份收集报告倾向多方，加权偏多度 ${digest.weightedBias}，趋势与资金结构存在共振基础`);
  digest.keyPoints.forEach((kp) => {
    const p = kp.points.find((x) => /多头|向上|增强|偏多|反弹|放大|上移|温和|关注度高|优秀|低估值|高增长|净流入/.test(x));
    if (p) args.push(p);
  });
  args.push('量价结构若延续，动量策略存在顺周期空间；回撤可控时风险收益占优');
  return { name: 'Bull-1 · 多头研究员', arguments: args.slice(0, 4), stance: '买入逻辑：趋势 × 动能 × 参与度三要素' };
}

function bearResearcher(digest, bull) {
  const args = [];
  if (digest.votes.bearish > 0) args.push(`${digest.votes.bearish} 份收集报告倾向空方，反向信号不可忽视`);
  digest.keyPoints.forEach((kp) => {
    const p = kp.points.find((x) => /超买|超卖|回撤|走弱|下移|退潮|抛压|不确定性|杠杆偏高|估值偏高/.test(x));
    if (p) args.push(p);
  });
  if (bull?.arguments?.length) args.push(`对多头第一条论点的反驳："${bull.arguments[0].slice(0, 40)}…"——顺周期外推在量价背离时会迅速失效`);
  args.push(`四份报告中置信度受数据局限压低的越多，多头证据链越不牢固`);
  return { name: 'Bear-1 · 空头研究员', arguments: args.slice(0, 4), stance: '卖出/防守逻辑：证伪多头证据链的薄弱环节' };
}

function bullRebut(digest, bear) {
  const args = [];
  const keep = digest.keyPoints
    .flatMap((kp) => kp.points)
    .find((x) => /健康值|净流入|ROE|毛利率|低估值|高增长|多头排列/.test(x));
  if (keep) args.push(`结构性证据未被空头推翻：${keep}`);
  if (bear?.arguments?.length) args.push(`空头引用的"${bear.arguments[0].slice(0, 30)}…"属于静态风险描述，并不构成方向性证据`);
  args.push('多头立场维持：只要趋势健康值不跌破中位，回调即是吸纳窗口');
  return { name: 'Bull-1 · 第二轮陈述', arguments: args.slice(0, 3) };
}

function bearFinal(digest, bullRebuttal) {
  const args = [];
  args.push('最终陈述：静态证据（均线/量价）外推的胜率依赖市场环境维持，而环境中最大的不可控变量是消息面与资金面突变');
  args.push('维持防守立场：在研究与教学语境下，HOLD/观望比追价更具长期期望值');
  return { name: 'Bear-1 · 最终陈述', arguments: args.slice(0, 2) };
}

function researchChief(digest, bull, bear, bullRebuttal, bearFinal) {
  const w = digest.weightedBias;
  let verdict = 'HOLD';
  let reason;
  if (w >= 0.35) {
    verdict = 'BUY';
    reason = `多方证据加权优势明显（加权偏多度 ${w}），两轮辩论中多头结构性证据未被有效证伪，裁决为 BUY（研究倾向）`;
  } else if (w <= -0.35) {
    verdict = 'SELL';
    reason = `空方证据加权优势明显（加权偏多度 ${w}），多头论证未能自洽，裁决为 SELL（研究倾向）`;
  } else {
    reason = `多空证据加权后接近均衡（加权偏多度 ${w}），依据"不和稀泥"铁律，明确裁决为 HOLD（研究倾向），等待更强的方向信号`;
  }
  return {
    name: 'Sensus · 研究主管',
    verdict,
    reason,
    score: w,
    rounds: 2,
    rule: '铁律：不和稀泥，必须给出 BUY / SELL / HOLD 之一',
  };
}

// ═══════════ 第三阶段 · 交易决策（场景推演） ═══════════

function trader(verdict, price, klines) {
  if (verdict === 'HOLD') {
    return {
      name: 'Vector · 交易员',
      approved: false,
      note: '研究主管裁决为 HOLD，不出具委托参数，进入观望',
      entry: price, target: null, stop: null, rr: null, scenarios: null,
    };
  }
  const atr = atr14(klines) ?? price * 0.02;
  const dir = verdict === 'BUY' ? 1 : -1;
  const entry = price;
  const stop = entry - dir * 2 * atr;
  const scenarios = [
    { name: '乐观', move: dir * 3 * atr, prob: 0.25 },
    { name: '中性', move: dir * 1.5 * atr, prob: 0.5 },
    { name: '悲观', move: -dir * 2 * atr, prob: 0.25 },
  ].map((s) => ({ ...s, price: +(entry + s.move).toFixed(2), pnlPct: +((s.move / entry) * 100).toFixed(2) }));
  const expected = scenarios.reduce((a, s) => a + s.move * s.prob, 0);
  const rr = Math.abs((dir * 3 * atr) / (dir * 2 * atr));
  return {
    name: 'Vector · 交易员',
    approved: expected * dir > 0 && rr >= 1,
    note: `期望收益 ${dir * expected >= 0 ? '+' : ''}${(dir * expected).toFixed(2)}（按概率加权），风险回报比 1:${rr.toFixed(2)}${expected * dir > 0 && rr >= 1 ? ' ≥ 1:1，委托参数通过审核' : '，不达标，该笔直接 pass'}`,
    entry: +entry.toFixed(2),
    target: +(entry + dir * 3 * atr).toFixed(2),
    stop: +stop.toFixed(2),
    rr: +rr.toFixed(2),
    scenarios,
  };
}

// ═══════════ 第四阶段 · 风险辩论 ═══════════

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
    _worstPct: worstPct,
  };
}

function riskDebate(trade, trio, digest) {
  const rounds = [];
  rounds.push({
    round: '第一轮',
    aggressive: trio.aggressive.opinion,
    conservative: trio.conservative.opinion,
  });
  rounds.push({
    round: '第二轮',
    aggressive: `保守派的跳空与流动性担忧成立，但可以通过"预设熔断 + 避免重仓单一标的"管理，而非放弃信号；${digest.weightedBias >= 0 ? '当前加权证据仍偏正面' : '当前加权证据偏弱恰说明更不该恋战'}`,
    conservative: `激进派承认了需要熔断机制——这正是本方立场的胜利；在研究与演示语境下，任何仓位的讨论都应默认带上"最坏情形 ${trio._worstPct.toFixed(1)}%"的脚注`,
  });
  rounds.push({
    round: '中性方案',
    neutral: trio.neutral.plan,
  });
  return rounds;
}

function riskChief(trade, trio, debate, verdict, digest) {
  let decision = verdict;
  let sizing = '——';
  const worstPct = trio._worstPct;
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
    notes: `综合两轮风险辩论与加权偏多度 ${digest.weightedBias}：激进派的机会成本论、保守派的最坏情形论（${worstPct.toFixed(1)}%）、中性派的分批节奏已全部纳入；最终决策 ${decision}（研究结论 · 非投资建议）`,
  };
}

// ═══════════ 主理人编排器 ═══════════

function run({ symbol, klines, quote, name, mode = 'full', agent, entryPrice, feed, uid = 'default' }) {
  const price = quote?.price ?? klines[klines.length - 1]?.close ?? null;
  const stages = {};
  let final = null;

  const ALL_ANALYSTS = [
    techAnalyst(symbol, klines, quote),
    fundamentalAnalyst(symbol, klines, quote, feed),
    newsAnalyst(symbol, klines, quote, feed),
    sentimentAnalyst(symbol, klines, quote, feed),
  ];

  const finish = (stages_, final_) => {
    const trace = {
      ok: true,
      symbol,
      name: name ?? quote?.name ?? '',
      mode,
      ranAt: new Date().toISOString(),
      price,
      stages: stages_,
      final: final_,
      disclaimer: DISCLAIMER,
    };
    const reportId = reportstore.saveReport(trace, uid);
    return { ...trace, reportId, uid };
  };

  if (mode === 'single') {
    const map = { tech: '技术', fundamental: '基本面', news: '新闻', sentiment: '情绪' };
    const key = map[agent];
    const one = ALL_ANALYSTS.find((a) => a.name.includes(key)) ?? ALL_ANALYSTS[0];
    stages.collect = { title: '单点调用 · ' + key + '分析师', agents: [one] };
    final = {
      decision: '——',
      note: `单点调研完成。${one.name} 的全文报告已归档，可通过报告链接查看`,
    };
    return finish(stages, final);
  }

  if (mode === 'quick') {
    const two = [ALL_ANALYSTS[0], ALL_ANALYSTS[1]];
    const digest = buildDigest(two, quote, klines);
    stages.collect = { title: '第一阶段 · 数据收集（快速模式：技术 + 基本面）', agents: two, digest };
    const w = digest.weightedBias;
    const verdict = w >= 0.3 ? 'BUY' : w <= -0.3 ? 'SELL' : 'HOLD';
    stages.debate = { title: '（快速模式跳过多空辩论，主理人直接加权裁决）', chief: { name: 'Arbiter · 主理人', verdict, reason: `快速模式：按加权偏多度 ${w} 直接裁决`, score: w } };
    const trade = trader(verdict, digest.price, klines);
    stages.trade = trade;
    final = {
      decision: trade.approved ? verdict : '观望',
      note: `快速分析：${verdict}（研究倾向），${trade.note}`,
      teamScore: Math.round(50 + w * 50),
    };
    return finish(stages, final);
  }

  stages.collect = {
    title: '第一阶段 · 数据收集（四分析师并行开工，各出全文报告）',
    agents: ALL_ANALYSTS,
    digest: buildDigest(ALL_ANALYSTS, quote, klines),
  };

  if (mode === 'risk') {
    const assumedVerdict = digestWeight(stages.collect.digest) >= 0 ? 'BUY' : 'SELL';
    const trade = trader(assumedVerdict, entryPrice ?? price, klines);
    stages.trade = { ...trade, note: `风险诊断模式：按持仓成本/现价 ${trade.entry} 假设 ${assumedVerdict} 方向。${trade.note}` };
    const trio = riskTrio(trade, stages.collect.digest, klines);
    const debate = riskDebate(trade, trio, stages.collect.digest);
    stages.risk = { ...trio, debate, chief: riskChief(trade, trio, debate, assumedVerdict, stages.collect.digest) };
    final = { decision: stages.risk.chief.decision, note: stages.risk.chief.notes };
    return finish(stages, final);
  }

  // debate / full：两轮多空辩论
  const bull1 = bullResearcher(stages.collect.digest);
  const bear1 = bearResearcher(stages.collect.digest, bull1);
  const bull2 = bullRebut(stages.collect.digest, bear1);
  const bear2 = bearFinal(stages.collect.digest, bull2);
  const chief = researchChief(stages.collect.digest, bull1, bear1, bull2, bear2);
  stages.debate = {
    title: '第二阶段 · 多空辩论（两轮）',
    round1: { bull: bull1, bear: bear1 },
    round2: { bull: bull2, bear: bear2 },
    bull: bull1,
    bear: bear1,
    chief,
  };

  if (mode === 'debate') {
    final = { decision: chief.verdict, note: `辩论模式完成：研究主管裁决 ${chief.verdict} —— ${chief.reason}` };
    return finish(stages, final);
  }

  const trade = trader(chief.verdict, digestPrice(stages.collect.digest), klines);
  stages.trade = trade;
  const trio = riskTrio(trade, stages.collect.digest, klines);
  const riskDebateRounds = riskDebate(trade, trio, stages.collect.digest);
  stages.risk = { ...trio, debate: riskDebateRounds, chief: riskChief(trade, trio, riskDebateRounds, chief.verdict, stages.collect.digest) };
  final = {
    decision: stages.risk.chief.decision,
    note: stages.risk.chief.notes,
    teamScore: Math.round(50 + stages.collect.digest.weightedBias * 50),
  };
  return finish(stages, final);
}

function digestWeight(digest) {
  return digest.weightedBias;
}
function digestPrice(digest) {
  return digest.price;
}

module.exports = { run, DISCLAIMER };
