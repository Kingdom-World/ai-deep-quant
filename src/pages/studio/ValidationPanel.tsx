// ─────────────────────────────────────────────────────────────
// ValidationPanel —— 建模页「验证轨」（Phase 2）
//
//   与「回测」的分工：回测回答"过去发生了什么"，验证回答"这个结论有多可信"。
//   故本面板的**首要输出是可信度与局限**，而不是一个漂亮的总收益数字。
//
//   🔴 措辞纪律（本组件的存在理由）：
//      · 「未发现不稳定信号」≠「模型有效」。验证只覆盖有限的几类失效模式，
//        pass=true 必须同屏说明"没覆盖什么"，否则用户会把"没报警"读成"能赚钱"。
//      · 任何一项跑不动都**显式外露**（skipped/error），不用"通过"掩盖未跑项。
//      · 已知局限常驻显示（服务端下发，界面不另抄一份）。
// ─────────────────────────────────────────────────────────────
import { useState } from 'react';
import { theme } from '../../lib/theme';
import { modelsApi } from '../../api/models';
import type {
  ModelSpec,
  ValidationReport,
  ValidationSpec,
  ValidateSuiteOptions,
  WalkForwardResult,
  PlateauResult,
  PlateauPoint,
  CausalityResult,
} from '../../api/models';

const MONO = 'var(--zone-mono, Consolas, monospace)';
const SURFACE = 'var(--zone-surface, #0e1218)';
const SURFACE2 = 'var(--zone-surface-2, #131822)';
const LINE = 'var(--zone-line, #222a36)';
const RADIUS = 'var(--zone-radius, 10px)';

const btn = (primary = false, disabled = false): React.CSSProperties => ({
  ...theme.input,
  cursor: disabled ? 'not-allowed' : 'pointer',
  color: primary ? '#fff' : theme.color.textMuted,
  background: primary ? theme.color.primaryDeep : SURFACE2,
  borderColor: primary ? theme.color.primary : LINE,
  opacity: disabled ? 0.45 : 1,
  whiteSpace: 'nowrap',
});

const fmtPct = (v: number | null | undefined) =>
  typeof v === 'number' && Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—';
const fmtNum = (v: number | null | undefined, d = 2) =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—';
/** 涨红跌绿（国内惯例）；非数值取弱化色 */
const pctColor = (v: number | null | undefined) =>
  typeof v !== 'number' || !Number.isFinite(v)
    ? theme.color.textFaint
    : v >= 0
      ? theme.color.up
      : theme.color.down;

function Card({ title, hint, children, accent }: { title: string; hint?: string; children: React.ReactNode; accent?: string }) {
  return (
    <div style={{ background: SURFACE, border: `1px solid ${LINE}`, borderRadius: RADIUS, padding: 12, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13, color: accent || theme.color.text }}>{title}</strong>
        {hint && <span style={{ fontSize: 11.5, color: theme.color.textFaint }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** 单元格：数值 + 单位色（表格用） */
function Td({ v, color, w }: { v: React.ReactNode; color?: string; w?: number }) {
  return (
    <td style={{ padding: '4px 8px', fontFamily: MONO, fontSize: 11.5, color: color || theme.color.textMuted, textAlign: 'right', whiteSpace: 'nowrap', width: w }}>
      {v}
    </td>
  );
}

function WalkForwardTable({ wf }: { wf: WalkForwardResult }) {
  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr style={{ color: theme.color.textFaint, fontSize: 11 }}>
              <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>折</th>
              <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>区间</th>
              <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>收益</th>
              <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>超额</th>
              <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>回撤</th>
              <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Sharpe</th>
              <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>调仓</th>
            </tr>
          </thead>
          <tbody>
            {wf.folds.map((f) => (
              <tr key={f.fold} style={{ borderTop: `1px solid ${LINE}` }}>
                <td style={{ padding: '4px 8px', fontSize: 11.5, color: theme.color.textFaint }}>{f.fold}</td>
                <td style={{ padding: '4px 8px', fontSize: 11, color: theme.color.textFaint, fontFamily: MONO, whiteSpace: 'nowrap' }}>
                  {f.actualRange.start}~{f.actualRange.end}
                </td>
                <Td v={fmtPct(f.totalReturn)} color={pctColor(f.totalReturn)} />
                <Td v={fmtPct(f.excessReturn)} color={pctColor(f.excessReturn)} />
                <Td v={fmtPct(f.maxDrawdownPct)} />
                <Td v={fmtNum(f.sharpe)} />
                <Td v={f.rebalances} />
              </tr>
            ))}
            <tr style={{ borderTop: `1px solid ${LINE}`, background: 'rgba(148,163,184,.05)' }}>
              <td style={{ padding: '4px 8px', fontSize: 11.5, color: theme.color.textMuted }}>整段</td>
              <td style={{ padding: '4px 8px', fontSize: 11, color: theme.color.textFaint, fontFamily: MONO }}>基准</td>
              <Td v={fmtPct(wf.overall.totalReturn)} color={pctColor(wf.overall.totalReturn)} />
              <Td v="—" />
              <Td v={fmtPct(wf.overall.maxDrawdownPct)} />
              <Td v={fmtNum(wf.overall.sharpe)} />
              <Td v="—" />
            </tr>
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 6, fontSize: 11.5, color: theme.color.textFaint, lineHeight: 1.7 }}>
        折间离散度 {fmtNum(wf.dispersion.spread)} 个百分点（min {fmtPct(wf.dispersion.min)} / max {fmtPct(wf.dispersion.max)}）；
        {wf.note}
      </div>
      {wf.skipped.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 11.5, color: theme.color.warn, lineHeight: 1.7 }}>
          {wf.skipped.length} 折未评估：
          {wf.skipped.map((s) => ` 第${s.fold}折（${s.reason}）`).join('；')}
        </div>
      )}
    </div>
  );
}

/** 参数平原：横向柱（长度∝|收益|，涨红跌绿），中心点标注 */
function PlateauBars({ pl }: { pl: PlateauResult }) {
  const pts = pl.points.filter((p) => p.ok) as (PlateauPoint & { totalReturn: number })[];
  if (!pts.length) return <div style={{ fontSize: 12, color: theme.color.textFaint }}>扫描点全部失败，无可比较数据</div>;
  const maxAbs = Math.max(1e-6, ...pts.map((p) => Math.abs(p.totalReturn)));
  const label = pl.param === 'topN' ? '持仓数' : '首因子权重';
  return (
    <div>
      {pts.map((p) => {
        const w = Math.max(2, (Math.abs(p.totalReturn) / maxAbs) * 100);
        const isCenter = Math.abs(p.ratio - 1) < 1e-9;
        return (
          <div key={p.value} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{ width: 92, fontSize: 11, color: isCenter ? theme.color.text : theme.color.textFaint, fontFamily: MONO, whiteSpace: 'nowrap' }}>
              {label}={p.value}
              {(p.ratio * 100).toFixed(0)}%{isCenter ? '（基准）' : ''}
            </span>
            <div style={{ flex: '1 1 auto', height: 12, background: SURFACE2, borderRadius: 3, overflow: 'hidden', border: `1px solid ${LINE}` }}>
              <div style={{ width: `${w}%`, height: '100%', background: p.totalReturn >= 0 ? theme.color.up : theme.color.down, opacity: isCenter ? 0.95 : 0.62 }} />
            </div>
            <span style={{ width: 120, textAlign: 'right', fontSize: 11, fontFamily: MONO, color: pctColor(p.totalReturn), whiteSpace: 'nowrap' }}>
              {fmtPct(p.totalReturn)}
              {p.deltaPct !== null && p.deltaPct !== undefined && !isCenter ? ` (${p.deltaPct >= 0 ? '+' : ''}${p.deltaPct})` : ''}
            </span>
          </div>
        );
      })}
      <div style={{ marginTop: 6, fontSize: 11.5, color: theme.color.textFaint, lineHeight: 1.7 }}>
        判据：边界点收益跌幅 &gt; {pl.rules.plateauMaxDropPct}%，或基准为正时边界点转负 ⇒ 判为尖峰；
        最近邻点跌幅 &gt; {pl.rules.plateauCenterHintPct}% ⇒ 提示参数敏感。
        <br />
        实际覆盖{' '}
        <span style={{ fontFamily: MONO, color: pl.coverage.actual[0] !== null && (pl.coverage.actual[0] > pl.coverage.requested[0] + 1e-9 || (pl.coverage.actual[1] !== null && pl.coverage.actual[1] < pl.coverage.requested[1] - 1e-9)) ? theme.color.warn : theme.color.textMuted }}>
          {pl.coverage.actual[0] === null ? '—' : `${(pl.coverage.actual[0] * 100).toFixed(0)}%~${(pl.coverage.actual[1]! * 100).toFixed(0)}%`}
        </span>
        （请求 {(pl.coverage.requested[0] * 100).toFixed(0)}%~{(pl.coverage.requested[1] * 100).toFixed(0)}%）
        {pl.mergedPoints.length > 0 && (
          <>；{pl.mergedPoints.length} 个点由多个比例合并（例：{pl.mergedPoints[0].mergedRatios.map((x) => `${(x * 100).toFixed(0)}%`).join(' + ')} → {label}={pl.mergedPoints[0].value}）</>
        )}
        <br />
        {pl.note}
      </div>
    </div>
  );
}

/** 因果性检验：截断段与全集逐点比对结果表 */
function CausalityTable({ cs }: { cs: CausalityResult }) {
  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr style={{ color: theme.color.textFaint, fontSize: 11 }}>
              <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>截断日</th>
              <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>交易日</th>
              <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>比对点</th>
              <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>该段收益</th>
              <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>池子</th>
              <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>结论</th>
            </tr>
          </thead>
          <tbody>
            {cs.cuts.map((c) => (
              <tr key={c.cut} style={{ borderTop: `1px solid ${LINE}` }}>
                <td style={{ padding: '4px 8px', fontSize: 11, color: theme.color.textFaint, fontFamily: MONO, whiteSpace: 'nowrap' }}>{c.cut}</td>
                <Td v={c.dailyBars} />
                <Td v={c.compared} />
                <Td v={fmtPct(c.totalReturn)} color={pctColor(c.totalReturn)} />
                <Td
                  v={c.universeShift ? `${c.universeSize}（← ${cs.fullUniverseSize}）` : c.universeSize}
                  color={c.universeShift ? theme.color.warn : undefined}
                />
                <td
                  style={{
                    padding: '4px 8px',
                    fontSize: 11.5,
                    whiteSpace: 'nowrap',
                    color: c.mismatch ? (c.universeShift ? theme.color.warn : theme.color.up) : theme.color.down,
                  }}
                >
                  {!c.mismatch ? '✓ 逐点一致' : c.universeShift ? `⚠ ${c.mismatch.date} 不一致（池子也变了）` : `✗ ${c.mismatch.date} 起不一致`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 6, fontSize: 11.5, color: theme.color.textFaint, lineHeight: 1.7 }}>
        判据：把归档**物理截断**到截断日再跑一遍，其历史净值必须与全区间跑的**同一段逐点相同**——
        不同则说明 t 之前的结论被 t 之后的数据改变了。
        <span style={{ color: theme.color.warn }}>只传日期窗口是不够的</span>
        （原始数据仍在内存里，读了窗口外那几行的泄露看不出来）。
        <br />
        {cs.pool.stableFrom && (
          <>
            核心池按**全期**行数选定 ⇒ <span style={{ fontFamily: MONO, color: theme.color.textMuted }}>{cs.pool.stableFrom}</span> 之前
            as-of 池子只是全集池的子集（事后选池带来的轻微 as-of 偏差）；故默认截断点一律取在该日之后，
            池子同时变化的截断点只报「无法归因」而不报泄露。池子 {cs.pool.stocks} 只。
            <br />
          </>
        )}
        {cs.note}
        <br />
        <span style={{ color: theme.color.warn }}>
          ⚠️ 本项只能检出「数据截断型」泄露（全样本统计量、按全期最优参数、未来值填充等）。
          日内信息泄露（用当日收盘决定并当日成交）需要 tick 与时间戳数据，日线归档**物理上检不出**，
        </span>
        该风险改由引擎源码契约锁住：排名取 T-1 收盘、执行取 T 日开盘。
      </div>
      {cs.skipped.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 11.5, color: theme.color.warn, lineHeight: 1.7 }}>
          {cs.skipped.length} 个截断点未评估：{cs.skipped.map((s) => `${s.cut}（${s.reason}）`).join('；')}
        </div>
      )}
    </div>
  );
}

export default function ValidationPanel({
  model,
  canRun,
  spec,
  invalid = false,
  onReport,
}: {
  model: ModelSpec;
  canRun: boolean;
  spec: ValidationSpec | null;
  /** 当前草稿存在校验错误 ⇒ 禁用运行（否则要白跑 9 次回测才报「模型校验失败」） */
  invalid?: boolean;
  /**
   * 上报本次验证报告（含 null = 清空）。
   * 用途：研究包要把验证结论**带走**，而报告此前只活在本组件的局部状态里。
   */
  onReport?: (r: ValidationReport | null) => void;
}) {
  const [folds, setFolds] = useState(3);
  const [param, setParam] = useState<'topN' | 'weight'>('topN');
  const [skipPlateau, setSkipPlateau] = useState(false);
  const [skipCausality, setSkipCausality] = useState(false);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 预算：1 基准 + folds 折 + 5 参数点 + (1 基准 + 3 截断) 因果性。取整合并后会略少。
  const estBacktests = 1 + folds + (skipPlateau ? 0 : 5) + (skipCausality ? 0 : 4);

  const runNow = async () => {
    setBusy(true);
    setErr(null);
    try {
      const skip: string[] = [];
      if (skipPlateau) skip.push('plateau');
      if (skipCausality) skip.push('causality');
      const opts: ValidateSuiteOptions = { folds, param, topN: 5, skip };
      const r = await modelsApi.validateSuite(model, opts);
      setReport(r);
      onReport?.(r);
      if (!r.ok && r.error) setErr(`${r.error.stage}：${r.error.message}`);
    } catch (e) {
      setErr((e as Error).message);
      setReport(null);
      onReport?.(null);
    } finally {
      setBusy(false);
    }
  };

  // ── 公网：显式拒绝，不摆一个点了没反应的按钮 ──
  if (!canRun) {
    return (
      <div>
        <Card title="独立验证套件" hint="样本外滚动 · 参数平原 · 因果性 · 样本量与功效披露">
          <div style={{ fontSize: 12.5, color: theme.color.textMuted, lineHeight: 1.75 }}>
            验证需要**多次重跑回测**（默认约 13 次）并且要为每个截断点**物理截断归档**（约 90MB/次），
            依赖本地数据归档，公网演示版不提供执行。
            <br />
            请在本地版本中运行，或用「导出模型 JSON → 本地导入」的方式执行。
          </div>
        </Card>
        {spec && (
          <Card title="本套件的已知局限" hint="无论在哪运行，这些局限都成立">
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: theme.color.textFaint, lineHeight: 1.8 }}>
              {spec.limitations.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    );
  }

  const wf = report?.checks.walkForward;
  const pl = report?.checks.plateau;
  const cs = report?.checks.causality;
  const pass = report?.verdict.pass;

  return (
    <div>
      {/* ── 控制条 ── */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: theme.color.textFaint }}>样本外折数</span>
        <select value={folds} onChange={(e) => setFolds(Number(e.target.value))} style={{ ...theme.input, padding: '5px 8px', fontSize: 12 }}>
          {[2, 3, 4, 5, 6, 8].map((n) => (
            <option key={n} value={n}>{n} 折</option>
          ))}
        </select>
        <span style={{ fontSize: 12, color: theme.color.textFaint }}>扫描参数</span>
        <select value={param} onChange={(e) => setParam(e.target.value as 'topN' | 'weight')} style={{ ...theme.input, padding: '5px 8px', fontSize: 12 }}>
          <option value="topN">持仓数 topN</option>
          <option value="weight">首因子权重</option>
        </select>
        <label style={{ fontSize: 12, color: theme.color.textMuted, display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
          <input type="checkbox" checked={skipPlateau} onChange={(e) => setSkipPlateau(e.target.checked)} />
          跳过参数平原
        </label>
        <label style={{ fontSize: 12, color: theme.color.textMuted, display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
          <input type="checkbox" checked={skipCausality} onChange={(e) => setSkipCausality(e.target.checked)} />
          跳过因果性
        </label>
        <button type="button" style={btn(true, busy || invalid)} disabled={busy || invalid} onClick={() => void runNow()}>
          {busy ? '验证中…' : `运行验证（约 ${estBacktests} 次回测）`}
        </button>
        {invalid && <span style={{ fontSize: 11.5, color: theme.color.warn }}>模型还有校验错误，先修好再验证</span>}
      </div>

      <div style={{ fontSize: 11.5, color: theme.color.textFaint, lineHeight: 1.7, marginBottom: 10 }}>
        验证套件**只读**你的模型：不回写、不落库、不留实验痕 —— 独立性是它能被称为"验证"的前提。
        每折都是**独立重跑**（不共享仓位与费用），与"整段跑一次再看分段收益"不是一回事。
      </div>

      {busy && (
        <div style={{ fontSize: 12, color: theme.color.textMuted, marginBottom: 10 }}>
          正在执行约 {estBacktests} 次回测
          {skipCausality ? '' : '，并对每一截断点物理截断归档（约 90MB，本机每次约 10 秒）'}
          ，整体约需 {skipCausality ? '十多秒' : '30–60 秒'}…
        </div>
      )}
      {err && (
        <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, border: `1px solid rgba(239,68,68,.35)`, background: 'rgba(239,68,68,.08)', color: theme.color.up, fontSize: 12, lineHeight: 1.7 }}>
          {err}
        </div>
      )}

      {!report && !busy && (
        <Card title="尚未运行" hint="先有结论，再谈可信度">
          <div style={{ fontSize: 12.5, color: theme.color.textMuted, lineHeight: 1.75 }}>
            回测回答"过去发生了什么"，验证回答"这个结论有多可信"。
            建议在把模型存进模型库或据此下单之前先跑一次 —— 它专门用来找下面这几类问题：
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: theme.color.textFaint }}>
              <li>整段收益很好，但拆成几折后有一折方向相反（可能是某一段行情的偶然）</li>
              <li>参数只在某个恰好调到的取值上有效，邻域一动就崩（过拟合的典型形状）</li>
              <li>IC 期数太少，显著性结论其实功效不足（小样本假信心）</li>
              <li>用了未来才知道的信息（未来函数）—— 用 t 之前的数据得到的结论被 t 之后的数据改变</li>
            </ul>
          </div>
        </Card>
      )}

      {report && (
        <>
          {/* ── 结论横幅 ── */}
          <div
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10, padding: '10px 12px', borderRadius: RADIUS,
              border: `1px solid ${pass ? 'rgba(34,197,94,.35)' : 'rgba(245,158,11,.4)'}`,
              background: pass ? 'rgba(34,197,94,.07)' : 'rgba(245,158,11,.08)',
            }}
          >
            <span style={{ fontSize: 15, lineHeight: 1.2, color: pass ? theme.color.down : theme.color.warn }}>{pass ? '✓' : '⚠'}</span>
            <div style={{ flex: '1 1 auto' }}>
              <div style={{ fontSize: 13, color: theme.color.text, marginBottom: 3 }}>
                {pass ? '未触发本套件覆盖的不稳定信号' : `发现 ${report.verdict.flags.length} 项需要解释的信号`}
              </div>
              {/* 🔴 这句话不能删：pass=true 极易被读成"模型有效" */}
              <div style={{ fontSize: 11.5, color: theme.color.textFaint, lineHeight: 1.7 }}>
                {pass
                  ? '这只说明"没发现这几类问题"，不等于模型有效、更不构成对未来收益的保证。有效性仍需看 IC 显著性、经济逻辑与样本外实盘。'
                  : '下列信号不是"模型错了"，而是"需要你先解释清楚再采信"。'}
              </div>
              {report.error && (
                <div style={{ marginTop: 6, fontSize: 11.5, color: theme.color.textMuted, lineHeight: 1.75 }}>
                  <span style={{ fontFamily: MONO }}>{report.error.stage}</span>：{report.error.message}
                  {(report.error.issues || []).slice(0, 5).map((e, i) => (
                    <div key={i} style={{ color: theme.color.textFaint }}>· {e.path} {e.message}</div>
                  ))}
                </div>
              )}
              {report.verdict.flags.length > 0 && (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 11.5, color: theme.color.textMuted, lineHeight: 1.75 }}>
                  {report.verdict.flags.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* ── 样本与功效 ── */}
          {report.sample && report.power && (
            <Card title="样本量与功效" hint="结论的底气来自样本，不来自措辞">
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, marginBottom: 6 }}>
                <span style={{ color: theme.color.textFaint }}>
                  区间 <span style={{ fontFamily: MONO, color: theme.color.textMuted }}>{report.sample.range.start}~{report.sample.range.end}</span>
                </span>
                <span style={{ color: theme.color.textFaint }}>
                  K 线 <span style={{ fontFamily: MONO, color: theme.color.textMuted }}>{report.sample.bars}</span>
                </span>
                <span style={{ color: theme.color.textFaint }}>
                  调仓 <span style={{ fontFamily: MONO, color: theme.color.textMuted }}>{report.sample.rebalances}</span> 次
                </span>
                <span style={{ color: theme.color.textFaint }}>
                  截面 <span style={{ fontFamily: MONO, color: theme.color.textMuted }}>{report.sample.universeSize}</span> 只（基准 {report.sample.benchmarkUniverse}）
                </span>
              </div>
              <div style={{ fontSize: 12, color: report.power.sufficient ? theme.color.textMuted : theme.color.warn, lineHeight: 1.7 }}>
                {report.power.note}
              </div>
            </Card>
          )}

          {/* ── 样本外滚动 ── */}
          {wf && (
            <Card title="样本外滚动（Walk-forward）" hint={wf.ok ? `判据 ${(wf.verdict === 'stable' ? '折间未出现与整段相反的方向' : '发现方向相反或离散度过大')}` : '未能完成'}>
              {wf.ok ? (
                <WalkForwardTable wf={wf} />
              ) : (
                <div style={{ fontSize: 12, color: theme.color.warn, lineHeight: 1.7 }}>
                  {wf.error}
                  {(wf.issues || []).map((e, i) => (
                    <div key={i} style={{ color: theme.color.textFaint }}>· {e.message}</div>
                  ))}
                </div>
              )}
            </Card>
          )}

          {/* ── 参数平原 ── */}
          {pl && (
            <Card
              title="参数邻域（±30% 网格）"
              hint={pl.ok ? (pl.verdict === 'plateau' ? '邻域内未见尖峰' : '发现尖峰/邻域不稳健') : '未能完成'}
            >
              {pl.ok ? (
                <PlateauBars pl={pl} />
              ) : (
                <div style={{ fontSize: 12, color: theme.color.warn, lineHeight: 1.7 }}>{pl.error}</div>
              )}
            </Card>
          )}

          {/* ── 因果性 / 未来函数 ── */}
          {cs && (
            <Card
              title="因果性（前缀一致性）"
              hint={
                cs.ok
                  ? cs.verdict === 'causal'
                    ? '历史结论不随未来数据变化'
                    : cs.verdict === 'inconclusive'
                      ? '历史段不同，但股票池也变了 —— 无法归因'
                      : '发现历史结论被未来数据改变'
                  : '未能完成'
              }
            >
              {cs.ok ? (
                <CausalityTable cs={cs} />
              ) : (
                <div style={{ fontSize: 12, color: theme.color.warn, lineHeight: 1.7 }}>
                  {cs.error}
                  {(cs.issues || []).map((e, i) => (
                    <div key={i} style={{ color: theme.color.textFaint }}>· {e.message}</div>
                  ))}
                </div>
              )}
            </Card>
          )}

          {report.checks.walkForward === undefined && report.checks.plateau === undefined && report.checks.causality === undefined && (
            <div style={{ fontSize: 11.5, color: theme.color.warn, marginBottom: 10 }}>
              三项检查均未执行（或未返回）——本次除样本与功效外无其他结论。
            </div>
          )}

          {/* ── 已知局限（常驻，不折叠）── */}
          <Card title="已知局限" hint="任何结论都必须在这些前提下解读">
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11.5, color: theme.color.textFaint, lineHeight: 1.8 }}>
              {(report.limitations.length ? report.limitations : spec?.limitations || []).map((s, i) => (
                <li key={i}>{s}</li>
              ))}
              <li>本套件**不覆盖**：<strong>日内</strong>信息泄露（用当日收盘决定并当日成交——需 tick 与时间戳，日线归档不可检）、因子有效性的统计显著性（见上方功效）、真实冲击成本</li>
            </ul>
          </Card>

          {/* ── 回执 ── */}
          <div style={{ fontSize: 11, color: theme.color.textFaint, fontFamily: MONO, lineHeight: 1.8, wordBreak: 'break-all' }}>
            引擎 {report.engineVersion} · 实跑 {report.cost.backtests} 次回测 · 生成于 {String(report.generatedAt).replace('T', ' ').slice(0, 19)}
            <br />
            fingerprint {report.fingerprint || '—'}
          </div>
        </>
      )}
    </div>
  );
}
