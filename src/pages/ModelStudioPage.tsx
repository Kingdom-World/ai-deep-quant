// ─────────────────────────────────────────────────────────────
// 模型工坊（Phase 1）—— 低代码表单建模页
//
//   两轨等价（同一份 Model JSON）：本页是「低代码轨」，脚本轨=直接编辑 JSON。
//   页面纪律：
//     · 校验结论以**服务端**为权威（前端仅做即时反馈，且明确标注"未经 AST 校验"的 warning）
//     · 校验失败逐条列出 path + message（不合并成一句"格式错误"）
//     · 公网 canRun=false 时禁用「运行」，并给出原因与替代路径（导出 JSON → 本地执行）
//     · 运行结果按服务端实际字段名渲染（maxDrawdownPct / ic.icMean，勿臆造）
// ─────────────────────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts';
import {
  modelsApi,
  type ModelSchema,
  type ModelSpec,
  type ModelRunResponse,
  type ValidationIssue,
} from '../api';
import { theme } from '../lib/theme';

// ── 本地草稿类型（与 ModelSpec 对齐，但不含 schemaVersion，由提交时补）──
interface DraftFactor {
  id: string;
  expr: string;
  weight: string; // 输入框用字符串，提交前转数字（避免 0./-. 这类中间态被 parseInt 吃掉）
  direction: 1 | -1;
}
interface DraftTransform {
  type: string;
  method?: string;
  n?: string;
}
interface DraftFilter {
  field: string;
  min: string;
  max: string;
}
interface Draft {
  name: string;
  hypothesis: string;
  factors: DraftFactor[];
  transforms: DraftTransform[];
  filters: DraftFilter[];
  rebalance: string;
  groups: string;
  fees: boolean;
  author: string;
}

const emptyDraft = (): Draft => ({
  name: '',
  hypothesis: '',
  factors: [{ id: 'f1', expr: 'mom20', weight: '1', direction: 1 }],
  transforms: [],
  filters: [],
  rebalance: 'monthly',
  groups: '5',
  fees: true,
  author: '',
});

/** 草稿 → Model JSON（空串字段一律省略，避免用 '' 冒充有效值） */
function draftToModel(d: Draft): ModelSpec {
  return {
    schemaVersion: 1,
    name: d.name.trim(),
    ...(d.hypothesis.trim() ? { hypothesis: d.hypothesis.trim() } : {}),
    factors: d.factors.map((f, i) => ({
      id: f.id.trim() || `f${i + 1}`,
      expr: f.expr.trim(),
      weight: f.weight.trim() === '' ? 1 : Number(f.weight),
      direction: f.direction,
    })),
    ...(d.transforms.length
      ? {
          transforms: d.transforms.map((t) => {
            const args: Record<string, unknown> = {};
            if (t.type === 'winsorize') {
              args.method = t.method || 'mad';
              if (t.n !== undefined && t.n.trim() !== '') args.n = Number(t.n);
            }
            return Object.keys(args).length ? { type: t.type as never, args } : { type: t.type as never };
          }),
        }
      : {}),
    ...(d.filters.length
      ? {
          filters: d.filters.map((f) => {
            const out: Record<string, unknown> = { type: 'field_range', field: f.field };
            if (f.min.trim() !== '') out.min = Number(f.min);
            if (f.max.trim() !== '') out.max = Number(f.max);
            return out as never;
          }),
        }
      : {}),
    backtest: { rebalance: d.rebalance as never, groups: Number(d.groups) || 5, fees: d.fees },
    meta: { author: d.author.trim() || 'me' },
  };
}

/** Model JSON → 草稿（用于从模型库加载） */
function modelToDraft(m: ModelSpec & { meta?: { author?: string } }): Draft {
  return {
    name: m.name || '',
    hypothesis: m.hypothesis || '',
    factors: (m.factors || []).map((f, i) => ({
      id: f.id || `f${i + 1}`,
      expr: f.expr,
      weight: String(f.weight ?? 1),
      direction: (f.direction === -1 ? -1 : 1) as 1 | -1,
    })),
    transforms: (m.transforms || []).map((t) => {
      const args = (t.args || {}) as { method?: string; n?: number };
      return { type: t.type, method: args.method, n: args.n === undefined ? undefined : String(args.n) };
    }),
    filters: (m.filters || []).map((f) => {
      const ff = f as unknown as { field: string; min?: number; max?: number };
      return { field: ff.field, min: ff.min === undefined ? '' : String(ff.min), max: ff.max === undefined ? '' : String(ff.max) };
    }),
    rebalance: m.backtest?.rebalance || 'monthly',
    groups: String(m.backtest?.groups ?? 5),
    fees: m.backtest?.fees !== false,
    author: m.meta?.author || '',
  };
}

const fmtPct = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(2)}%` : '—');
const fmtNum = (v: number | null | undefined, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');

/** 涨红跌绿（国内惯例） */
const pctStyle = (v: number | null | undefined): React.CSSProperties => ({
  color: typeof v !== 'number' || !Number.isFinite(v) ? theme.color.textMuted : v >= 0 ? theme.color.up : theme.color.down,
});

export default function ModelStudioPage() {
  const [schema, setSchema] = useState<ModelSchema | null>(null);
  const [draft, setDraft] = useState<Draft>({ ...emptyDraft(), author: '' });
  const [errors, setErrors] = useState<ValidationIssue[]>([]);
  const [warnings, setWarnings] = useState<ValidationIssue[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'info' | 'ok' | 'err'; text: string } | null>(null);
  const [run, setRun] = useState<Extract<ModelRunResponse, { ok: true }> | null>(null);
  const [library, setLibrary] = useState<{ id: string; name: string; modelHash: string; updatedAt: string }[]>([]);
  const [quota, setQuota] = useState<{ count: number; quota: number }>({ count: 0, quota: 0 });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [opts, setOpts] = useState({ topN: '5', capital: '1000000', slippage: '0.001' });
  const chartRef = useRef<HTMLDivElement | null>(null);

  const model = useMemo(() => draftToModel(draft), [draft]);
  const canRun = schema ? schema.canRun : false;

  const flash = (kind: 'info' | 'ok' | 'err', text: string) => setMsg({ kind, text });

  // ── 初次加载：规范常量 + 模型库 ──
  const loadLibrary = useCallback(async () => {
    try {
      const r = await modelsApi.list();
      setLibrary(r.items || []);
      setQuota({ count: r.count ?? 0, quota: r.quota ?? 0 });
    } catch (e) {
      flash('err', `模型库读取失败：${(e as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const s = await modelsApi.schema();
        setSchema(s);
        setDraft((d) => ({ ...d, author: d.author }));
      } catch (e) {
        flash('err', `规范常量加载失败：${(e as Error).message}`);
      }
      await loadLibrary();
    })();
  }, [loadLibrary]);

  // ── 实时校验（防抖 350ms；权威结论仍在服务端）──
  useEffect(() => {
    const t = setTimeout(() => {
      void (async () => {
        try {
          const r = await modelsApi.validate(model);
          setErrors(r.errors || []);
          setWarnings(r.warnings || []);
        } catch {
          /* 校验请求失败不覆盖已有结论（避免把网络抖动显示成"模型有问题"） */
        }
      })();
    }, 350);
    return () => clearTimeout(t);
  }, [model]);

  // ── 净值曲线 ──
  useEffect(() => {
    if (!chartRef.current || !run) return;
    const chart = echarts.init(chartRef.current, undefined, { renderer: 'canvas' });
    const eq = run.result.equity || [];
    const bm = run.result.benchmark || [];
    chart.setOption({
      backgroundColor: 'transparent',
      grid: { left: 58, right: 18, top: 26, bottom: 28 },
      tooltip: { trigger: 'axis' },
      legend: { data: ['模型', '等权基准'], textStyle: { color: theme.color.textMuted, fontSize: 11 }, right: 10, top: 0 },
      xAxis: { type: 'category', data: eq.map((p) => p.date), axisLabel: { color: theme.color.textFaint, fontSize: 10 } },
      yAxis: { type: 'value', scale: true, axisLabel: { color: theme.color.textFaint, fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(148,163,184,0.12)' } } },
      series: [
        {
          name: '模型', type: 'line', showSymbol: false, data: eq.map((p) => p.value),
          lineStyle: { color: theme.color.accent, width: 2 }, itemStyle: { color: theme.color.accent },
        },
        {
          name: '等权基准', type: 'line', showSymbol: false, data: bm.map((p) => p.value),
          lineStyle: { color: theme.color.textFaint, width: 1.4, type: 'dashed' }, itemStyle: { color: theme.color.textFaint },
        },
      ],
    });
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.dispose();
    };
  }, [run]);

  // ── 操作 ──
  const doRun = async () => {
    setBusy('run');
    setMsg(null);
    try {
      const r = await modelsApi.run(model, {
        topN: Number(opts.topN) || undefined,
        capital: Number(opts.capital) || undefined,
        slippage: Number(opts.slippage),
      });
      if (!r.ok) {
        if (r.issues?.length) setErrors(r.issues);
        flash('err', `[${r.stage}] ${r.error}`);
        setRun(null);
      } else {
        setRun(r);
        flash('ok', `回测完成 · 指纹 ${r.fingerprint.slice(0, 12)}…`);
      }
    } catch (e) {
      flash('err', `运行失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const doSave = async (asNew: boolean) => {
    setBusy('save');
    setMsg(null);
    try {
      const r = await modelsApi.save(model, asNew ? undefined : editingId || undefined);
      if (!r.ok) {
        if (r.issues?.length) setErrors(r.issues);
        flash('err', r.error || '保存失败');
      } else {
        setEditingId(r.id || null);
        setDirty(false);
        flash('ok', asNew || !editingId ? '已保存为新模型' : '已更新当前模型');
        await loadLibrary();
      }
    } catch (e) {
      flash('err', `保存失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const doLoad = async (id: string) => {
    setBusy('load');
    try {
      const r = await modelsApi.get(id);
      if (!r.ok || !r.model) {
        flash('err', r.error || '读取失败');
        return;
      }
      setDraft(modelToDraft(r.model as unknown as ModelSpec));
      setEditingId(id);
      setRun(null);
      setDirty(false);
      flash('ok', `已载入「${(r.model as { name?: string }).name || id}」`);
    } catch (e) {
      flash('err', `读取失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const doDelete = async (id: string) => {
    setBusy('del');
    try {
      const r = await modelsApi.remove(id);
      if (!r.ok) flash('err', r.error || '删除失败');
      else {
        if (editingId === id) setEditingId(null);
        flash('ok', '已删除');
        await loadLibrary();
      }
    } catch (e) {
      flash('err', `删除失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const doExport = () => {
    const blob = new Blob([JSON.stringify(model, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(draft.name || 'model').replace(/[^\w\u4e00-\u9fa5-]/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    flash('ok', '已导出 Model JSON（可在本地版本导入执行）');
  };

  const doImport = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as ModelSpec;
        setDraft(modelToDraft(parsed));
        setEditingId(null);
        setRun(null);
        setDirty(true);
        flash('ok', '已导入 JSON（保存后入库）');
      } catch (e) {
        flash('err', `JSON 解析失败：${(e as Error).message}`);
      }
    };
    reader.readAsText(file);
  };

  // ── 草稿编辑辅助 ──
  const patch = (p: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setDirty(true);
  };
  const setFactor = (i: number, p: Partial<DraftFactor>) => {
    setDraft((d) => ({ ...d, factors: d.factors.map((f, k) => (k === i ? { ...f, ...p } : f)) }));
    setDirty(true);
  };

  const box: React.CSSProperties = { ...theme.card, marginBottom: 14 };
  const label: React.CSSProperties = { color: theme.color.textMuted, fontSize: 12, marginBottom: 4, display: 'block' };
  const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' };
  const btn = (primary = false): React.CSSProperties => ({
    ...theme.input,
    cursor: busy ? 'wait' : 'pointer',
    color: primary ? '#fff' : theme.color.textMuted,
    background: primary ? theme.color.primaryDeep : theme.color.bgSunken,
    borderColor: primary ? theme.color.primary : theme.color.border,
    opacity: busy ? 0.7 : 1,
  });

  return (
    <div style={{ ...theme.page, paddingBottom: 60 }}>
      <main style={{ padding: '24px 24px 0', maxWidth: 1200, margin: '0 auto' }}>
        {/* 页头 */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ color: theme.color.accent, fontSize: 11, letterSpacing: 2, fontFamily: 'Consolas, monospace', marginBottom: 7 }}>MODEL STUDIO</div>
          <h1 style={{ ...theme.sectionTitle, marginBottom: 8 }}>模型工坊</h1>
          <div style={{ color: theme.color.textMuted, fontSize: 13, lineHeight: 1.7 }}>
            声明式搭建量化模型：选因子 → 配预处理 → 定权重与方向 → 设过滤与调仓 → 回测。
            同一份 Model JSON 既可由本页生成，也可直接编辑（脚本轨），两轨等价。
            {schema && !schema.canRun && (
              <div style={{ marginTop: 8, color: theme.color.warn, fontSize: 12.5 }}>
                ⚠️ 当前环境（公网）不提供执行：可**配置、校验、保存、导出**模型 JSON；跑净值请在本地版本导入该 JSON。
              </div>
            )}
          </div>
        </div>

        {/* 基本信息 */}
        <section style={box}>
          <div style={{ ...row, alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 260px' }}>
              <span style={label}>模型名称 *</span>
              <input value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="例：20日动量+低波动" style={{ ...theme.input, width: '100%' }} />
            </div>
            <div style={{ flex: '1 1 300px' }}>
              <span style={label}>研究假设（可选）</span>
              <input value={draft.hypothesis} onChange={(e) => patch({ hypothesis: e.target.value })} placeholder="例：短期动量在低波动股上更持续" style={{ ...theme.input, width: '100%' }} />
            </div>
            <div style={{ flex: '0 0 140px' }}>
              <span style={label}>作者</span>
              <input value={draft.author} onChange={(e) => patch({ author: e.target.value })} style={{ ...theme.input, width: '100%' }} />
            </div>
          </div>
        </section>

        {/* 因子 */}
        <section style={box}>
          <div style={{ ...row, justifyContent: 'space-between', marginBottom: 10 }}>
            <strong style={{ color: theme.color.text, fontSize: 14 }}>因子（{draft.factors.length}/{schema?.limits.maxFactors ?? 8}）</strong>
            <button
              type="button"
              style={btn()}
              disabled={!!schema && draft.factors.length >= schema.limits.maxFactors}
              onClick={() => patch({ factors: [...draft.factors, { id: `f${draft.factors.length + 1}`, expr: 'mom20', weight: '1', direction: 1 }] })}
            >
              + 添加因子
            </button>
          </div>
          {draft.factors.map((f, i) => (
            <div key={i} style={{ ...row, marginBottom: 8, paddingBottom: 8, borderBottom: `1px solid ${theme.color.border}` }}>
              <input value={f.id} onChange={(e) => setFactor(i, { id: e.target.value })} placeholder="id" style={{ ...theme.input, width: 78 }} />
              <input
                value={f.expr}
                onChange={(e) => setFactor(i, { expr: e.target.value })}
                placeholder="预置因子名（mom20）或表达式（mom60 - mom20）"
                list="ms-presets"
                style={{ ...theme.input, flex: '1 1 320px', fontFamily: 'Consolas, monospace' }}
              />
              <span style={{ color: theme.color.textFaint, fontSize: 12 }}>权重</span>
              <input value={f.weight} onChange={(e) => setFactor(i, { weight: e.target.value })} style={{ ...theme.input, width: 72 }} />
              <button type="button" style={btn()} onClick={() => setFactor(i, { direction: f.direction === 1 ? -1 : 1 })}>
                {f.direction === 1 ? '正向 ↑' : '反向 ↓'}
              </button>
              <button type="button" style={btn()} disabled={draft.factors.length <= 1} onClick={() => patch({ factors: draft.factors.filter((_, k) => k !== i) })}>
                删除
              </button>
            </div>
          ))}
          <datalist id="ms-presets">
            {(schema?.presets || []).map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <div style={{ color: theme.color.textFaint, fontSize: 12, marginTop: 4 }}>
            权重为负即做空该因子暴露；方向正/负表示"因子值越大越看好/越不看好"。综合分越高越强。
          </div>
        </section>

        {/* 预处理 */}
        <section style={box}>
          <div style={{ ...row, justifyContent: 'space-between', marginBottom: 10 }}>
            <strong style={{ color: theme.color.text, fontSize: 14 }}>截面预处理（按顺序生效 · {draft.transforms.length}/{schema?.limits.maxTransforms ?? 6}）</strong>
            <div style={row}>
              {(schema?.transforms || []).map((t) => (
                <button
                  key={t.type}
                  type="button"
                  style={btn()}
                  disabled={!!schema && draft.transforms.length >= schema.limits.maxTransforms}
                  onClick={() => patch({ transforms: [...draft.transforms, { type: t.type, method: t.type === 'winsorize' ? 'mad' : undefined, n: t.type === 'winsorize' ? '3' : undefined }] })}
                >
                  + {t.type}
                </button>
              ))}
            </div>
          </div>
          {draft.transforms.length === 0 && <div style={{ color: theme.color.textFaint, fontSize: 12.5 }}>未配置（可选）。例：先 winsorize 去极值，再 zscore 标准化。</div>}
          {draft.transforms.map((t, i) => (
            <div key={i} style={{ ...row, marginBottom: 8 }}>
              <span style={{ color: theme.color.accent, fontFamily: 'Consolas, monospace', fontSize: 12.5 }}>{i + 1}. {t.type}</span>
              {t.type === 'winsorize' && (
                <>
                  <select value={t.method || 'mad'} onChange={(e) => patch({ transforms: draft.transforms.map((x, k) => (k === i ? { ...x, method: e.target.value } : x)) })} style={{ ...theme.input, width: 90 }}>
                    <option value="mad">mad</option>
                    <option value="pct">pct</option>
                  </select>
                  <input value={t.n ?? '3'} onChange={(e) => patch({ transforms: draft.transforms.map((x, k) => (k === i ? { ...x, n: e.target.value } : x)) })} style={{ ...theme.input, width: 70 }} />
                </>
              )}
              <button type="button" style={btn()} disabled={i === 0} onClick={() => { const a = [...draft.transforms]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; patch({ transforms: a }); }}>↑</button>
              <button type="button" style={btn()} onClick={() => patch({ transforms: draft.transforms.filter((_, k) => k !== i) })}>删除</button>
            </div>
          ))}
        </section>

        {/* 过滤器 */}
        <section style={box}>
          <div style={{ ...row, justifyContent: 'space-between', marginBottom: 10 }}>
            <strong style={{ color: theme.color.text, fontSize: 14 }}>过滤器（{draft.filters.length}/{schema?.limits.maxFilters ?? 5}）</strong>
            <button
              type="button"
              style={btn()}
              disabled={!!schema && draft.filters.length >= schema.limits.maxFilters}
              onClick={() => patch({ filters: [...draft.filters, { field: schema?.filterFields[0] || 'amount', min: '', max: '' }] })}
            >
              + 添加过滤器
            </button>
          </div>
          {draft.filters.length === 0 && <div style={{ color: theme.color.textFaint, fontSize: 12.5 }}>未配置（可选）。按 T-1 日归档字段筛选候选股；**字段缺失视为不满足**。</div>}
          {draft.filters.map((f, i) => (
            <div key={i} style={{ ...row, marginBottom: 8 }}>
              <select value={f.field} onChange={(e) => patch({ filters: draft.filters.map((x, k) => (k === i ? { ...x, field: e.target.value } : x)) })} style={{ ...theme.input, width: 120 }}>
                {(schema?.filterFields || []).map((x) => (
                  <option key={x} value={x}>{x}</option>
                ))}
              </select>
              <span style={{ color: theme.color.textFaint, fontSize: 12 }}>≥</span>
              <input value={f.min} onChange={(e) => patch({ filters: draft.filters.map((x, k) => (k === i ? { ...x, min: e.target.value } : x)) })} placeholder="最小" style={{ ...theme.input, width: 110 }} />
              <span style={{ color: theme.color.textFaint, fontSize: 12 }}>≤</span>
              <input value={f.max} onChange={(e) => patch({ filters: draft.filters.map((x, k) => (k === i ? { ...x, max: e.target.value } : x)) })} placeholder="最大" style={{ ...theme.input, width: 110 }} />
              <button type="button" style={btn()} onClick={() => patch({ filters: draft.filters.filter((_, k) => k !== i) })}>删除</button>
            </div>
          ))}
        </section>

        {/* 回测设置 */}
        <section style={box}>
          <strong style={{ color: theme.color.text, fontSize: 14 }}>回测设置</strong>
          <div style={{ ...row, marginTop: 10 }}>
            <div>
              <span style={label}>调仓周期</span>
              <select value={draft.rebalance} onChange={(e) => patch({ rebalance: e.target.value })} style={{ ...theme.input, width: 110 }}>
                {Object.keys(schema?.rebalance || { daily: 1, weekly: 5, monthly: 20 }).map((k) => (
                  <option key={k} value={k}>{k}（{schema?.rebalance?.[k] ?? ''} 根）</option>
                ))}
              </select>
            </div>
            <div>
              <span style={label}>分组数</span>
              <input value={draft.groups} onChange={(e) => patch({ groups: e.target.value })} style={{ ...theme.input, width: 80 }} />
            </div>
            <div>
              <span style={label}>持仓数 topN</span>
              <input value={opts.topN} onChange={(e) => setOpts({ ...opts, topN: e.target.value })} style={{ ...theme.input, width: 80 }} />
            </div>
            <div>
              <span style={label}>初始资金</span>
              <input value={opts.capital} onChange={(e) => setOpts({ ...opts, capital: e.target.value })} style={{ ...theme.input, width: 110 }} />
            </div>
            <div>
              <span style={label}>滑点</span>
              <input value={opts.slippage} onChange={(e) => setOpts({ ...opts, slippage: e.target.value })} style={{ ...theme.input, width: 80 }} />
            </div>
            <label style={{ ...row, marginTop: 18, color: theme.color.textMuted, fontSize: 12.5 }}>
              <input type="checkbox" checked={draft.fees} onChange={(e) => patch({ fees: e.target.checked })} />
              计入手续费（单一源 paper/fees.cjs）
            </label>
          </div>
        </section>

        {/* 操作条 */}
        <section style={{ ...box }}>
          <div style={row}>
            <button type="button" style={btn(true)} onClick={() => void doRun()} disabled={busy !== null || errors.length > 0 || !canRun} title={!canRun ? '当前环境不支持执行' : errors.length ? '请先修正校验问题' : ''}>
              {busy === 'run' ? '运行中…' : '运行回测'}
            </button>
            <button type="button" style={btn()} onClick={() => void doSave(false)} disabled={busy !== null || errors.length > 0}>
              {busy === 'save' ? '保存中…' : editingId ? '更新当前模型' : '保存到模型库'}
            </button>
            <button type="button" style={btn()} onClick={() => void doSave(true)} disabled={busy !== null || errors.length > 0}>另存为新模型</button>
            <button type="button" style={btn()} onClick={doExport}>导出 JSON</button>
            <label style={{ ...btn(), display: 'inline-block' }}>
              导入 JSON
              <input type="file" accept="application/json" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) doImport(f); e.target.value = ''; }} />
            </label>
            <span style={{ color: theme.color.textFaint, fontSize: 12 }}>
              {editingId ? `编辑中：${editingId}` : '未入库'}{dirty ? ' · 有未保存改动' : ''}
            </span>
          </div>

          {msg && (
            <div style={{ marginTop: 10, fontSize: 12.5, color: msg.kind === 'err' ? theme.color.up : msg.kind === 'ok' ? theme.color.down : theme.color.textMuted }}>
              {msg.text}
            </div>
          )}

          {errors.length > 0 && (
            <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)' }}>
              <div style={{ color: theme.color.up, fontSize: 12.5, marginBottom: 6 }}>校验未通过（{errors.length} 项）：</div>
              <ul style={{ margin: 0, paddingLeft: 18, color: theme.color.textMuted, fontSize: 12.5, lineHeight: 1.7 }}>
                {errors.map((e, i) => (
                  <li key={i}><code style={{ color: theme.color.accent }}>{e.path || '(root)'}</code> — {e.message}</li>
                ))}
              </ul>
            </div>
          )}
          {warnings.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12.5, color: theme.color.warn }}>
              {warnings.map((w, i) => <div key={i}>· {w.path} — {w.message}</div>)}
            </div>
          )}
        </section>

        {/* 结果 */}
        {run && (
          <section style={box}>
            <div style={{ ...row, justifyContent: 'space-between' }}>
              <strong style={{ color: theme.color.text, fontSize: 14 }}>回测结果</strong>
              <span style={{ color: theme.color.textFaint, fontSize: 12, fontFamily: 'Consolas, monospace' }}>
                指纹 {run.fingerprint.slice(0, 16)}… · 引擎 {run.engineVersion}
              </span>
            </div>
            <div style={{ ...row, marginTop: 12, gap: 18 }}>
              <div><span style={label}>总收益</span><strong style={{ ...pctStyle(run.result.totalReturn), fontSize: 20 }}>{fmtPct(run.result.totalReturn)}</strong></div>
              <div><span style={label}>年化</span><strong style={pctStyle(run.result.annualized)}>{fmtPct(run.result.annualized)}</strong></div>
              <div><span style={label}>最大回撤</span><strong style={{ color: theme.color.warn }}>{fmtPct(run.result.maxDrawdownPct)}</strong></div>
              <div><span style={label}>夏普</span><strong style={{ color: theme.color.text }}>{fmtNum(run.result.sharpe)}</strong></div>
              <div><span style={label}>等权基准</span><strong style={pctStyle(run.result.benchmarkReturn)}>{fmtPct(run.result.benchmarkReturn)}</strong></div>
              <div><span style={label}>调仓/成交</span><strong style={{ color: theme.color.text }}>{run.result.rebalances} / {run.result.fills}</strong></div>
            </div>
            <div style={{ ...row, marginTop: 8, gap: 18, color: theme.color.textFaint, fontSize: 12 }}>
              <span>区间 {run.result.range.start} ~ {run.result.range.end}（{run.result.range.bars} 根）</span>
              <span>股票池 {run.result.universeSize} 只 · 基准池 {run.result.benchmarkUniverse} 只</span>
              <span>手续费 {fmtNum(run.result.totalFees, 0)}（费率 {fmtPct(run.result.feeRatePct)}）</span>
              <span>涨停买不进 {run.result.blockedLimitUp} · 跌停卖不出 {run.result.blockedLimitDown}</span>
            </div>
            <div ref={chartRef} style={{ height: 260, marginTop: 12 }} />
            <div style={{ ...row, marginTop: 10, gap: 18, fontSize: 12.5, color: theme.color.textMuted }}>
              <span>IC 均值 <code style={{ color: theme.color.accent }}>{fmtNum(run.result.ic.icMean, 4)}</code></span>
              <span>ICIR <code style={{ color: theme.color.accent }}>{fmtNum(run.result.ic.icir, 3)}</code></span>
              <span>IC&gt;0 占比 {fmtPct(run.result.ic.icPositiveRate)}</span>
              <span>期数 {run.result.ic.n}</span>
              <span style={{ color: theme.color.textFaint }}>{run.result.ic.degraded ? `⚠️ ${run.result.ic.degraded}` : ''}</span>
            </div>
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: 'pointer', color: theme.color.textMuted, fontSize: 12.5 }}>执行计划（可审计：声明的因子/预处理/过滤原样回显）</summary>
              <pre style={{ marginTop: 8, padding: 12, background: theme.color.bgSunken, borderRadius: 8, border: `1px solid ${theme.color.border}`, color: theme.color.textMuted, fontSize: 12, overflowX: 'auto' }}>
                {JSON.stringify(run.plan, null, 2)}
              </pre>
            </details>
          </section>
        )}

        {/* 模型库 */}
        <section style={box}>
          <div style={{ ...row, justifyContent: 'space-between', marginBottom: 10 }}>
            <strong style={{ color: theme.color.text, fontSize: 14 }}>我的模型库</strong>
            <span style={{ color: theme.color.textFaint, fontSize: 12 }}>{quota.count}/{quota.quota}</span>
          </div>
          {library.length === 0 && <div style={{ color: theme.color.textFaint, fontSize: 12.5 }}>暂无模型。配置好后点「保存到模型库」。</div>}
          {library.map((it) => (
            <div key={it.id} style={{ ...row, justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${theme.color.border}` }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: theme.color.text, fontSize: 13.5 }}>{it.name || '(未命名)'}</div>
                <div style={{ color: theme.color.textFaint, fontSize: 11.5, fontFamily: 'Consolas, monospace' }}>
                  {it.id} · {it.modelHash.slice(0, 10)} · {String(it.updatedAt).slice(0, 16).replace('T', ' ')}
                </div>
              </div>
              <div style={row}>
                <button type="button" style={btn()} onClick={() => void doLoad(it.id)} disabled={busy !== null}>载入</button>
                <button type="button" style={btn()} onClick={() => void doDelete(it.id)} disabled={busy !== null}>删除</button>
              </div>
            </div>
          ))}
        </section>

        <div style={{ color: theme.color.textFaint, fontSize: 12, lineHeight: 1.8, paddingBottom: 20 }}>
          ⚠️ 所有回测结果均为学术研究演示，不构成任何投资建议。已知局限：核心股票池（非全市场）、
          退市股未入归档（存在幸存者偏差）、撮合零滑点假设之外的成交价简化。
        </div>
      </main>
    </div>
  );
}
