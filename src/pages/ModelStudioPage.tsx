// ─────────────────────────────────────────────────────────────
// 模型工坊（Phase 1 · 2026-10-05 三栏工作台重做）
//
//   重做动机（用户 2026-10-04 明确不满）：原实现是「8 个卡片竖排的单列长表单」，
//   问题不是缺功能，而是形态错位：
//     · 一屏只见一件事，改一个因子要滚 2~3 屏 —— 没有全局视野
//     · 只有「改 → 校验」，没有「改 → 看见」，权重是盲调的
//     · 校验结论只是列表，不锚定到出错的控件
//     · 空表单冷启动（新手第一步就卡住）
//     · 公网 canRun=false ⇒ 最强 CTA 是个灰按钮
//
//   现在是「工作台」形态（创作区骨架）：
//     左栏 Rail      —— 模板入口 / 结构树（带错误计数）/ 我的模型库
//     中栏 Editor    —— 只显示**当前一个**分区的编辑面（不再长滚动）+ 表单轨/JSON轨
//     右栏 Inspector —— **常驻回显**：校验（可点击定位）、流水线结构、结果 / 离线回执
//
//   两条轨的关系（诚实边界）：
//     表单轨可编辑；JSON 轨**只读**。原因：`Draft` 不承载 combine/universe/meta.tags，
//     就地编辑 JSON 会在往返中**静默丢弃**这些字段 —— 宁可只读，不做有损编辑。
//     无损改 JSON 的路径：下载 → 外部编辑 → 导入（导入同样走权威校验）。
//
//   页面纪律（沿用）：
//     · 校验结论以**服务端**为权威（前端只做防抖反馈）
//     · 校验失败逐条列出 path + message，且**可点击定位**
//     · 运行结果按服务端实际字段名渲染（maxDrawdownPct / ic.icMean，勿臆造）
// ─────────────────────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts';
import {
  modelsApi,
  type ModelSchema,
  type ModelSpec,
  type ModelTemplate,
  type ModelRunResponse,
  type ValidationIssue,
} from '../api';
import { theme } from '../lib/theme';
import ZoneShell from '../components/ZoneShell';
import PipelineView from './studio/PipelineView';
import ExperimentCompare from './studio/ExperimentCompare';
import {
  STUDIO_SECTIONS,
  draftToModel,
  effectiveDirection,
  emptyDraft,
  fmtNum,
  fmtPct,
  issuesFor,
  modelToDraft,
  nextDirection,
  pctColor,
  sectionOfIssuePath,
  type Draft,
  type StudioSection,
} from './studio/model-draft';

// ── 局部样式原子 ─────────────────────────────────────────────
const MONO = 'var(--zone-mono, Consolas, monospace)';
const SURFACE = 'var(--zone-surface, #0e1218)';
const SURFACE2 = 'var(--zone-surface-2, #131822)';
const LINE = 'var(--zone-line, #222a36)';
const RADIUS = 'var(--zone-radius, 10px)';

const panel: React.CSSProperties = {
  background: SURFACE,
  border: `1px solid ${LINE}`,
  borderRadius: RADIUS,
  overflow: 'hidden',
};
const panelHead: React.CSSProperties = {
  padding: '9px 12px',
  borderBottom: `1px solid ${LINE}`,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  fontSize: 12,
  color: theme.color.textMuted,
};
const panelBody: React.CSSProperties = { padding: 12 };
const label: React.CSSProperties = {
  color: theme.color.textMuted,
  fontSize: 12,
  marginBottom: 4,
  display: 'block',
};
const rowFlex: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' };

function btn(primary = false, disabled = false): React.CSSProperties {
  return {
    ...theme.input,
    cursor: disabled ? 'not-allowed' : 'pointer',
    color: primary ? '#fff' : theme.color.textMuted,
    background: primary ? theme.color.primaryDeep : SURFACE2,
    borderColor: primary ? theme.color.primary : LINE,
    opacity: disabled ? 0.45 : 1,
    whiteSpace: 'nowrap',
  };
}

/** 字段级校验提示（错误锚定：就长在出问题的控件下面，不用用户自己对号入座） */
function FieldIssues({ items, flash }: { items: ValidationIssue[]; flash: boolean }) {
  if (!items.length) return null;
  return (
    <div
      style={{
        marginTop: 5,
        padding: '5px 8px',
        borderRadius: 7,
        background: 'rgba(239,68,68,.09)',
        border: `1px solid ${flash ? theme.color.up : 'rgba(239,68,68,.32)'}`,
        fontSize: 12,
        color: theme.color.up,
        lineHeight: 1.6,
      }}
    >
      {items.slice(0, 4).map((e, i) => (
        <div key={i}>· {e.message}</div>
      ))}
    </div>
  );
}

export default function ModelStudioPage() {
  const [schema, setSchema] = useState<ModelSchema | null>(null);
  const [draft, setDraft] = useState<Draft>({ ...emptyDraft(), author: '' });
  const [errors, setErrors] = useState<ValidationIssue[]>([]);
  const [warnings, setWarnings] = useState<ValidationIssue[]>([]);
  const [modelHash, setModelHash] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'info' | 'ok' | 'err'; text: string } | null>(null);
  const [run, setRun] = useState<Extract<ModelRunResponse, { ok: true }> | null>(null);
  const [library, setLibrary] = useState<{ id: string; name: string; modelHash: string; updatedAt: string }[]>([]);
  const [quota, setQuota] = useState<{ count: number; quota: number }>({ count: 0, quota: 0 });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [opts, setOpts] = useState({ topN: '5', capital: '1000000', slippage: '0.001' });

  // 工作台状态
  const [touched, setTouched] = useState(false); // 是否已开始编辑（决定是否显示模板墙）
  const [section, setSection] = useState<StudioSection>('factors');
  const [track, setTrack] = useState<'form' | 'json' | 'exp'>('form');
  /** 递增即让「实验轨」重新拉取列表（跑完回测后留痕才有意义） */
  const [expToken, setExpToken] = useState(0);
  const [flashPath, setFlashPath] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);

  const model = useMemo(() => draftToModel(draft), [draft]);
  const canRun = schema ? schema.canRun : false;

  const flash = (kind: 'info' | 'ok' | 'err', text: string) => setMsg({ kind, text });

  // ── 校验问题按分区归类（左栏结构树显示计数，点击定位）──
  const issuesBySection = useMemo(() => {
    const m: Record<StudioSection, ValidationIssue[]> = {
      basic: [], factors: [], transforms: [], filters: [], backtest: [],
    };
    for (const e of errors) m[sectionOfIssuePath(e.path)].push(e);
    return m;
  }, [errors]);

  const focusIssue = (path: string | undefined) => {
    setSection(sectionOfIssuePath(path));
    setTrack('form');
    setFlashPath(String(path || ''));
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashPath(null), 1600);
  };
  useEffect(() => () => { if (flashTimer.current) window.clearTimeout(flashTimer.current); }, []);

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
          setModelHash(r.modelHash ?? null);
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
      grid: { left: 52, right: 14, top: 24, bottom: 24 },
      tooltip: { trigger: 'axis' },
      legend: { data: ['模型', '等权基准'], textStyle: { color: theme.color.textMuted, fontSize: 11 }, right: 4, top: 0 },
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

  // ── 离线执行回执（公网不能跑回测时的替代闭环）──
  //   ⚠️ 回测参数**不写进 Model JSON**：规范里 meta 只有 author/tags，
  //      塞进去会让导出的文件再导入时被校验拒绝（自己产的文件自己读不回）。
  //      故参数走两处：① 回执文本；② **下载文件名**（无损、可核对、可复现）。
  const receiptText = useMemo(() => {
    const lines = [
      '【模型工坊 · 离线执行回执】',
      `模型名称：${draft.name || '(未命名)'}`,
      `模型哈希：${modelHash || '（待校验通过后生成）'}`,
      `引擎版本：${schema?.engineVersion || '—'}`,
      `回测参数：topN=${opts.topN}  初始资金=${opts.capital}  滑点=${opts.slippage}`,
      `生成时间：${new Date().toISOString()}`,
      '',
      '说明：当前环境不提供回测执行。请把导出的 Model JSON 导入到本地版本执行；',
      '本地跑出的结果可凭上面的「模型哈希」核对是同一个模型定义（哈希只由语义核心',
      '决定：因子/预处理/过滤/组合/股票池/回测设置；改名称不会改变它）。',
    ];
    return lines.join('\n');
  }, [draft.name, modelHash, schema?.engineVersion, opts]);

  const copyText = async (text: string, okMsg: string) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        flash('ok', okMsg);
        return;
      }
      throw new Error('clipboard unavailable');
    } catch {
      flash('err', '当前环境不支持一键复制，请手动选中文本复制');
    }
  };

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
        // 服务端已自动留痕 ⇒ 让实验轨重新拉取（记录不可变，回测本身不改动它）
        setExpToken((n) => n + 1);
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
      setTouched(true);
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

  /** 下载任意 JSON（文件名自带语义，便于与回执核对） */
  const downloadJson = (payload: unknown, fileName: string) => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const safeName = () => (draft.name || 'model').replace(/[^\w\u4e00-\u9fa5-]/g, '_');

  const doExport = () => {
    downloadJson(model, `${safeName()}.json`);
    flash('ok', '已导出 Model JSON（可在本地版本导入执行）');
  };

  /** 离线回执附件：模型本体（**纯 Model JSON，可原样导回**）+ 文件名携带哈希与回测参数 */
  const doExportReceiptModel = () => {
    const h = modelHash ? `-${modelHash.slice(0, 8)}` : '';
    downloadJson(model, `${safeName()}${h}-topN${opts.topN}-cap${opts.capital}.json`);
    flash('ok', '已导出（文件名含模型哈希与回测参数；文件本身是纯 Model JSON，可直接导回）');
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
        setTouched(true);
        flash('ok', '已导入 JSON（保存后入库）');
      } catch (e) {
        flash('err', `JSON 解析失败：${(e as Error).message}`);
      }
    };
    reader.readAsText(file);
  };

  const applyTemplate = (t: ModelTemplate) => {
    setDraft(modelToDraft(t.model));
    setEditingId(null);
    setRun(null);
    setDirty(true);
    setTouched(true);
    setSection('factors');
    setTrack('form');
    flash('info', `已套用模板「${t.label}」——可直接改，或先看右栏结构`);
  };

  const newBlank = () => {
    setDraft({ ...emptyDraft(), author: draft.author });
    setEditingId(null);
    setRun(null);
    setDirty(false);
    setTouched(true);
    setSection('basic');
    flash('info', '已清空为空白模型');
  };

  // ── 草稿编辑辅助 ──
  const patch = (p: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setDirty(true);
    setTouched(true);
  };
  const setFactor = (i: number, p: Partial<Draft['factors'][number]>) => {
    setDraft((d) => ({ ...d, factors: d.factors.map((f, k) => (k === i ? { ...f, ...p } : f)) }));
    setDirty(true);
    setTouched(true);
  };

  const busyish = busy !== null;
  const issueCount = errors.length;

  // ── 中栏：模板墙（冷启动） ──
  const showGallery = !touched && !editingId;

  // ─────────────────────────────────────────────────────────
  return (
    <ZoneShell zone="studio" style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <style>{`
        .zw-wrap { display: flex; flex-direction: column; flex: 1; min-height: 0; }
        .zw-body {
          display: grid;
          grid-template-columns: var(--zone-rail, 256px) minmax(0, 1fr) var(--zone-inspector, 372px);
          gap: var(--zone-gap, 12px);
          padding: 0 var(--zone-pad, 14px) var(--zone-pad, 14px);
          align-items: start;
        }
        .zw-rail, .zw-editor { max-height: calc(100vh - 190px); overflow-y: auto; }
        .zw-inspector { max-height: calc(100vh - 190px); overflow-y: auto; }
        @media (max-width: 1360px) {
          .zw-body { grid-template-columns: var(--zone-rail, 256px) minmax(0, 1fr); }
          .zw-inspector { grid-column: 1 / -1; max-height: none; }
        }
        @media (max-width: 900px) {
          .zw-body { grid-template-columns: minmax(0, 1fr); }
          .zw-rail, .zw-editor, .zw-inspector { max-height: none; grid-column: auto; }
        }
        .zw-tpl { text-align: left; width: 100%; cursor: pointer; }
        .zw-tpl:hover { border-color: var(--zone-line-strong, #35415a) !important; background: var(--zone-surface-3, #182029) !important; }
      `}</style>

      <div className="zw-wrap">
        {/* ── 页头：分区标识 + 模型标识 + 主操作 ── */}
        <div style={{ padding: '10px var(--zone-pad, 14px) 12px' }}>
          <div style={{ ...rowFlex, justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span
                  style={{
                    fontSize: 11,
                    letterSpacing: 1.5,
                    fontFamily: MONO,
                    color: theme.color.accent,
                    border: `1px solid rgba(34,211,238,.35)`,
                    borderRadius: 5,
                    padding: '1px 6px',
                  }}
                >
                  创作区 · MODEL STUDIO
                </span>
                <span style={{ fontSize: 12, color: theme.color.textFaint }}>
                  {editingId ? `编辑中 ${editingId}` : '未入库'}
                  {dirty ? ' · 有未保存改动' : ''}
                </span>
              </div>
              <h1 style={{ ...theme.sectionTitle, marginBottom: 2, display: 'flex', alignItems: 'center', gap: 10 }}>
                {draft.name || '未命名模型'}
                {issueCount > 0 ? (
                  <span style={{ fontSize: 12, fontWeight: 400, color: theme.color.up }}>{issueCount} 项校验未过</span>
                ) : modelHash ? (
                  <span style={{ fontSize: 12, fontWeight: 400, color: theme.color.down }}>校验通过</span>
                ) : null}
              </h1>
            </div>
            <div style={{ ...rowFlex, justifyContent: 'flex-end' }}>
              <button type="button" style={btn()} onClick={newBlank} disabled={busyish}>新建</button>
              <button type="button" style={btn()} onClick={doExport} disabled={busyish}>导出 JSON</button>
              <label style={{ ...btn(false, busyish), display: 'inline-block' }}>
                导入 JSON
                <input
                  type="file"
                  accept="application/json"
                  style={{ display: 'none' }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) doImport(f); e.target.value = ''; }}
                />
              </label>
              <button type="button" style={btn()} onClick={() => void doSave(false)} disabled={busyish || issueCount > 0}>
                {busy === 'save' ? '保存中…' : editingId ? '更新' : '保存入库'}
              </button>
              <button type="button" style={btn()} onClick={() => void doSave(true)} disabled={busyish || issueCount > 0}>另存为</button>
              {canRun ? (
                <button
                  type="button"
                  style={btn(true, busyish || issueCount > 0)}
                  onClick={() => void doRun()}
                  disabled={busyish || issueCount > 0}
                  title={issueCount ? '请先修正校验问题' : ''}
                >
                  {busy === 'run' ? '运行中…' : '运行回测'}
                </button>
              ) : (
                <button
                  type="button"
                  style={btn(true, busyish)}
                  onClick={() => { setTrack('form'); copyText(receiptText, '回执已复制'); }}
                  disabled={busyish}
                  title="当前环境不执行回测；导出回执到本地执行"
                >
                  导出离线回执
                </button>
              )}
            </div>
          </div>

          {schema && !canRun && (
            <div
              style={{
                marginTop: 10,
                padding: '7px 10px',
                borderRadius: 8,
                border: `1px solid rgba(245,158,11,.32)`,
                background: 'rgba(245,158,11,.07)',
                color: theme.color.warn,
                fontSize: 12.5,
                lineHeight: 1.6,
              }}
            >
              当前环境（公网）不提供回测执行：可**配置、校验、保存、导出**模型 JSON，右栏会给出离线执行回执。
              跑净值请在本地版本导入该 JSON（文件名带模型哈希，便于核对是同一个定义）。
            </div>
          )}

          {msg && (
            <div
              style={{
                marginTop: 8,
                fontSize: 12.5,
                color: msg.kind === 'err' ? theme.color.up : msg.kind === 'ok' ? theme.color.down : theme.color.textMuted,
              }}
            >
              {msg.text}
            </div>
          )}
        </div>

        {/* ── 三栏工作台 ── */}
        <div className="zw-body">
          {/* 左栏 */}
          <div className="zw-rail" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--zone-gap, 12px)' }}>
            <div style={panel}>
              <div style={panelHead}>
                <span>从模板新建</span>
                <span style={{ fontSize: 11, color: theme.color.textFaint }}>{schema?.templates?.length ?? 0} 个</span>
              </div>
              <div style={{ ...panelBody, display: 'flex', flexDirection: 'column', gap: 7 }}>
                {(schema?.templates || []).map((t) => (
                  <button key={t.key} type="button" className="zw-tpl" style={{ ...panel, padding: 10, border: `1px solid ${LINE}` }} onClick={() => applyTemplate(t)}>
                    <div style={{ fontSize: 12.5, color: theme.color.text, marginBottom: 3 }}>{t.label}</div>
                    <div style={{ fontSize: 11.5, color: theme.color.textFaint, lineHeight: 1.55 }}>{t.desc}</div>
                  </button>
                ))}
                {(schema?.templates || []).length === 0 && (
                  <div style={{ fontSize: 12, color: theme.color.textFaint }}>模板加载中…</div>
                )}
              </div>
            </div>

            <div style={panel}>
              <div style={panelHead}><span>结构</span></div>
              <div style={{ padding: 6 }}>
                {STUDIO_SECTIONS.map((s) => {
                  const n = issuesBySection[s.id].length;
                  const active = section === s.id && track === 'form';
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => { setSection(s.id); setTrack('form'); }}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                        width: '100%', textAlign: 'left', cursor: 'pointer', padding: '7px 8px',
                        borderRadius: 7, border: 'none',
                        background: active ? 'rgba(34,211,238,.10)' : 'transparent',
                        color: active ? theme.color.text : theme.color.textMuted,
                        fontSize: 12.5,
                        borderLeft: active ? `2px solid ${theme.color.accent}` : '2px solid transparent',
                      }}
                    >
                      <span>
                        {s.label}
                        <span style={{ display: 'block', fontSize: 11, color: theme.color.textFaint }}>{s.hint}</span>
                      </span>
                      {n > 0 && (
                        <span style={{ fontSize: 11, color: theme.color.up, border: `1px solid rgba(239,68,68,.4)`, borderRadius: 9, padding: '0 6px' }}>
                          {n}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={panel}>
              <div style={panelHead}>
                <span>我的模型库</span>
                <span style={{ fontSize: 11, color: theme.color.textFaint }}>{quota.count}/{quota.quota}</span>
              </div>
              <div style={{ ...panelBody, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {library.length === 0 && <div style={{ fontSize: 12, color: theme.color.textFaint }}>暂无模型。配置好后点「保存入库」。</div>}
                {library.map((it) => (
                  <div key={it.id} style={{ borderTop: `1px solid ${LINE}`, paddingTop: 6 }}>
                    <div style={{ fontSize: 12.5, color: theme.color.text, marginBottom: 2 }}>{it.name || '(未命名)'}</div>
                    <div style={{ fontSize: 11, color: theme.color.textFaint, fontFamily: MONO, marginBottom: 5 }}>
                      {it.modelHash.slice(0, 10)} · {String(it.updatedAt).slice(0, 16).replace('T', ' ')}
                    </div>
                    <div style={rowFlex}>
                      <button type="button" style={{ ...btn(), padding: '4px 9px', fontSize: 12 }} onClick={() => void doLoad(it.id)} disabled={busyish}>载入</button>
                      <button type="button" style={{ ...btn(), padding: '4px 9px', fontSize: 12 }} onClick={() => void doDelete(it.id)} disabled={busyish}>删除</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* 中栏：编辑面 */}
          <div className="zw-editor" style={panel}>
            <div style={panelHead}>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['form', 'json', 'exp'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setTrack(k)}
                    style={{
                      ...btn(), padding: '4px 10px', fontSize: 12,
                      background: track === k ? theme.color.primaryDeep : SURFACE2,
                      color: track === k ? '#fff' : theme.color.textMuted,
                      borderColor: track === k ? theme.color.primary : LINE,
                    }}
                  >
                    {k === 'form' ? '表单轨' : k === 'json' ? 'JSON 轨（只读）' : '实验轨'}
                  </button>
                ))}
              </div>
              <span style={{ fontSize: 11, color: theme.color.textFaint }}>
                {track === 'exp' ? '每次回测自动留痕 · 可勾选对比' : '同一份 Model JSON · 两轨等价'}
              </span>
            </div>

            <div style={panelBody}>
              {track === 'json' ? (
                <div>
                  <div style={{ fontSize: 12, color: theme.color.textFaint, lineHeight: 1.7, marginBottom: 8 }}>
                    JSON 轨**只读**：表单不承载 combine/universe/meta.tags，就地编辑会在往返中静默丢弃这些字段。
                    要改 JSON 请「导出 → 外部编辑 → 导入」，导入同样走服务端权威校验。
                  </div>
                  <pre
                    style={{
                      margin: 0, padding: 12, background: SURFACE2, borderRadius: 8, border: `1px solid ${LINE}`,
                      color: theme.color.textMuted, fontSize: 12, fontFamily: MONO, overflowX: 'auto', maxHeight: 460,
                    }}
                  >
                    {JSON.stringify(model, null, 2)}
                  </pre>
                  <div style={{ ...rowFlex, marginTop: 8 }}>
                    <button type="button" style={btn()} onClick={() => void copyText(JSON.stringify(model, null, 2), 'JSON 已复制')}>
                      复制 JSON
                    </button>
                    <button type="button" style={btn()} onClick={doExport}>下载（纯模型）</button>
                    <button type="button" style={btn()} onClick={doExportReceiptModel}>下载（文件名含参数）</button>
                  </div>
                </div>
              ) : track === 'exp' ? (
                /* 实验轨：不可变留痕 + 对比（载入模型只写草稿，不改动原记录） */
                <ExperimentCompare
                  refreshToken={expToken}
                  onLoadModel={(snap) => {
                    setDraft(modelToDraft(snap));
                    setEditingId(null);
                    setRun(null);
                    setTouched(true);
                    setSection('factors');
                    setTrack('form');
                    flash('ok', '已载入该实验当时的模型定义（原实验记录未被修改）');
                  }}
                />
              ) : showGallery ? (
                /* 冷启动：先给骨架，而不是空白表单 */
                <div>
                  <div style={{ fontSize: 13.5, color: theme.color.text, marginBottom: 6 }}>先选一个起点</div>
                  <div style={{ fontSize: 12.5, color: theme.color.textMuted, lineHeight: 1.75, marginBottom: 12 }}>
                    模型 = 因子（谁强）+ 预处理（怎么比）+ 过滤（谁的池子）+ 调仓（多久换一次）。
                    从模板进去，每一步都能在右栏实时看到结构；也可以
                    <button type="button" style={{ background: 'none', border: 'none', color: theme.color.accent, cursor: 'pointer', padding: '0 4px', fontSize: 12.5 }} onClick={newBlank}>
                      从空白开始
                    </button>
                    ，或直接「导入 JSON」。
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                    {(schema?.templates || []).map((t) => (
                      <button key={t.key} type="button" className="zw-tpl" style={{ ...panel, padding: 12, border: `1px solid ${LINE}` }} onClick={() => applyTemplate(t)}>
                        <div style={{ fontSize: 13, color: theme.color.text, marginBottom: 5 }}>{t.label}</div>
                        <div style={{ fontSize: 11.5, color: theme.color.textMuted, lineHeight: 1.6, marginBottom: 7 }}>{t.desc}</div>
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                          {t.tags.map((tag) => (
                            <span key={tag} style={{ fontSize: 11, color: theme.color.accent, border: '1px solid rgba(34,211,238,.3)', borderRadius: 4, padding: '0 5px' }}>
                              {tag}
                            </span>
                          ))}
                        </div>
                      </button>
                    ))}
                    <button type="button" className="zw-tpl" style={{ ...panel, padding: 12, border: `1px dashed ${LINE}` }} onClick={newBlank}>
                      <div style={{ fontSize: 13, color: theme.color.textMuted }}>空白模型</div>
                      <div style={{ fontSize: 11.5, color: theme.color.textFaint, marginTop: 5 }}>自己从零搭一个</div>
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {/* 基本信息 */}
                  {section === 'basic' && (
                    <div>
                      <div style={{ ...rowFlex, alignItems: 'flex-start' }}>
                        <div style={{ flex: '1 1 260px' }}>
                          <span style={label}>模型名称 *</span>
                          <input value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="例：20日动量+低波动" style={{ ...theme.input, width: '100%' }} />
                          <FieldIssues items={issuesFor(errors, 'name')} flash={flashPath === 'name'} />
                        </div>
                        <div style={{ flex: '0 0 140px' }}>
                          <span style={label}>作者</span>
                          <input value={draft.author} onChange={(e) => patch({ author: e.target.value })} style={{ ...theme.input, width: '100%' }} />
                        </div>
                      </div>
                      <div style={{ marginTop: 12 }}>
                        <span style={label}>研究假设（可选）</span>
                        <textarea
                          value={draft.hypothesis}
                          onChange={(e) => patch({ hypothesis: e.target.value })}
                          placeholder="例：短期动量在低波动股上更持续"
                          rows={3}
                          style={{ ...theme.input, width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
                        />
                        <FieldIssues items={issuesFor(errors, 'hypothesis')} flash={flashPath === 'hypothesis'} />
                      </div>
                    </div>
                  )}

                  {/* 因子 */}
                  {section === 'factors' && (
                    <div>
                      <div style={{ ...rowFlex, justifyContent: 'space-between', marginBottom: 10 }}>
                        <strong style={{ color: theme.color.text, fontSize: 13.5 }}>
                          因子（{draft.factors.length}/{schema?.limits.maxFactors ?? 8}）
                        </strong>
                        <button
                          type="button"
                          style={btn(false, !!schema && draft.factors.length >= schema.limits.maxFactors)}
                          disabled={!!schema && draft.factors.length >= schema.limits.maxFactors}
                          onClick={() => patch({ factors: [...draft.factors, { id: `f${draft.factors.length + 1}`, expr: 'mom20', weight: '1', direction: 'auto' }] })}
                        >
                          + 添加因子
                        </button>
                      </div>
                      {draft.factors.map((f, i) => {
                        const iss = issuesFor(errors, `factors[${i}]`);
                        const p = `factors[${i}]`;
                        return (
                          <div
                            key={i}
                            style={{
                              marginBottom: 10, paddingBottom: 10, borderBottom: `1px solid ${LINE}`,
                              outline: flashPath && String(flashPath).startsWith(p) ? `1px solid ${theme.color.up}` : 'none',
                              outlineOffset: 3, borderRadius: 6,
                            }}
                          >
                            <div style={rowFlex}>
                              <input value={f.id} onChange={(e) => setFactor(i, { id: e.target.value })} placeholder="id" style={{ ...theme.input, width: 84 }} />
                              <input
                                value={f.expr}
                                onChange={(e) => setFactor(i, { expr: e.target.value })}
                                placeholder="预置因子名（mom20）或表达式（mom60 - mom20）"
                                list="ms-presets"
                                style={{ ...theme.input, flex: '1 1 260px', fontFamily: MONO }}
                              />
                              <span style={{ color: theme.color.textFaint, fontSize: 12 }}>权重</span>
                              <input value={f.weight} onChange={(e) => setFactor(i, { weight: e.target.value })} style={{ ...theme.input, width: 72 }} />
                              <button
                                type="button"
                                title={
                                  f.direction === 'auto'
                                    ? '方向由因子名自动推导（rev* 为反向），点击可改为显式指定'
                                    : '已显式指定方向（不会再随因子名变化），点击继续循环 → 自动'
                                }
                                style={{
                                  ...btn(),
                                  ...(f.direction === 'auto'
                                    ? { borderStyle: 'dashed', color: theme.color.textFaint }
                                    : {}),
                                }}
                                onClick={() => setFactor(i, { direction: nextDirection(f.direction) })}
                              >
                                {f.direction === 'auto'
                                  ? `自动·${effectiveDirection(f) === -1 ? '反 ↓' : '正 ↑'}`
                                  : f.direction === 1
                                    ? '正向 ↑'
                                    : '反向 ↓'}
                              </button>
                              <button type="button" style={btn(false, draft.factors.length <= 1)} disabled={draft.factors.length <= 1} onClick={() => patch({ factors: draft.factors.filter((_, k) => k !== i) })}>
                                删除
                              </button>
                            </div>
                            <FieldIssues items={iss} flash={flashPath === p} />
                          </div>
                        );
                      })}
                      <datalist id="ms-presets">
                        {(schema?.presets || []).map((p) => (
                          <option key={p} value={p} />
                        ))}
                      </datalist>
                      <div style={{ color: theme.color.textFaint, fontSize: 12, lineHeight: 1.7 }}>
                        权重为负即做空该因子暴露；方向正/负表示「因子值越大越看好 / 越不看好」。综合分越高越强。
                        <br />
                        <strong style={{ color: theme.color.textMuted }}>自动</strong>
                        表示不在模型里写死方向，由因子名推导（<code style={{ fontFamily: MONO }}>rev*</code> 反转、其余正向）——
                        改因子名时方向会跟着变；点一下即改为显式指定（边框变实线），此后不再随名字变化。
                      </div>
                    </div>
                  )}

                  {/* 预处理 */}
                  {section === 'transforms' && (
                    <div>
                      <div style={{ ...rowFlex, justifyContent: 'space-between', marginBottom: 10 }}>
                        <strong style={{ color: theme.color.text, fontSize: 13.5 }}>
                          截面预处理（按顺序生效 · {draft.transforms.length}/{schema?.limits.maxTransforms ?? 6}）
                        </strong>
                        <div style={rowFlex}>
                          {(schema?.transforms || []).map((t) => (
                            <button
                              key={t.type}
                              type="button"
                              style={btn(false, !!schema && draft.transforms.length >= schema.limits.maxTransforms)}
                              disabled={!!schema && draft.transforms.length >= schema.limits.maxTransforms}
                              onClick={() =>
                                patch({
                                  transforms: [...draft.transforms, {
                                    type: t.type,
                                    method: t.type === 'winsorize' ? 'mad' : undefined,
                                    n: t.type === 'winsorize' ? '3' : undefined,
                                  }],
                                })
                              }
                            >
                              + {t.type}
                            </button>
                          ))}
                        </div>
                      </div>
                      {draft.transforms.length === 0 && (
                        <div style={{ color: theme.color.textFaint, fontSize: 12.5, lineHeight: 1.7 }}>
                          未配置（可选）。例：先 winsorize 去极值，再 zscore 标准化——多因子量纲不同时几乎是必需的。
                        </div>
                      )}
                      {draft.transforms.map((t, i) => (
                        <div key={i} style={{ ...rowFlex, marginBottom: 8 }}>
                          <span style={{ color: theme.color.accent, fontFamily: MONO, fontSize: 12.5 }}>{i + 1}. {t.type}</span>
                          {t.type === 'winsorize' && (
                            <>
                              <select value={t.method || 'mad'} onChange={(e) => patch({ transforms: draft.transforms.map((x, k) => (k === i ? { ...x, method: e.target.value } : x)) })} style={{ ...theme.input, width: 90 }}>
                                <option value="mad">mad</option>
                                <option value="pct">pct</option>
                              </select>
                              <input value={t.n ?? '3'} onChange={(e) => patch({ transforms: draft.transforms.map((x, k) => (k === i ? { ...x, n: e.target.value } : x)) })} style={{ ...theme.input, width: 70 }} />
                            </>
                          )}
                          <button type="button" style={btn(i === 0)} disabled={i === 0} onClick={() => { const a = [...draft.transforms]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; patch({ transforms: a }); }}>↑</button>
                          <button type="button" style={btn()} onClick={() => patch({ transforms: draft.transforms.filter((_, k) => k !== i) })}>删除</button>
                          <FieldIssues items={issuesFor(errors, `transforms[${i}]`)} flash={flashPath === `transforms[${i}]`} />
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 过滤器 */}
                  {section === 'filters' && (
                    <div>
                      <div style={{ ...rowFlex, justifyContent: 'space-between', marginBottom: 10 }}>
                        <strong style={{ color: theme.color.text, fontSize: 13.5 }}>
                          过滤器（{draft.filters.length}/{schema?.limits.maxFilters ?? 5}）
                        </strong>
                        <button
                          type="button"
                          style={btn(false, !!schema && draft.filters.length >= schema.limits.maxFilters)}
                          disabled={!!schema && draft.filters.length >= schema.limits.maxFilters}
                          onClick={() => patch({ filters: [...draft.filters, { field: schema?.filterFields[0] || 'amount', min: '', max: '' }] })}
                        >
                          + 添加过滤器
                        </button>
                      </div>
                      {draft.filters.length === 0 && (
                        <div style={{ color: theme.color.textFaint, fontSize: 12.5, lineHeight: 1.7 }}>
                          未配置（可选）。按 T-1 日归档字段筛选候选股；**字段缺失视为不满足**。
                        </div>
                      )}
                      {draft.filters.map((f, i) => (
                        <div key={i} style={{ ...rowFlex, marginBottom: 8 }}>
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
                          <FieldIssues items={issuesFor(errors, `filters[${i}]`)} flash={flashPath === `filters[${i}]`} />
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 回测设置 */}
                  {section === 'backtest' && (
                    <div>
                      <strong style={{ color: theme.color.text, fontSize: 13.5 }}>回测设置</strong>
                      <div style={{ ...rowFlex, marginTop: 12 }}>
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
                        <label style={{ ...rowFlex, marginTop: 18, color: theme.color.textMuted, fontSize: 12.5 }}>
                          <input type="checkbox" checked={draft.fees} onChange={(e) => patch({ fees: e.target.checked })} />
                          计入手续费（单一源 paper/fees.cjs）
                        </label>
                      </div>
                      <FieldIssues items={issuesFor(errors, 'backtest')} flash={flashPath === 'backtest'} />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* 右栏：常驻回显 */}
          <div className="zw-inspector" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--zone-gap, 12px)' }}>
            {/* 1. 校验 */}
            <div style={panel}>
              <div style={panelHead}>
                <span>校验</span>
                <span style={{ fontSize: 11, color: issueCount ? theme.color.up : theme.color.down }}>
                  {issueCount ? `${issueCount} 项未过` : modelHash ? '通过' : '待校验'}
                </span>
              </div>
              <div style={panelBody}>
                {issueCount === 0 && warnings.length === 0 && (
                  <div style={{ fontSize: 12.5, color: theme.color.textMuted }}>没有发现问题。</div>
                )}
                {errors.length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {errors.map((e, i) => (
                      <li key={i}>
                        <button
                          type="button"
                          onClick={() => focusIssue(e.path)}
                          style={{ ...btn(), width: '100%', textAlign: 'left', display: 'block', color: theme.color.up, borderColor: 'rgba(239,68,68,.32)', fontSize: 12 }}
                        >
                          <code style={{ color: theme.color.accent, fontFamily: MONO }}>{e.path || '(root)'}</code> — {e.message}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {warnings.length > 0 && (
                  <div style={{ marginTop: errors.length ? 10 : 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {warnings.map((w, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => focusIssue(w.path)}
                        style={{ ...btn(), width: '100%', textAlign: 'left', display: 'block', color: theme.color.warn, borderColor: 'rgba(245,158,11,.28)', fontSize: 12 }}
                      >
                        <code style={{ fontFamily: MONO }}>{w.path || '(root)'}</code> — {w.message}
                      </button>
                    ))}
                  </div>
                )}
                <div style={{ marginTop: 9, fontSize: 11.5, color: theme.color.textFaint, fontFamily: MONO, wordBreak: 'break-all' }}>
                  modelHash {modelHash ? `${modelHash.slice(0, 24)}…` : '—'}
                </div>
              </div>
            </div>

            {/* 2. 结构（改 → 看见） */}
            <div style={panel}>
              <div style={panelHead}>
                <span>结构（实时）</span>
                <span style={{ fontSize: 11, color: theme.color.textFaint }}>综合分 = Σ 因子 × 权重 × 方向</span>
              </div>
              <div style={panelBody}>
                <PipelineView model={model} topN={opts.topN} />
              </div>
            </div>

            {/* 3. 结果 / 离线回执 */}
            <div style={panel}>
              <div style={panelHead}>
                <span>{run ? '回测结果' : canRun ? '回测结果' : '离线执行回执'}</span>
                {run && (
                  <span style={{ fontSize: 11, color: theme.color.textFaint, fontFamily: MONO }}>
                    指纹 {run.fingerprint.slice(0, 12)}…
                  </span>
                )}
              </div>
              <div style={panelBody}>
                {run ? (
                  <>
                    <div style={{ ...rowFlex, gap: 16 }}>
                      <div><span style={label}>总收益</span><strong style={{ color: pctColor(run.result.totalReturn), fontSize: 18 }}>{fmtPct(run.result.totalReturn)}</strong></div>
                      <div><span style={label}>年化</span><strong style={{ color: pctColor(run.result.annualized), fontSize: 15 }}>{fmtPct(run.result.annualized)}</strong></div>
                      <div><span style={label}>最大回撤</span><strong style={{ color: theme.color.warn, fontSize: 15 }}>{fmtPct(run.result.maxDrawdownPct)}</strong></div>
                      <div><span style={label}>夏普</span><strong style={{ color: theme.color.text, fontSize: 15 }}>{fmtNum(run.result.sharpe)}</strong></div>
                    </div>
                    <div style={{ ...rowFlex, gap: 16, marginTop: 8 }}>
                      <div><span style={label}>等权基准</span><strong style={{ color: pctColor(run.result.benchmarkReturn), fontSize: 13 }}>{fmtPct(run.result.benchmarkReturn)}</strong></div>
                      <div><span style={label}>调仓/成交</span><strong style={{ color: theme.color.text, fontSize: 13 }}>{run.result.rebalances} / {run.result.fills}</strong></div>
                    </div>
                    <div style={{ ...rowFlex, marginTop: 8, gap: 14, color: theme.color.textFaint, fontSize: 11.5 }}>
                      <span>{run.result.range.start} ~ {run.result.range.end}（{run.result.range.bars} 根）</span>
                      <span>池 {run.result.universeSize} 只</span>
                      <span>费用 {fmtNum(run.result.totalFees, 0)}</span>
                    </div>
                    <div ref={chartRef} style={{ height: 220, marginTop: 10 }} />
                    <div style={{ ...rowFlex, marginTop: 8, gap: 14, fontSize: 12, color: theme.color.textMuted }}>
                      <span>IC 均值 <code style={{ color: theme.color.accent, fontFamily: MONO }}>{fmtNum(run.result.ic.icMean, 4)}</code></span>
                      <span>ICIR <code style={{ color: theme.color.accent, fontFamily: MONO }}>{fmtNum(run.result.ic.icir, 3)}</code></span>
                      <span>IC&gt;0 {fmtPct(run.result.ic.icPositiveRate)}</span>
                      <span>期数 {run.result.ic.n}</span>
                    </div>
                    <div style={{ ...rowFlex, marginTop: 8, color: theme.color.textFaint, fontSize: 11.5 }}>
                      <span>涨停买不进 {run.result.blockedLimitUp} · 跌停卖不出 {run.result.blockedLimitDown}</span>
                      <span>引擎 {run.engineVersion}</span>
                    </div>
                    <details style={{ marginTop: 10 }}>
                      <summary style={{ cursor: 'pointer', color: theme.color.textMuted, fontSize: 12 }}>执行计划（服务端原样回显，可审计）</summary>
                      <pre style={{ marginTop: 8, padding: 10, background: SURFACE2, borderRadius: 8, border: `1px solid ${LINE}`, color: theme.color.textMuted, fontSize: 11.5, overflowX: 'auto', maxHeight: 240, fontFamily: MONO }}>
                        {JSON.stringify(run.plan, null, 2)}
                      </pre>
                    </details>
                  </>
                ) : canRun ? (
                  <div style={{ fontSize: 12.5, color: theme.color.textMuted, lineHeight: 1.7 }}>
                    配置好后点右上「运行回测」。结果会出现在这里（净值曲线 / 指标 / IC / 执行计划）。
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 12.5, color: theme.color.textMuted, lineHeight: 1.75 }}>
                      本环境不执行回测。把下面这份回执连同模型 JSON 带到本地版本执行即可复现；
                      本地结果可凭 <code style={{ color: theme.color.accent, fontFamily: MONO }}>modelHash</code> 核对是同一个模型定义。
                    </div>
                    <pre style={{ marginTop: 10, padding: 10, background: SURFACE2, borderRadius: 8, border: `1px solid ${LINE}`, color: theme.color.textMuted, fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {receiptText}
                    </pre>
                    <div style={{ ...rowFlex, marginTop: 8 }}>
                      <button type="button" style={btn(true)} onClick={() => void copyText(receiptText, '回执已复制')}>复制回执</button>
                      <button type="button" style={btn()} onClick={doExportReceiptModel}>下载（文件名含参数）</button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 合规声明（沿用） */}
        <div style={{ padding: '10px var(--zone-pad, 14px) 24px', color: theme.color.textFaint, fontSize: 12, lineHeight: 1.8 }}>
          ⚠️ 所有回测结果均为学术研究演示，不构成任何投资建议。已知局限：核心股票池（非全市场）、
          退市股未入归档（存在幸存者偏差）、撮合零滑点假设之外的成交价简化。
        </div>
      </div>
    </ZoneShell>
  );
}
