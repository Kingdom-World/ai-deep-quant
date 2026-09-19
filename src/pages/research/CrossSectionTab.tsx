// ─────────────────────────────────────────────────────────────
// 研究中心 · Tab1 横截面回测（原 ResearchPage.CrossSectionLab 整体搬移，逻辑零改动）
//
//   搬移后新增（红队 R-E / R-B 裁决的落点）：
//   ① 桥接说明——本页结果**不产生** ExperimentRecord（实验留痕的生成源是 /backtest
//      单标的回测，见 ResearchPage.tsx:377 原注释），故结果区明确引导"要留痕去策略回测"；
//   ② Agent 研究入口——"跑完回测想追问"的自然衔接点（红队否决了放 Tab4 的原案）。
// ─────────────────────────────────────────────────────────────
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import * as echarts from 'echarts';
import { researchApi, type CrossBacktestResult } from '../../api/dataService';
import { theme } from '../../lib/theme';
import { card, sectionTitle, sectionSub, label, input, btn, Metric, pctColorOf } from './shared';

/**
 * 表达式前端**预检**（不替代后端解析）。
 *   只挡三类明显错误，给出即时反馈；真正的语法裁决权在后端 factorexpr 解析器
 *   （单一实现）。此处绝不复刻算子表/优先级——那会造出第二套语法。
 */
function precheckExpr(s: string): string {
  const t = s.trim();
  if (!t) return '表达式为空';
  if (t.length > 240) return `表达式过长（${t.length} > 240 字符）`;
  let depth = 0;
  for (const ch of t) {
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth < 0) return '括号不配对（多出右括号）'; }
  }
  if (depth !== 0) return '括号不配对（缺少右括号）';
  return '';
}

// 模块级缓存：条件渲染下组件会随 Tab 切换卸载，用户跑出的回测结果不能丢——
// 这是"保活"的轻量等价物：只缓存高价值状态（回测结果），列表类数据幂等重拉可接受
const resultCache: { value: CrossBacktestResult | null } = { value: null };

function CrossSectionLab() {
  const [factor, setFactor] = useState('mom60');
  // M3.3：预置因子 / 自定义表达式二选一。表达式语法由后端解析器裁决（单一实现），
  //   前端只做**极轻量的**预检（空值 / 括号配对 / 长度），避免把解析规则在前端复刻一份
  //   ——那是典型的口径分裂来源。
  const [factorMode, setFactorMode] = useState<'preset' | 'expr'>('preset');
  const [expr, setExpr] = useState('mom60 - mom20');
  const [topN, setTopN] = useState(5);
  const [rebalanceEvery, setRebalanceEvery] = useState(20);
  const [capital, setCapital] = useState(1_000_000);
  const [slippage, setSlippage] = useState(0.001);
  const [result, setResult] = useState<CrossBacktestResult | null>(resultCache.value);
  // 前端预检结果（仅用于即时提示；最终裁决在后端）
  const exprError = factorMode === 'expr' ? precheckExpr(expr) : '';
  // 实际提交给后端的因子串：预置模式用下拉值，表达式模式用输入框原文
  const effectiveFactor = factorMode === 'preset' ? factor : expr.trim();
  const [err, setErr] = useState('');
  const [running, setRunning] = useState(false);
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInst = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!chartRef.current) return;
    // 条件渲染保证本组件只在 Tab 激活时挂载 → 容器始终可见，init 不会拿到 0 尺寸
    if (!chartInst.current) chartInst.current = echarts.init(chartRef.current);
    if (result?.equity?.length) {
      chartInst.current.setOption({
        grid: { left: 70, right: 20, top: 30, bottom: 28 },
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'category', data: result.equity.map((e) => e.date), axisLabel: { color: '#64748b', fontSize: 10 } },
        yAxis: { type: 'value', scale: true, axisLabel: { color: '#64748b', fontSize: 10 } },
        series: [{
          type: 'line', data: result.equity.map((e) => e.value), showSymbol: false,
          lineStyle: { color: '#60a5fa', width: 2 }, areaStyle: { color: 'rgba(96,165,250,0.08)' },
        }],
        textStyle: { color: '#94a3b8' },
      });
    }
  }, [result]);

  const run = async () => {
    if (exprError) { setErr(exprError); return; } // 前端预检拦下明显的语法错误
    setRunning(true);
    setErr('');
    try {
      const r = await researchApi.crossBacktest({ factor: effectiveFactor, topN, rebalanceEvery, capital, slippage });
      // 后端对非法表达式/空截面会返回 error 字段（且不回净值）——
      // 必须走错误分支，绝不能把"算不出"显示成"收益 0"（铁律 #4）。
      if (r.error) { setErr(r.error); setResult(null); return; }
      resultCache.value = r;
      setResult(r);
    } catch (e) {
      setErr((e as Error).message);
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={card}>
      <div style={sectionTitle}>横截面回测 · 动量组合</div>
      <div style={sectionSub}>消费本地 Baostock 归档（不复权+因子），T-1 收盘排名、T 开盘成交；分项费率 + 100 股整手 + 滑点。先运行 scripts/sync_baostock.py 建库。</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ width: 130 }}>
          <div style={label}>因子类型</div>
          <select value={factorMode} onChange={(e) => setFactorMode(e.target.value as 'preset' | 'expr')} style={input}>
            <option value="preset">预置因子</option>
            <option value="expr">自定义表达式</option>
          </select>
        </div>
        {factorMode === 'preset' ? (
          <div style={{ width: 130 }}>
            <div style={label}>因子</div>
            <select value={factor} onChange={(e) => setFactor(e.target.value)} style={input}>
              <option value="mom20">动量 20 日</option>
              <option value="mom60">动量 60 日</option>
              <option value="mom120">动量 120 日</option>
              <option value="rev20">反转 20 日</option>
              <option value="rev60">反转 60 日</option>
              <option value="rev120">反转 120 日</option>
            </select>
          </div>
        ) : (
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={label}>表达式</div>
            <input
              value={expr}
              onChange={(e) => setExpr(e.target.value)}
              placeholder="如 mom60 - mom20"
              spellCheck={false}
              style={{
                ...input,
                width: '100%',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                borderColor: exprError ? theme.color.down : theme.color.borderStrong,
              }}
            />
            <div style={{ fontSize: 11, marginTop: 5, lineHeight: 1.6, color: exprError ? theme.color.down : theme.color.textFaint }}>
              {exprError ? (
                <>{exprError}</>
              ) : (
                <>
                  {'算子：mom{n} / rev{n} / vol{n} / bias{n} / lowvol{n} / turnover{n} / amount{n} / volratio(n,m)'}
                  <br />
                  {'支持 + − × ÷ 与括号。{n} 表示窗口天数，如 mom20（也可写 mom(20)）。'}
                  {expr.trim() === 'mom60 - mom20' && '当前示例为「长期动量减弱期动量」的轮动型因子。'}
                </>
              )}
            </div>
          </div>
        )}
        <div style={{ width: 90 }}>
          <div style={label}>持有 TopN</div>
          <input type="number" min={1} max={20} value={topN} onChange={(e) => setTopN(Math.max(1, Number(e.target.value) || 1))} style={input} />
        </div>
        <div style={{ width: 110 }}>
          <div style={label}>调仓周期（日）</div>
          <input type="number" min={1} max={250} value={rebalanceEvery} onChange={(e) => setRebalanceEvery(Math.max(1, Number(e.target.value) || 1))} style={input} />
        </div>
        <div style={{ width: 130 }}>
          <div style={label}>初始资金</div>
          <input type="number" value={capital} onChange={(e) => setCapital(Number(e.target.value) || 1_000_000)} style={input} />
        </div>
        <div style={{ width: 110 }}>
          <div style={label}>滑点（单边）</div>
          <input type="number" step={0.0005} value={slippage} onChange={(e) => setSlippage(Number(e.target.value) || 0)} style={input} />
        </div>
        <button onClick={run} disabled={running} style={btn}>{running ? '回测中…' : '运行回测'}</button>
      </div>
      {err && <div style={{ marginTop: 10, fontSize: 12, color: '#ef4444' }}>✗ {err}</div>}
      {result && !result.error && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
            <Metric name="区间" value={`${result.range.start.slice(0, 7)} ~ ${result.range.end.slice(0, 7)}`} />
            <Metric name="股票池" value={`${result.universeSize} 只`} />
            <Metric name="总收益" value={`${result.totalReturn}%`} color={pctColorOf(result.totalReturn)} />
            <Metric name="年化" value={`${result.annualized}%`} color={pctColorOf(result.annualized)} />
            <Metric name="最大回撤" value={`${result.maxDrawdownPct}%`} color="#ef4444" />
            <Metric name="夏普" value={result.sharpe ?? '—'} />
            <Metric name="调仓次数" value={result.rebalances} />
            <Metric name="成交笔数" value={result.fills} />
            <Metric name="费率" value={`${result.feeRatePct}%`} color="#f59e0b" />
          </div>
          <div ref={chartRef} style={{ width: '100%', height: 260, marginTop: 12 }} />
          {/* 桥接（R-E）：本页结果不写入实验留痕；追问入口（R-B） */}
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 10, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span>↳ 横截面结果不写入实验留痕；要留痕请到 <Link to="/backtest" style={{ color: '#60a5fa' }}>策略回测</Link> 跑单标的回测。</span>
            <Link to="/agent-research" style={{ color: '#60a5fa' }}>用 Agent 追问本次回测 →</Link>
          </div>
        </>
      )}
    </div>
  );
}

export default function CrossSectionTab() {
  return <CrossSectionLab />;
}
