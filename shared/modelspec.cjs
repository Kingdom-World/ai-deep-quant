// ─────────────────────────────────────────────────────────────
// Model JSON v1 —— 用户自主搭建量化模型的**声明式规范 + 校验器**（Phase 1）
//
//   定位：低代码表单轨 与 脚本轨 产出**同一份** Model JSON（单一真相源）。
//   🔴 红线：模型是**纯声明**——永不携带可执行代码；因子表达式只能是
//      预置因子名或白名单 AST 表达式（解析由 server/factorexpr.cjs 承担，
//      本模块以 `opts.parseExpr` 注入，前端不注入时只做结构校验）。
//
//   本模块为纯函数、零依赖：**实现落在 .cjs**，前端 `import` 走转发壳
//   `shared/modelspec.mjs`，服务端直接 `require('../../shared/modelspec.cjs')`。
//
//   🔴 2026-10-04 为什么从 .mjs 改为 .cjs（与 rsi 同一起因的第二次事故）：
//     原实现放在 `modelspec.mjs`，服务端 `require('../shared/modelspec.mjs')`，
//     依赖 Node 的 `require(ESM)`（Node 22.12+ 默认开启）——**本地永远正常**；
//     但线上 Vercel 运行时禁用该特性，抛：
//         [ERR_REQUIRE_ESM] require() of ES Module shared/modelspec.mjs not supported
//     结果**整个 Serverless 函数初始化失败**（/api/* 全量 500、登录不可用）。
//     ⇒ 实现放 .cjs（后端 require 任何版本可加载）+ 转发壳 .mjs（前端 import），
//       两个方向都用各自模块系统最稳的用法，彻底摆脱平台差异。
//       回归锁：test/no-require-esm.test.cjs（禁止服务端 require 任何 .mjs）。
//
//   白名单常量在此**唯一持有**；与引擎的一致性由 test/modelspec.test.cjs 的等价锁保证
//   （参照 shared/rsi.cjs 的单一实现纪律）。
// ─────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

/** 预置因子名（必须与 server/crosssect.cjs 的 FACTOR_WINDOWS 键一致——测试有等价锁） */
const PRESET_FACTORS = ['mom20', 'mom60', 'mom120', 'rev20', 'rev60', 'rev120'];

/** 截面预处理算子白名单（首批四种）。args 为各算子的参数规格。 */
const TRANSFORM_TYPES = {
  /** 去极值：mad=按中位数绝对偏差的 n 倍截尾；pct=按分位数 n% 截尾 */
  winsorize: { args: { method: ['mad', 'pct'], n: { type: 'number', min: 0.1, max: 50 } } },
  /** 标准化：截面 z-score */
  zscore: { args: {} },
  /** 截面排名（0~1 分位） */
  rank: { args: {} },
  /** 缺失填充 */
  fill_missing: { args: { method: ['cross_mean'] } },
};

/** 过滤器可用字段 —— 仅**归档真实存在**的字段（防臆造字段名；历史教训） */
const FILTER_FIELDS = [
  'close', 'open', 'high', 'low', 'volume', 'amount', 'turn', 'pctChg', // 归档原始字段
  'adjClose', 'adjOpen', // 引擎运行时按复权因子派生
];

/** 过滤器比较算子 */
const FILTER_OPS = ['>', '>=', '<', '<='];

/** 调仓周期 → 引擎的 rebalanceEvery（交易日根数）。与 crosssect.runCrossBacktest 默认 20 同源。 */
const REBALANCE_BARS = { daily: 1, weekly: 5, monthly: 20 };

/** 股票池类型（v1 仅核心池） */
const UNIVERSES = ['core_pool'];

/** 组合方式（v1 仅加权求和） */
const COMBINE_METHODS = ['weighted_sum'];

const LIMITS = {
  maxFactors: 8,
  maxTransforms: 6,
  maxFilters: 5,
  maxTags: 8,
  maxNameLen: 60,
  maxHypothesisLen: 500,
  maxWeight: 1e3,
  minGroups: 2,
  maxGroups: 10,
  maxIdLen: 40,
};

/**
 * 预置模型骨架（模板库）—— 声明式数据，**每个模板都必须能通过本文件自己的校验**。
 *
 *   为什么放在规范里，而不是前端硬编码：
 *     模板本质就是「一份合法的 Model JSON」，属于规范的示例面。放在这里 ⇒
 *       · 服务端经 /api/models/schema 下发（单一真相源，前端不手抄）
 *       · test/modelspec.test.cjs 可以锁住「每个模板真的能过校验」
 *         —— 模板写错是最难查的一类缺陷：用户点一下才报错，且看着像"表单坏了"。
 *   ⚠️ 模板与用户手写模型**完全同构**：前端载入后一切可改，不构成第二套规范。
 *   ⚠️ 数值型过滤器一律不放进模板：归档字段的量纲（amount/turn）会变，
 *      写死阈值会把候选池筛空。模板里只用 `min: 0` 表达「该字段必须存在」
 *      （引擎口径：字段缺失视为不满足）。
 */
const MODEL_TEMPLATES = [
  {
    key: 'mom20-baseline',
    label: '20 日动量基线',
    desc: '最小可用模型：单因子 + 月度调仓。第一次用就从这里开始。',
    tags: ['单因子', '月度'],
    model: {
      schemaVersion: SCHEMA_VERSION,
      name: '20日动量基线',
      hypothesis: '短周期动量在核心池上具备横截面区分度',
      factors: [{ id: 'mom20', expr: 'mom20', weight: 1, direction: 1 }],
      backtest: { rebalance: 'monthly', groups: 5, fees: true },
      meta: { author: 'template', tags: ['动量'] },
    },
  },
  {
    key: 'multi-mom',
    label: '双周期动量 + 标准化',
    desc: '120 日趋势确认叠加 20 日短动量；先去极值再 z-score，让两因子量纲可比。',
    tags: ['双因子', '去极值', '标准化'],
    model: {
      schemaVersion: SCHEMA_VERSION,
      name: '双周期动量(120/20)',
      hypothesis: '长期趋势成立时，短周期动量更可能延续',
      factors: [
        { id: 'trend', expr: 'mom120', weight: 1, direction: 1 },
        { id: 'short', expr: 'mom20', weight: 0.6, direction: 1 },
      ],
      transforms: [
        { type: 'winsorize', args: { method: 'mad', n: 3 } },
        { type: 'zscore' },
      ],
      backtest: { rebalance: 'monthly', groups: 5, fees: true },
      meta: { author: 'template', tags: ['动量', '趋势'] },
    },
  },
  {
    key: 'mom-rev-combo',
    label: '动量 + 反转组合',
    desc: '用方向相反的因子互相对冲：中期动量为主，短期反转做辅。',
    tags: ['双因子', '对冲'],
    model: {
      schemaVersion: SCHEMA_VERSION,
      name: '动量+反转组合(60/20)',
      hypothesis: '中期动量与短期反转的相关性低，组合后截面区分度更稳',
      factors: [
        { id: 'mom60', expr: 'mom60', weight: 1, direction: 1 },
        { id: 'rev20', expr: 'rev20', weight: 0.8, direction: 1 },
      ],
      transforms: [
        { type: 'winsorize', args: { method: 'mad', n: 3 } },
        { type: 'zscore' },
      ],
      backtest: { rebalance: 'monthly', groups: 5, fees: true },
      meta: { author: 'template', tags: ['动量', '反转'] },
    },
  },
  {
    key: 'flow-cleaned-mom',
    label: '流动性清洗 + 动量（周频）',
    desc: '先用过滤器剔除成交额缺失样本（缺失视为不满足），再按周频调仓、按分位排名合成。',
    tags: ['过滤器', '排名', '周频'],
    model: {
      schemaVersion: SCHEMA_VERSION,
      name: '流动性清洗动量(周频)',
      hypothesis: '剔除成交额缺失的样本后，动量信号的横截面区分度更干净',
      factors: [{ id: 'mom20', expr: 'mom20', weight: 1, direction: 1 }],
      transforms: [{ type: 'rank' }],
      filters: [{ type: 'field_range', field: 'amount', min: 0 }],
      backtest: { rebalance: 'weekly', groups: 10, fees: true },
      meta: { author: 'template', tags: ['动量', '流动性'] },
    },
  },
];

// ── 工具 ─────────────────────────────────────────────────────
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string';

const TOP_KEYS = ['schemaVersion', 'name', 'hypothesis', 'factors', 'transforms', 'combine', 'filters', 'universe', 'backtest', 'meta'];
const FACTOR_KEYS = ['id', 'expr', 'weight', 'direction'];
const TRANSFORM_KEYS = ['type', 'args'];
const FILTER_KEYS = ['type', 'field', 'op', 'value', 'min', 'max', 'expr'];
const BACKTEST_KEYS = ['rebalance', 'groups', 'fees'];
const UNIVERSE_KEYS = ['type'];
const COMBINE_KEYS = ['method'];
const META_KEYS = ['author', 'tags'];

const ID_RE = /^[A-Za-z0-9_-]+$/;
const TAG_RE = /^[\w\u4e00-\u9fa5-]{1,20}$/;

/** 未知键一律报错（拒绝静默忽略——拼错字段名必须立刻可见） */
function rejectUnknownKeys(obj, allowed, path, errors) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push({ path: path ? `${path}.${k}` : k, message: `未知字段「${k}」（允许：${allowed.join('/')}）` });
  }
}

// ── 校验 ─────────────────────────────────────────────────────
/**
 * 结构 + 语义校验（不填默认值、不改写输入）。
 * @param {any} input 待校验的 Model JSON
 * @param {{parseExpr?: (src:string)=>{ok:boolean,error?:string}, presets?: string[]}} [opts]
 *   parseExpr：表达式解析器（服务端注入 factorexpr.parseExpression）；缺省则只做字符级白名单校验。
 * @returns {{ok:boolean, errors:{path:string,message:string}[], warnings:{path:string,message:string}[]}}
 */
function validateModel(input, opts = {}) {
  const errors = [];
  const warnings = [];
  const presets = opts.presets || PRESET_FACTORS;

  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: '', message: 'Model 必须是 JSON 对象' }], warnings };
  }
  rejectUnknownKeys(input, TOP_KEYS, '', errors);

  // schemaVersion
  if (input.schemaVersion !== SCHEMA_VERSION) {
    errors.push({ path: 'schemaVersion', message: `schemaVersion 必须为 ${SCHEMA_VERSION}（收到 ${JSON.stringify(input.schemaVersion)}）` });
  }

  // name
  if (!isStr(input.name) || input.name.trim() === '') {
    errors.push({ path: 'name', message: 'name 必填且为非空字符串' });
  } else if (input.name.length > LIMITS.maxNameLen) {
    errors.push({ path: 'name', message: `name 长度上限 ${LIMITS.maxNameLen}（当前 ${input.name.length}）` });
  }

  // hypothesis（可选）
  if (input.hypothesis !== undefined) {
    if (!isStr(input.hypothesis)) errors.push({ path: 'hypothesis', message: 'hypothesis 必须为字符串' });
    else if (input.hypothesis.length > LIMITS.maxHypothesisLen) errors.push({ path: 'hypothesis', message: `hypothesis 长度上限 ${LIMITS.maxHypothesisLen}` });
  }

  // factors
  if (!Array.isArray(input.factors) || input.factors.length === 0) {
    errors.push({ path: 'factors', message: 'factors 必须为非空数组' });
  } else if (input.factors.length > LIMITS.maxFactors) {
    errors.push({ path: 'factors', message: `因子数上限 ${LIMITS.maxFactors}（当前 ${input.factors.length}）` });
  } else {
    const seenId = new Set();
    input.factors.forEach((f, i) => {
      const p = `factors[${i}]`;
      if (!isPlainObject(f)) { errors.push({ path: p, message: '因子必须是对象' }); return; }
      rejectUnknownKeys(f, FACTOR_KEYS, p, errors);

      // id
      if (f.id !== undefined) {
        if (!isStr(f.id) || !ID_RE.test(f.id) || f.id.length > LIMITS.maxIdLen) {
          errors.push({ path: `${p}.id`, message: `id 只能含字母/数字/_/-，长度 1~${LIMITS.maxIdLen}` });
        } else if (seenId.has(f.id)) {
          errors.push({ path: `${p}.id`, message: `id「${f.id}」重复` });
        } else seenId.add(f.id);
      }

      // expr
      if (!isStr(f.expr) || f.expr.trim() === '') {
        errors.push({ path: `${p}.expr`, message: 'expr 必填（预置因子名或白名单表达式）' });
      } else {
        const src = f.expr.trim();
        if (presets.includes(src)) {
          // 预置因子：无需表达式解析
        } else if (typeof opts.parseExpr === 'function') {
          const r = opts.parseExpr(src);
          if (!r || !r.ok) errors.push({ path: `${p}.expr`, message: `表达式不可用：${r && r.error ? r.error : '解析失败'}` });
        } else if (!/^[A-Za-z0-9_+\-*/(). \t]+$/.test(src)) {
          errors.push({ path: `${p}.expr`, message: '表达式含白名单外字符（；引号/反引号/中文标点等一律拒绝）' });
        } else {
          // 字符级通过 ≠ 表达式合法：形如 `foo(1)` 也可能不是白名单算子。
          // 前端无法判定（无 AST），**必须显式标记未验证**，不得静默当作合法。
          warnings.push({
            path: `${p}.expr`,
            message: '表达式仅通过字符级校验，未经 AST 白名单验证——提交后由服务端权威校验',
          });
        }
      }

      // weight
      if (f.weight !== undefined) {
        if (!isFiniteNum(f.weight)) errors.push({ path: `${p}.weight`, message: 'weight 必须是有限数字' });
        else if (f.weight === 0) errors.push({ path: `${p}.weight`, message: 'weight 不能为 0（等于该因子不生效，请移除）' });
        else if (Math.abs(f.weight) > LIMITS.maxWeight) errors.push({ path: `${p}.weight`, message: `|weight| 上限 ${LIMITS.maxWeight}` });
      }

      // direction
      if (f.direction !== undefined && f.direction !== 1 && f.direction !== -1) {
        errors.push({ path: `${p}.direction`, message: 'direction 只能是 1 或 -1' });
      }
    });

    // 权重全为 0 的退化情形
    const allZero = input.factors.every((f) => isFiniteNum(f && f.weight) && f.weight === 0);
    if (!allZero && input.factors.every((f) => f && f.weight === undefined)) {
      warnings.push({ path: 'factors', message: '未声明 weight，将按等权处理' });
    }
  }

  // transforms
  if (input.transforms !== undefined) {
    if (!Array.isArray(input.transforms)) errors.push({ path: 'transforms', message: 'transforms 必须是数组' });
    else if (input.transforms.length > LIMITS.maxTransforms) {
      errors.push({ path: 'transforms', message: `transforms 数量上限 ${LIMITS.maxTransforms}` });
    } else {
      input.transforms.forEach((t, i) => {
        const p = `transforms[${i}]`;
        if (!isPlainObject(t)) { errors.push({ path: p, message: 'transform 必须是对象' }); return; }
        rejectUnknownKeys(t, TRANSFORM_KEYS, p, errors);
        const spec = TRANSFORM_TYPES[t.type];
        if (!spec) {
          errors.push({ path: `${p}.type`, message: `未知预处理算子「${t.type}」（允许：${Object.keys(TRANSFORM_TYPES).join('/')}）` });
          return;
        }
        const args = t.args === undefined ? {} : t.args;
        if (!isPlainObject(args)) { errors.push({ path: `${p}.args`, message: 'args 必须是对象' }); return; }
        for (const [k, v] of Object.entries(args)) {
          if (!(k in spec.args)) { errors.push({ path: `${p}.args.${k}`, message: `算子 ${t.type} 不接受参数「${k}」` }); continue; }
          const rule = spec.args[k];
          if (Array.isArray(rule)) {
            if (!rule.includes(v)) errors.push({ path: `${p}.args.${k}`, message: `取值须为 ${rule.join('/')}（收到 ${JSON.stringify(v)}）` });
          } else if (rule.type === 'number') {
            if (!isFiniteNum(v)) errors.push({ path: `${p}.args.${k}`, message: '必须是数字' });
            else if (v < rule.min || v > rule.max) errors.push({ path: `${p}.args.${k}`, message: `取值范围 ${rule.min}~${rule.max}` });
          }
        }
      });
    }
  }

  // combine
  if (input.combine !== undefined) {
    if (!isPlainObject(input.combine)) errors.push({ path: 'combine', message: 'combine 必须是对象' });
    else {
      rejectUnknownKeys(input.combine, COMBINE_KEYS, 'combine', errors);
      if (!COMBINE_METHODS.includes(input.combine.method)) {
        errors.push({ path: 'combine.method', message: `v1 仅支持 ${COMBINE_METHODS.join('/')}` });
      }
    }
  }

  // filters
  if (input.filters !== undefined) {
    if (!Array.isArray(input.filters)) errors.push({ path: 'filters', message: 'filters 必须是数组' });
    else if (input.filters.length > LIMITS.maxFilters) errors.push({ path: 'filters', message: `filters 数量上限 ${LIMITS.maxFilters}` });
    else {
      input.filters.forEach((flt, i) => {
        const p = `filters[${i}]`;
        if (!isPlainObject(flt)) { errors.push({ path: p, message: 'filter 必须是对象' }); return; }
        rejectUnknownKeys(flt, FILTER_KEYS, p, errors);

        if (flt.type === 'expr_predicate') {
          // v1 明确不支持：绝不静默忽略（静默=用户以为过滤生效，实际没有）
          errors.push({ path: p, message: 'v1 不支持 expr_predicate（需 Phase 1 脚本轨 DSL 扩展后启用）；当前请用 field_range（=字段比较）' });
          return;
        }
        if (flt.type !== 'field_range') {
          errors.push({ path: `${p}.type`, message: `未知过滤器类型「${flt.type}」（v1 仅 field_range）` });
          return;
        }
        if (!FILTER_FIELDS.includes(flt.field)) {
          errors.push({ path: `${p}.field`, message: `未知字段「${flt.field}」（允许：${FILTER_FIELDS.join('/')}）` });
        }
        if (flt.op !== undefined && !FILTER_OPS.includes(flt.op)) {
          errors.push({ path: `${p}.op`, message: `比较算子须为 ${FILTER_OPS.join(' ')}` });
        }
        const hasBound = isFiniteNum(flt.min) || isFiniteNum(flt.max) || isFiniteNum(flt.value);
        if (!hasBound) errors.push({ path: p, message: 'field_range 需至少提供 min / max / value 之一（且为数字）' });
        if (isFiniteNum(flt.min) && isFiniteNum(flt.max) && flt.min > flt.max) {
          errors.push({ path: p, message: 'min 不能大于 max' });
        }
        if (flt.value !== undefined && flt.min === undefined && flt.max === undefined && flt.op === undefined) {
          errors.push({ path: `${p}.op`, message: '使用 value 时必须同时给出 op' });
        }
      });
    }
  }

  // universe
  if (input.universe !== undefined) {
    if (!isPlainObject(input.universe)) errors.push({ path: 'universe', message: 'universe 必须是对象' });
    else {
      rejectUnknownKeys(input.universe, UNIVERSE_KEYS, 'universe', errors);
      if (!UNIVERSES.includes(input.universe.type)) {
        errors.push({ path: 'universe.type', message: `v1 仅支持 ${UNIVERSES.join('/')}` });
      }
    }
  }

  // backtest
  if (input.backtest !== undefined) {
    if (!isPlainObject(input.backtest)) errors.push({ path: 'backtest', message: 'backtest 必须是对象' });
    else {
      rejectUnknownKeys(input.backtest, BACKTEST_KEYS, 'backtest', errors);
      if (input.backtest.rebalance !== undefined && !(input.backtest.rebalance in REBALANCE_BARS)) {
        errors.push({ path: 'backtest.rebalance', message: `调仓周期须为 ${Object.keys(REBALANCE_BARS).join('/')}` });
      }
      const g = input.backtest.groups;
      if (g !== undefined) {
        if (!Number.isInteger(g)) errors.push({ path: 'backtest.groups', message: 'groups 必须是整数' });
        else if (g < LIMITS.minGroups || g > LIMITS.maxGroups) {
          errors.push({ path: 'backtest.groups', message: `groups 范围 ${LIMITS.minGroups}~${LIMITS.maxGroups}` });
        }
      }
      if (input.backtest.fees !== undefined && typeof input.backtest.fees !== 'boolean') {
        errors.push({ path: 'backtest.fees', message: 'fees 必须是布尔值' });
      }
    }
  }

  // meta
  if (!isPlainObject(input.meta)) {
    errors.push({ path: 'meta', message: 'meta 必填（至少包含 author）' });
  } else {
    rejectUnknownKeys(input.meta, META_KEYS, 'meta', errors);
    if (!isStr(input.meta.author) || input.meta.author.trim() === '') {
      errors.push({ path: 'meta.author', message: 'meta.author 必填且为非空字符串' });
    } else if (input.meta.author.length > 64) {
      errors.push({ path: 'meta.author', message: 'meta.author 长度上限 64' });
    }
    if (input.meta.tags !== undefined) {
      if (!Array.isArray(input.meta.tags)) errors.push({ path: 'meta.tags', message: 'tags 必须是数组' });
      else if (input.meta.tags.length > LIMITS.maxTags) errors.push({ path: 'meta.tags', message: `tags 数量上限 ${LIMITS.maxTags}` });
      else {
        input.meta.tags.forEach((t, i) => {
          if (!isStr(t) || !TAG_RE.test(t)) errors.push({ path: `meta.tags[${i}]`, message: 'tag 只能含中英文/数字/_/-，长度 1~20' });
        });
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ── 归一化 ───────────────────────────────────────────────────
/**
 * 校验并填默认值，产出**规范化 Model**（可直接用于回测执行与版本快照）。
 * 校验失败时 model 为 null（调用方必须走错误分支，不得使用半成品）。
 * @returns {{ok:boolean, model:object|null, errors:object[], warnings:object[]}}
 */
function normalizeModel(input, opts = {}) {
  const v = validateModel(input, opts);
  if (!v.ok) return { ok: false, model: null, errors: v.errors, warnings: v.warnings };

  const factors = input.factors.map((f, i) => ({
    id: f.id || `f${i + 1}`,
    expr: f.expr.trim(),
    weight: f.weight === undefined ? 1 : f.weight,
    direction: f.direction === undefined ? 1 : f.direction,
  }));

  const model = {
    schemaVersion: SCHEMA_VERSION,
    name: input.name.trim(),
    ...(input.hypothesis !== undefined ? { hypothesis: input.hypothesis.trim() } : {}),
    factors,
    transforms: (input.transforms || []).map((t) => ({ type: t.type, args: t.args === undefined ? {} : t.args })),
    combine: { method: (input.combine && input.combine.method) || 'weighted_sum' },
    filters: (input.filters || []).map((f) => ({ ...f })),
    universe: { type: (input.universe && input.universe.type) || 'core_pool' },
    backtest: {
      rebalance: (input.backtest && input.backtest.rebalance) || 'monthly',
      groups: input.backtest && input.backtest.groups !== undefined ? input.backtest.groups : 5,
      fees: input.backtest && input.backtest.fees !== undefined ? input.backtest.fees : true,
    },
    meta: {
      author: input.meta.author.trim(),
      tags: input.meta.tags ? [...input.meta.tags] : [],
    },
  };
  return { ok: true, model, errors: [], warnings: v.warnings };
}

/** 调仓周期 → 引擎 rebalanceEvery（交易日根数）；未知周期回退 monthly（调用前应先过校验） */
function rebalanceBars(period) {
  return REBALANCE_BARS[period] || REBALANCE_BARS.monthly;
}

/**
 * 规范化序列化：键序固定、数字按原值、数组保序 —— 供版本指纹与 diff 使用。
 * 同一模型对象在不同键序下产出**同一字符串**。
 */
function canonicalJSON(model) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(model));
}

module.exports = {
  SCHEMA_VERSION,
  PRESET_FACTORS,
  TRANSFORM_TYPES,
  FILTER_FIELDS,
  FILTER_OPS,
  REBALANCE_BARS,
  UNIVERSES,
  COMBINE_METHODS,
  LIMITS,
  MODEL_TEMPLATES,
  validateModel,
  normalizeModel,
  rebalanceBars,
  canonicalJSON,
};
