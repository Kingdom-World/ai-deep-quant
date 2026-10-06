// ─────────────────────────────────────────────────────────────
// 数据质量页（Phase 2 · 数据治理）
//
//   回答一个长期欠缺的问题：「**这次结论是拿哪一版数据算的**」。
//
//   🔴 与「模型实验指纹」的区别（本页存在的理由）：
//     fingerprint = 引擎版本 + 数据**窗口**(start/end) + 池子规模 + 运行参数 —— **不含数据内容**。
//     归档每日同步、可追加可修正 ⇒ 窗口不变而底下数据已换的情形真实存在。
//     本页给出的 dataVersion（内容摘要）才是复现凭据的第三件。
//
//   纪律：已知问题清单（幸存者偏差 / as-of 池子 / 复权退化 / 日线不可检日内泄露 / ST 未识别）
//        常驻显示，且来自服务端单一源 —— 本页不另抄一份，不再各自表述。
// ─────────────────────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useState } from 'react';
import { theme } from '../lib/theme';
import { dataApi, type ArchiveSymbolRow, type DataQualityReport, type SingleSourceReport } from '../api/data';

const MONO = 'var(--zone-mono, Consolas, monospace)';
const SURFACE = 'var(--zone-surface, #0e1218)';
const SURFACE2 = 'var(--zone-surface-2, #131822)';
const LINE = 'var(--zone-line, #222a36)';
const RADIUS = 'var(--zone-radius, 10px)';

const fmtInt = (v: number | null | undefined) =>
  typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('zh-CN') : '—';

function Card({
  title,
  hint,
  right,
  children,
  accent,
}: {
  title: string;
  hint?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  accent?: string;
}) {
  return (
    <div style={{ background: SURFACE, border: `1px solid ${LINE}`, borderRadius: RADIUS, padding: 14, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13.5, color: accent || theme.color.text }}>{title}</strong>
        {hint && <span style={{ fontSize: 11.5, color: theme.color.textFaint, flex: 1, minWidth: 160 }}>{hint}</span>}
        {right}
      </div>
      {children}
    </div>
  );
}

/** 指标块（数字 + 标签） */
function Stat({ label, value, unit, tone }: { label: string; value: React.ReactNode; unit?: string; tone?: string }) {
  return (
    <div style={{ background: SURFACE2, border: `1px solid ${LINE}`, borderRadius: 8, padding: '8px 10px', minWidth: 0 }}>
      <div style={{ fontSize: 11, color: theme.color.textFaint, marginBottom: 3, whiteSpace: 'nowrap' }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 15, color: tone || theme.color.text, whiteSpace: 'nowrap' }}>
        {value}
        {unit && <span style={{ fontSize: 11, color: theme.color.textFaint, marginLeft: 3 }}>{unit}</span>}
      </div>
    </div>
  );
}

const GRID = (min: number): React.CSSProperties => ({
  display: 'grid',
  gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`,
  gap: 8,
});

/** 缺字段摘要：`pctChg×3, turn×1`（最多两项，超出省略） */
function missingBrief(m: Record<string, number>): string {
  const entries = Object.entries(m || {});
  if (!entries.length) return '—';
  const head = entries
    .slice(0, 2)
    .map(([k, v]) => `${k}×${v}`)
    .join(' ');
  return entries.length > 2 ? `${head} +${entries.length - 2}` : head;
}

export default function DataQualityPage() {
  const [report, setReport] = useState<DataQualityReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sources, setSources] = useState<SingleSourceReport | null>(null);
  const [sourcesErr, setSourcesErr] = useState<string | null>(null);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [kw, setKw] = useState('');
  const [onlyPool, setOnlyPool] = useState(false);
  const [onlyIssue, setOnlyIssue] = useState(false);
  const [sortKey, setSortKey] = useState<'code' | 'rowsUsable' | 'lastDate'>('code');
  const [sortDesc, setSortDesc] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setErr(null);
    try {
      const r = await dataApi.quality(refresh);
      setReport(r);
      if (!r.ok && !r.error && !r.reason) setErr('服务端未给出原因（不应发生）');
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  const loadSources = useCallback(async (refresh = false) => {
    setSourcesLoading(true);
    setSourcesErr(null);
    try {
      setSources(await dataApi.sources(refresh));
    } catch (e: unknown) {
      setSourcesErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSourcesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSources(false);
  }, [loadSources]);

  const quality = report?.quality;
  const version = report?.version;
  const symbols = useMemo(() => report?.symbols || [], [report]);

  /** 有"问题"的标的：被剔除行 / 缺字段 / 复权退化 / 异常价格 / 重复日期 / 未入池 */
  const hasIssue = useCallback(
    (s: ArchiveSymbolRow) =>
      s.rowsDropped > 0 ||
      Object.keys(s.missing || {}).length > 0 ||
      s.adjFallbackRows > 0 ||
      s.badPriceRows > 0 ||
      s.duplicateDates > 0 ||
      !s.inPool,
    [],
  );

  const rows = useMemo(() => {
    const k = kw.trim().toLowerCase();
    let list = symbols.filter((s) => (k ? s.code.toLowerCase().includes(k) : true));
    if (onlyPool) list = list.filter((s) => s.inPool);
    if (onlyIssue) list = list.filter(hasIssue);
    const dir = sortDesc ? -1 : 1;
    return [...list].sort((a, b) => {
      if (sortKey === 'code') return a.code < b.code ? -dir : a.code > b.code ? dir : 0;
      const av = sortKey === 'rowsUsable' ? a.rowsUsable : String(a.lastDate || '');
      const bv = sortKey === 'rowsUsable' ? b.rowsUsable : String(b.lastDate || '');
      return av < bv ? -dir : av > bv ? dir : 0;
    });
  }, [symbols, kw, onlyPool, onlyIssue, sortKey, sortDesc, hasIssue]);

  const th = (label: string, key?: 'code' | 'rowsUsable' | 'lastDate', align: 'left' | 'right' = 'right') => (
    <th
      onClick={
        key
          ? () => {
              if (sortKey === key) setSortDesc((d) => !d);
              else {
                setSortKey(key);
                setSortDesc(key !== 'code');
              }
            }
          : undefined
      }
      style={{
        textAlign: align,
        padding: '5px 8px',
        fontWeight: 500,
        fontSize: 11,
        color: key && sortKey === key ? theme.color.accent : theme.color.textFaint,
        cursor: key ? 'pointer' : 'default',
        whiteSpace: 'nowrap',
        userSelect: 'none',
      }}
    >
      {label}
      {key && sortKey === key ? (sortDesc ? ' ▾' : ' ▴') : ''}
    </th>
  );

  const btn = (primary = false, disabled = false): React.CSSProperties => ({
    ...theme.input,
    cursor: disabled ? 'not-allowed' : 'pointer',
    color: primary ? '#fff' : theme.color.textMuted,
    background: primary ? theme.color.primaryDeep : SURFACE2,
    borderColor: primary ? theme.color.primary : LINE,
    opacity: disabled ? 0.45 : 1,
    whiteSpace: 'nowrap',
    fontSize: 12,
  });

  const copyDigest = async () => {
    if (!version?.digest) return;
    try {
      await navigator.clipboard.writeText(version.digest);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const unavailable = report && !report.ok;

  return (
    <div style={{ minHeight: '100vh', color: theme.color.text }}>
      <div style={theme.pageWrap}>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 22, fontWeight: 900, color: '#f1f5f9' }}>数据质量</div>
          <div style={{ fontSize: 12, color: theme.color.textFaint, marginTop: 4 }}>
            归档版本索引 · 内容指纹 · 体检与已知问题 —— 「这次结论是拿哪一版数据算的」的唯一入口。
          </div>
        </div>

        {/* ── 环境不可用（公网等）：显式说明，不假装"数据为空" ── */}
        {unavailable && (
          <Card title="本环境不提供数据质量检查" accent={theme.color.warn}>
            <div style={{ fontSize: 12.5, color: theme.color.textMuted, lineHeight: 1.8 }}>
              {report?.reason || report?.error || '（服务端未给出原因）'}
            </div>
            {report?.env === 'serverless' && (
              <div style={{ fontSize: 11.5, color: theme.color.textFaint, marginTop: 6 }}>
                提示：公网可正常**配置、校验、保存与导出**模型；数据版本与体检在本地版本查看。
              </div>
            )}
          </Card>
        )}

        {/* ── 错误 ── */}
        {err && (
          <Card title="检查失败" accent={theme.color.warn}>
            <div style={{ fontSize: 12.5, color: theme.color.textMuted }}>{err}</div>
          </Card>
        )}

        {/* ── ① 数据版本 ── */}
        {report?.ok && version && (
          <Card
            title="数据版本（dataVersion）"
            hint="归档内容摘要 —— 与模型实验 fingerprint 合起来才是完整复现凭据"
            right={
              <div style={{ display: 'flex', gap: 6 }}>
                <button style={btn(false, loading)} disabled={loading} onClick={() => load(false)}>
                  {loading ? '读取中…' : '刷新'}
                </button>
                <button style={btn(true, loading)} disabled={loading} onClick={() => load(true)}>
                  重新体检
                </button>
              </div>
            }
          >
            <div
              onClick={copyDigest}
              title="点击复制完整指纹"
              style={{
                fontFamily: MONO,
                fontSize: 12.5,
                color: theme.color.accent,
                background: SURFACE2,
                border: `1px solid ${LINE}`,
                borderRadius: 8,
                padding: '8px 10px',
                wordBreak: 'break-all',
                cursor: 'pointer',
                lineHeight: 1.7,
              }}
            >
              {version.digest}
              <span style={{ marginLeft: 8, fontSize: 11, color: copied ? theme.color.down : theme.color.textFaint }}>
                {copied ? '已复制' : '点击复制'}
              </span>
            </div>

            <div style={{ ...GRID(130), marginTop: 10 }}>
              <Stat label="标的数" value={fmtInt(version.stocks)} />
              <Stat label="入池标的" value={fmtInt(version.poolStocks)} unit={`≥${version.poolMinRows}行`} />
              <Stat label="可用行数" value={fmtInt(version.rows)} />
              <Stat label="数据区间" value={`${version.firstDate || '—'} ~ ${version.lastDate || '—'}`} />
              {quality && (
                <Stat
                  label="最后交易日龄期"
                  value={quality.lastDateAgeDays == null ? '—' : `${quality.lastDateAgeDays}`}
                  unit="天"
                  tone={
                    quality.lastDateAgeDays != null && quality.lastDateAgeDays > 7 ? theme.color.warn : undefined
                  }
                />
              )}
            </div>

            <div style={{ fontSize: 11.5, color: theme.color.textFaint, marginTop: 10, lineHeight: 1.75 }}>
              为什么需要它：模型实验的 <span style={{ fontFamily: MONO }}>fingerprint</span> 由「引擎版本 + 数据
              <b>窗口</b>(起止) + 池子规模 + 运行参数」构成，<b>不含数据内容</b>。归档每日同步、可追加可修正 ⇒
              窗口不变而底下数据已换的情形真实存在。完整复现凭据 ={' '}
              <span style={{ fontFamily: MONO, color: theme.color.textMuted }}>
                engineVersion + fingerprint + dataVersion
              </span>{' '}
              三者同时一致。
              {report.cached ? '（本次结果来自服务端缓存）' : '（本次已重新计算）'}
              {report.computedAt ? ` 计算于 ${String(report.computedAt).slice(0, 19).replace('T', ' ')}` : ''}
            </div>
            {report.algorithm && (
              <details style={{ marginTop: 6 }}>
                <summary style={{ fontSize: 11.5, color: theme.color.textFaint, cursor: 'pointer' }}>指纹算法自述</summary>
                <div style={{ fontFamily: MONO, fontSize: 11, color: theme.color.textFaint, marginTop: 4, lineHeight: 1.7 }}>
                  {report.algorithm}
                </div>
              </details>
            )}
          </Card>
        )}

        {/* ── ② 体检 ── */}
        {report?.ok && quality && (
          <Card title="归档体检" hint="与引擎同源的可用性过滤口径；所有计数均为实测，不做推断">
            <div style={GRID(120)}>
              <Stat label="读取文件" value={fmtInt(quality.filesRead)} />
              <Stat
                label="坏文件"
                value={fmtInt(quality.filesBad)}
                tone={quality.filesBad > 0 ? theme.color.up : undefined}
              />
              <Stat label="总行数" value={fmtInt(quality.rowsTotal)} />
              <Stat label="可用行数" value={fmtInt(quality.rowsUsable)} />
              <Stat
                label="被剔除行"
                value={fmtInt(quality.rowsDropped)}
                tone={quality.rowsDropped > 0 ? theme.color.warn : undefined}
              />
              <Stat
                label="复权退化行"
                value={fmtInt(quality.adjFallbackRows)}
                unit={`${quality.symbolsWithAdjFallback}只`}
                tone={quality.adjFallbackRows > 0 ? theme.color.warn : undefined}
              />
              <Stat
                label="异常价格行"
                value={fmtInt(quality.badPriceRows)}
                tone={quality.badPriceRows > 0 ? theme.color.up : undefined}
              />
              <Stat
                label="重复日期行"
                value={fmtInt(quality.duplicateDates)}
                tone={quality.duplicateDates > 0 ? theme.color.up : undefined}
              />
              <Stat
                label="低于入池门槛"
                value={fmtInt(quality.belowPoolMinRows)}
                unit={`<${version?.poolMinRows ?? '—'}行`}
              />
            </div>

            {/* 覆盖率分桶 */}
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11.5, color: theme.color.textFaint, marginBottom: 6 }}>可用行数分布</div>
              {(() => {
                const buckets = quality.coverageBuckets || {};
                const total = Object.values(buckets).reduce((a, b) => a + b, 0) || 1;
                const order = ['<80', '80-249', '250-999', '1000-1999', '>=2000'];
                return (
                  <div>
                    {order.map((k) => {
                      const n = buckets[k] || 0;
                      const w = Math.round((n / total) * 100);
                      return (
                        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <span style={{ fontFamily: MONO, fontSize: 11, color: theme.color.textFaint, width: 76 }}>
                            {k}
                          </span>
                          <div style={{ flex: 1, height: 10, background: SURFACE2, borderRadius: 5, overflow: 'hidden' }}>
                            <div
                              style={{
                                width: `${w}%`,
                                height: '100%',
                                background: k === '<80' ? theme.color.warn : theme.color.primary,
                                opacity: 0.85,
                              }}
                            />
                          </div>
                          <span style={{ fontFamily: MONO, fontSize: 11, color: theme.color.textMuted, width: 52, textAlign: 'right' }}>
                            {n} 只
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            {/* 缺字段汇总 */}
            {Object.keys(quality.missingTotals || {}).length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 11.5, color: theme.color.textFaint, marginBottom: 6 }}>
                  字段缺失（总行数 / 受影响标的数）
                </div>
                <div style={GRID(150)}>
                  {Object.entries(quality.missingTotals)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => (
                      <Stat
                        key={k}
                        label={k}
                        value={fmtInt(v)}
                        unit={`${quality.symbolsWithMissing?.[k] ?? 0}只`}
                        tone={theme.color.warn}
                      />
                    ))}
                </div>
              </div>
            )}

            {/* 坏文件明细 */}
            {(quality.badFiles || []).length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 11.5, color: theme.color.up, marginBottom: 6 }}>坏文件（不计入标的数，但不隐藏）</div>
                {(quality.badFiles || []).map((b) => (
                  <div key={b.file} style={{ fontFamily: MONO, fontSize: 11, color: theme.color.textMuted, lineHeight: 1.8 }}>
                    {b.file} —— {b.error}
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}

        {/* ── ③ 已知问题（单一源：服务端 DATA_ISSUES）── */}
        {(report?.issues || []).length > 0 && (
          <Card title="数据层面的已知问题" hint="随索引返回（服务端单一源），界面不另抄一份" accent={theme.color.warn}>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: theme.color.textMuted, lineHeight: 1.9 }}>
              {(report?.issues || []).map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
            <div style={{ fontSize: 11.5, color: theme.color.textFaint, marginTop: 6 }}>
              注：这些是**数据**本身的适用边界；**结论**的适用边界（验证覆盖到哪、功效是否充足）在模型工坊的验证轨与研究报告里。
            </div>
          </Card>
        )}

        {/* ── ④ 口径单一源清单（治理门）── */}
        {(sources || sourcesErr) && (
          <Card
            title="口径单一源清单"
            hint="不是文档而是可执行的门：条目过期或被抄第二份 ⇒ 校验失败"
            accent={sources && !sources.ok ? theme.color.warn : undefined}
            right={
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {sources && (
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 12,
                      color: sources.ok ? theme.color.down : theme.color.warn,
                    }}
                  >
                    {sources.passed}/{sources.total} 通过
                  </span>
                )}
                <button style={btn(false, sourcesLoading)} disabled={sourcesLoading} onClick={() => loadSources(true)}>
                  {sourcesLoading ? '校验中…' : '重新校验'}
                </button>
              </div>
            }
          >
            {sourcesErr && <div style={{ fontSize: 12.5, color: theme.color.textMuted }}>校验失败：{sourcesErr}</div>}
            {sources && (
              <>
                <div style={{ fontSize: 11.5, color: theme.color.textFaint, marginBottom: 8, lineHeight: 1.7 }}>
                  扫描 {fmtInt(sources.scannedFiles)} 个源码文件；每条口径的**唯一权威**在此登记。
                  {sources.cached ? '（本次结果来自服务端缓存）' : ''}
                  {sources.checkedAt ? ` 校验于 ${String(sources.checkedAt).slice(0, 19).replace('T', ' ')}` : ''}
                </div>
                <div style={{ borderTop: `1px solid ${LINE}` }}>
                  {sources.entries.map((e) => (
                    <div key={e.id} style={{ padding: '7px 0', borderBottom: `1px solid ${LINE}` }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <span style={{ color: e.ok ? theme.color.down : theme.color.warn, fontSize: 12, width: 14 }}>
                          {e.ok ? '✓' : '✕'}
                        </span>
                        <strong style={{ fontSize: 12.5, color: theme.color.text }}>{e.label}</strong>
                        <span style={{ fontFamily: MONO, fontSize: 11, color: theme.color.accent }}>{e.source}</span>
                      </div>
                      <div style={{ fontSize: 11.5, color: theme.color.textFaint, margin: '3px 0 0 22px', lineHeight: 1.7 }}>
                        {e.note}
                      </div>
                      {!e.ok &&
                        e.issues.map((s, i) => (
                          <div
                            key={i}
                            style={{ fontSize: 11.5, color: theme.color.up, margin: '3px 0 0 22px', lineHeight: 1.7 }}
                          >
                            {s}
                          </div>
                        ))}
                      {e.guards
                        .filter((g) => g.violations.length > 0)
                        .map((g, gi) => (
                          <div key={gi} style={{ margin: '4px 0 0 22px', fontFamily: MONO, fontSize: 11, color: theme.color.textFaint }}>
                            {g.violations.map((v, vi) => (
                              <div key={vi}>
                                {v.file}:{v.line} —— {v.text}
                              </div>
                            ))}
                          </div>
                        ))}
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 11.5, color: theme.color.textFaint, marginTop: 8, lineHeight: 1.7 }}>{sources.note}</div>
              </>
            )}
          </Card>
        )}

        {/* ── ⑤ 逐只明细 ── */}
        {report?.ok && symbols.length > 0 && (
          <Card
            title={`逐只明细（${rows.length} / ${symbols.length}）`}
            hint="点击表头可按代码/行数/末日排序"
            right={
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  style={{ ...theme.input, width: 130, fontSize: 12 }}
                  placeholder="代码筛选…"
                  value={kw}
                  onChange={(e) => setKw(e.target.value)}
                />
                <button style={btn(onlyPool)} onClick={() => setOnlyPool((v) => !v)}>
                  {onlyPool ? '仅入池 ✓' : '仅入池'}
                </button>
                <button style={btn(onlyIssue)} onClick={() => setOnlyIssue((v) => !v)}>
                  {onlyIssue ? '仅有问题 ✓' : '仅有问题'}
                </button>
              </div>
            }
          >
            <div style={{ overflowX: 'auto', maxHeight: 460, overflowY: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead style={{ position: 'sticky', top: 0, background: SURFACE, zIndex: 1 }}>
                  <tr>
                    {th('代码', 'code', 'left')}
                    {th('可用/总', 'rowsUsable')}
                    {th('区间', 'lastDate', 'left')}
                    {th('因子')}
                    {th('退化行')}
                    {th('缺字段', undefined, 'left')}
                    {th('异常')}
                    {th('入池')}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => {
                    const bad = s.rowsDropped > 0 || s.badPriceRows > 0 || s.duplicateDates > 0;
                    return (
                      <tr key={s.code} style={{ borderTop: `1px solid ${LINE}` }}>
                        <td style={{ padding: '4px 8px', fontFamily: MONO, fontSize: 11.5, color: theme.color.text }}>
                          {s.code}
                        </td>
                        <td style={{ padding: '4px 8px', fontFamily: MONO, fontSize: 11.5, textAlign: 'right', color: theme.color.textMuted }}>
                          {fmtInt(s.rowsUsable)}
                          <span style={{ color: theme.color.textFaint }}>/{fmtInt(s.rows)}</span>
                        </td>
                        <td style={{ padding: '4px 8px', fontFamily: MONO, fontSize: 11, color: theme.color.textFaint, whiteSpace: 'nowrap' }}>
                          {s.firstDate || '—'} ~ {s.lastDate || '—'}
                        </td>
                        <td style={{ padding: '4px 8px', fontFamily: MONO, fontSize: 11.5, textAlign: 'right', color: theme.color.textMuted }}>
                          {s.factorsCount}
                        </td>
                        <td
                          style={{
                            padding: '4px 8px',
                            fontFamily: MONO,
                            fontSize: 11.5,
                            textAlign: 'right',
                            color: s.adjFallbackRows > 0 ? theme.color.warn : theme.color.textFaint,
                          }}
                        >
                          {s.adjFallbackRows > 0 ? fmtInt(s.adjFallbackRows) : '—'}
                        </td>
                        <td style={{ padding: '4px 8px', fontFamily: MONO, fontSize: 11, color: theme.color.textFaint }}>
                          {missingBrief(s.missing)}
                        </td>
                        <td
                          style={{
                            padding: '4px 8px',
                            fontFamily: MONO,
                            fontSize: 11,
                            textAlign: 'right',
                            color: bad ? theme.color.up : theme.color.textFaint,
                          }}
                        >
                          {bad
                            ? [s.rowsDropped ? `剔${s.rowsDropped}` : '', s.badPriceRows ? `价${s.badPriceRows}` : '', s.duplicateDates ? `重${s.duplicateDates}` : '']
                                .filter(Boolean)
                                .join(' ')
                            : '—'}
                        </td>
                        <td style={{ padding: '4px 8px', fontSize: 11, textAlign: 'right' }}>
                          <span style={{ color: s.inPool ? theme.color.down : theme.color.textFaint }}>
                            {s.inPool ? '是' : '否'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rows.length === 0 && (
              <div style={{ fontSize: 12, color: theme.color.textFaint, padding: '10px 0' }}>（当前筛选下无标的）</div>
            )}
          </Card>
        )}

        {loading && !report && (
          <Card title="正在体检归档…" hint="首次需逐行摘要整份归档，本机约 5–8 秒">
            <div style={{ fontSize: 12, color: theme.color.textFaint }}>读取中，请稍候…</div>
          </Card>
        )}
      </div>
    </div>
  );
}
