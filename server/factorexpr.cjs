// ─────────────────────────────────────────────────────────────
// 因子表达式引擎（M3.1）—— 策略研发的最小可用沙箱
//
//   目标：让用户用表达式组合因子，而不只是从 6 个预置因子里挑。
//     例：`mom60 - mom20`、`(mom20 + rev60) / 2`、`-vol20`、`mom20 * 0.5`
//
//   🔴 安全红线：**绝不 eval / new Function / vm**。
//     表达式是用户输入，视同不可信。本文件的做法是
//     词法分析 → 递归下降 → AST → **白名单求值**（只认已知节点类型与算子名）。
//     任何未知 token / 算子 / 结构在**解析期**即拒绝，不进求值。
//
//   🔴 口径一致性（本文件存在的意义）：表达式引擎的算子实现必须与
//     `crosssect.cjs` 的预置因子**逐位一致**。故 `mom20` 表达式的结果
//     必须恒等于预置 `mom20`——这是 M3.4 的等价性锁，也是防止
//     "两套动量口径悄悄分叉"（项目曾因 5 套 RSI 吃亏）的机制保障。
//
//   设计取舍：
//   · 算子返回**截面向量**（每股一个数），不是标量随时间变化。四则运算为
//     逐股逐元素运算。这样 `mom60 - mom20` 这类轮动型因子天然可表达。
//   · 股票集合取**所有算子结果的交集**（缺任一输入的股票剔除），
//     避免用 0 填充制造虚假截面样本。
// ─────────────────────────────────────────────────────────────

// ── 算子白名单 ────────────────────────────────────────────────
//   win：回看天数（必须为正整数，上限 MAX_WINDOW 防滥用）
//   reversal：是否属"反转族"语义（供策略方向分判，见 crosssect 的 REVERSAL_FACTORS）
const MAX_WINDOW = 250; // 约一年，超过无意义且拖慢计算
const MAX_DEPTH = 12; // AST 深度上限（防深嵌套栈溢出）
const MAX_LEN = 240; // 表达式长度上限

/**
 * 算子表。每个算子形如 `f(input, rows, i, ctx) -> number|null`
 *   · input：该股行数组（含 adjClose/adjOpen/close/open/high/low/volume/amount/turn）
 *   · i：当前行下标（= prevDate 对应行）
 *   · 返回 null 表示"该股此刻不可计算"（数据不足/除零），调用方剔除该股
 */
const OPS = {
  /** 动量：p(i)/p(i−n) − 1，同 crosssect.factorCrossSection 的 mom（用 adjClose） */
  mom: (n) => (rows, i) => {
    if (i - n < 0) return null;
    const c0 = rows[i - n].adjClose;
    const c1 = rows[i].adjClose;
    if (!Number.isFinite(c0) || !Number.isFinite(c1) || c0 <= 0 || c1 <= 0) return null;
    return c1 / c0 - 1;
  },
  /** 反转：动量的取负。语义独立（便于策略方向分判），数值上 = −mom */
  rev: (n) => (rows, i) => {
    const m = OPS.mom(n)(rows, i);
    return m === null ? null : -m;
  },
  /** 波动率：近 n 日**对数收益**的标准差（样本方差 n−1，与 statstest.seIid 口径同源） */
  vol: (n) => (rows, i) => {
    if (i - n < 0) return null;
    const rets = [];
    for (let k = i - n + 1; k <= i; k++) {
      const a = rows[k - 1].adjClose;
      const b = rows[k].adjClose;
      if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
      rets.push(Math.log(b / a));
    }
    if (rets.length < 2) return null;
    const m = rets.reduce((x, y) => x + y, 0) / rets.length;
    const v = rets.reduce((x, y) => x + (y - m) ** 2, 0) / (rets.length - 1);
    return Math.sqrt(v);
  },
  /** 换手率：近 n 日 turn 均值（turn 为百分数，原样取均值） */
  turnover: (n) => (rows, i) => {
    if (i - n + 1 < 0) return null;
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) {
      const t = rows[k].turn;
      if (!Number.isFinite(t)) return null;
      s += t;
    }
    return s / n;
  },
  /** 成交额：近 n 日 amount 均值（元） */
  amount: (n) => (rows, i) => {
    if (i - n + 1 < 0) return null;
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) {
      const a = rows[k].amount;
      if (!Number.isFinite(a)) return null;
      s += a;
    }
    return s / n;
  },
  /** 波动率倒数式的"稳定度"：−vol，便于组合出"低波动"因子 */
  lowvol: (n) => (rows, i) => {
    const v = OPS.vol(n)(rows, i);
    return v === null ? null : -v;
  },
  /** 价格相对均线偏离：(p(i) / MA(n)) − 1 */
  bias: (n) => (rows, i) => {
    if (i - n + 1 < 0) return null;
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) {
      const c = rows[k].adjClose;
      if (!Number.isFinite(c) || c <= 0) return null;
      s += c;
    }
    const ma = s / n;
    const p = rows[i].adjClose;
    if (!Number.isFinite(p) || ma <= 0) return null;
    return p / ma - 1;
  },
  /** 量比：近 n 日均量 / 近 m 日均量 − 1（n 短 m 长，放量为正） */
  volratio: (n, m) => (rows, i) => {
    if (i - n + 1 < 0 || i - m + 1 < 0) return null;
    const avg = (len) => {
      let s = 0;
      for (let k = i - len + 1; k <= i; k++) {
        const v = rows[k].volume;
        if (!Number.isFinite(v)) return null;
        s += v;
      }
      return s / len;
    };
    const a = avg(n);
    const b = avg(m);
    if (a === null || b === null || b <= 0) return null;
    return a / b - 1;
  },
};

/** 需要 window 参数的算子；以及固定参数个数的算子 */
const OP_ARITY = {
  mom: 1, rev: 1, vol: 1, turnover: 1, amount: 1, lowvol: 1, bias: 1,
  volratio: 2,
};

/** 反转族算子名（供上层做策略方向分判） */
const REVERSAL_OPS = new Set(['rev']);

class ExprError extends Error {
  constructor(msg, pos) {
    super(pos === undefined ? msg : `${msg}（位置 ${pos}）`);
    this.name = 'ExprError';
    this.pos = pos;
  }
}

// ── 词法分析 ─────────────────────────────────────────────────

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '(' || ch === ')' || ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === ',') {
      out.push({ t: ch, pos: i });
      i += 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      const num = Number(src.slice(i, j));
      if (!Number.isFinite(num)) throw new ExprError(`非法数字 "${src.slice(i, j)}"`, i);
      out.push({ t: 'num', v: num, pos: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      out.push({ t: 'ident', v: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    throw new ExprError(`非法字符 "${ch}"`, i);
  }
  out.push({ t: 'eof', pos: src.length });
  return out;
}

// ── 递归下降解析：expr → term → unary → primary ──────────────
//   优先级：+/- 最低，*/ 次之，一元负号再次，括号/原子最高。

function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];

  function parseExpr() {
    let left = parseTerm();
    while (peek().t === '+' || peek().t === '-') {
      const op = next().t;
      const right = parseTerm();
      left = { k: op, l: left, r: right };
    }
    return left;
  }
  function parseTerm() {
    let left = parseUnary();
    while (peek().t === '*' || peek().t === '/') {
      const op = next().t;
      const right = parseUnary();
      left = { k: op, l: left, r: right };
    }
    return left;
  }
  function parseUnary() {
    if (peek().t === '-') {
      next();
      return { k: 'neg', c: parseUnary() };
    }
    if (peek().t === '+') { next(); return parseUnary(); }
    return parsePrimary();
  }
  function parsePrimary() {
    const tk = peek();
    if (tk.t === '(') {
      next();
      const inner = parseExpr();
      if (peek().t !== ')') throw new ExprError('缺少右括号', peek().pos);
      next();
      return inner;
    }
    if (tk.t === 'num') { next(); return { k: 'num', v: tk.v }; }
    if (tk.t === 'ident') {
      const raw = tk.v;
      const pos = tk.pos;
      next();
      // ── 简写支持：`mom20` ≡ `mom(20)` ──
      //   方案书验收要求「mom60 表达式结果 === 预置 mom60」，故简写必须可用。
      //   规则：标识符尾部数字视为窗口参数（算子名本身不含数字，故无歧义）。
      const m = /^([A-Za-z_]+)([0-9]*)$/.exec(raw);
      const name = m ? m[1] : raw;
      const shorthand = m && m[2] ? Number(m[2]) : null;
      if (!Object.prototype.hasOwnProperty.call(OP_ARITY, name)) {
        throw new ExprError(`未知算子 "${raw}"，可用：${Object.keys(OP_ARITY).join('/')}`, pos);
      }
      const arity = OP_ARITY[name];

      // 简写只对单参数算子有意义（`volratio560` 无法拆分，拒绝并提示显式写法）
      if (shorthand !== null) {
        if (arity !== 1) {
          throw new ExprError(`算子 ${name} 需 ${arity} 个参数，不能用简写 "${raw}"，请写 ${name}(a,b)`, pos);
        }
        if (shorthand < 1) throw new ExprError(`算子 ${name} 的窗口必须是正整数，实际 ${shorthand}`, pos);
        if (shorthand > MAX_WINDOW) throw new ExprError(`算子 ${name} 的窗口 ${shorthand} 超过上限 ${MAX_WINDOW}`, pos);
        return { k: 'op', name, args: [shorthand] };
      }

      const args = [];
      // 算子参数必须以括号给出：mom(20) 或 volratio(5,60)
      if (peek().t !== '(') throw new ExprError(`算子 ${name} 缺少参数括号`, peek().pos);
      next();
      for (let a = 0; a < arity; a++) {
        if (a > 0) {
          if (peek().t !== ',') throw new ExprError(`算子 ${name} 参数间缺少逗号`, peek().pos);
          next();
        }
        if (peek().t !== 'num') throw new ExprError(`算子 ${name} 的参数必须是正整数`, peek().pos);
        const nv = next().v;
        if (!Number.isInteger(nv) || nv < 1) throw new ExprError(`算子 ${name} 的参数必须是正整数，实际 ${nv}`, pos);
        if (nv > MAX_WINDOW) throw new ExprError(`算子 ${name} 的窗口 ${nv} 超过上限 ${MAX_WINDOW}`, pos);
        args.push(nv);
      }
      if (peek().t === ',') throw new ExprError(`算子 ${name} 只接受 ${arity} 个参数`, peek().pos);
      if (peek().t !== ')') throw new ExprError(`算子 ${name} 参数后缺少右括号`, peek().pos);
      next();
      return { k: 'op', name, args };
    }
    throw new ExprError('表达式不完整', tk.pos);
  }

  const ast = parseExpr();
  if (peek().t !== 'eof') throw new ExprError(`表达式尾部有多余内容 "${peek().t}"`, peek().pos);
  const depth = astDepth(ast);
  if (depth > MAX_DEPTH) throw new ExprError(`表达式嵌套过深（${depth} > ${MAX_DEPTH}）`);
  return ast;
}

function astDepth(n) {
  if (!n || typeof n !== 'object') return 0;
  if (n.k === 'num') return 1;
  if (n.k === 'op') return 1;
  if (n.k === 'neg') return 1 + astDepth(n.c);
  return 1 + Math.max(astDepth(n.l), astDepth(n.r));
}

// ── 静态分析：提取所需窗口（决定回测起点）与是否含反转算子 ────

function collectMeta(ast) {
  let maxWin = 0;
  let hasReversal = false;
  const ops = new Set();
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.k === 'op') {
      ops.add(n.name);
      if (REVERSAL_OPS.has(n.name)) hasReversal = true;
      // 最长窗口决定 i−n ≥ 0 的起点约束
      maxWin = Math.max(maxWin, ...n.args);
      return;
    }
    if (n.k === 'neg') { walk(n.c); return; }
    if (n.l) walk(n.l);
    if (n.r) walk(n.r);
  };
  walk(ast);
  return { maxWindow: maxWin, hasReversal, ops: [...ops] };
}

// ── 白名单求值：遍历 AST，只认 k ∈ {num, op, neg, +,-,*,/} ────

/**
 * 推断表达式方向（供上层做策略方向分判）。
 *
 *   规则（宁缺毋滥——猜错方向比不判更糟，会给出与策略相反的结论）：
 *   · 只含 rev 类算子           → 'reversal'
 *   · 只含 mom 类算子           → 'momentum'
 *   · **两条路径都出现**         → null（如 mom20 + rev60）
 *   · **同类算子以减号相连**     → null（如 mom60 - mom20 —— 长动量减短动量，
 *       经济含义上等价于反转，但表达式表面写的是 mom，**不能按 mom 判方向**）
 *   · 含非线性算子（vol/amount/turnover/bias/volratio）→ null
 *       （这些与动量方向无关，加减乘除都可能改变符号含义，不做猜测）
 *
 *   ⚠️ 实测教训：`mom60 - mom20` 若被判为 'momentum'，分层会输出
 *   「因子方向与策略相反，继续按此方向选股将系统性亏损」——**方向本身就是错的结论**。
 *   故此处刻意保守：判不准就返回 null，由上层显式标注「方向不定」。
 */
function inferDirection(meta, ast) {
  const ops = meta.ops;
  const hasRev = ops.some((o) => REVERSAL_OPS.has(o));
  const momentumish = ops.filter((o) => o === 'mom');

  // 含非动量/非反转算子 → 方向不可判（vol 等与方向无关，组合后语义不定）
  if (ops.some((o) => o !== 'mom' && o !== 'rev')) return null;

  if (hasRev && momentumish.length === 0) return 'reversal';
  if (!hasRev && momentumish.length > 0) {
    // 即便只含 mom，若存在**减法**，长窗减短窗在语义上即反转，不能按动量判。
    return hasSubtraction(ast) ? null : 'momentum';
  }
  return null; // mom 与 rev 混用
}

/** AST 中是否存在减法节点（`-` 二元或一元 `neg`） */
function hasSubtraction(n) {
  if (!n || typeof n !== 'object') return false;
  if (n.k === '-' || n.k === 'neg') return true;
  if (n.k === 'op' || n.k === 'num') return false;
  return hasSubtraction(n.l) || hasSubtraction(n.r) || hasSubtraction(n.c);
}

/**
 * 解析并校验表达式。
 * @returns { ok:true, ast, meta } | { ok:false, error }
 */
function parseExpression(src) {
  const text = String(src ?? '').trim();
  if (!text) return { ok: false, error: '表达式为空' };
  if (text.length > MAX_LEN) return { ok: false, error: `表达式过长（${text.length} > ${MAX_LEN} 字符）` };
  try {
    const ast = parse(text);
    const meta = collectMeta(ast);
    if (!Number.isFinite(meta.maxWindow) || meta.maxWindow < 1) {
      return { ok: false, error: '表达式未引用任何算子（纯常数无选股意义）' };
    }
    return { ok: true, ast, meta, normalized: text };
  } catch (e) {
    return { ok: false, error: e instanceof ExprError ? e.message : `解析失败: ${e.message}` };
  }
}

/**
 * 在单只股票上求值，返回数值或 null（不可计算）。
 * 供 crosssect 的截面构造调用。
 */
function evalOnStock(ast, rows, i) {
  const ev = (n) => {
    switch (n.k) {
      case 'num': return n.v;
      case 'neg': {
        const v = ev(n.c);
        return v === null ? null : -v;
      }
      case 'op': {
        const fn = OPS[n.name];
        if (!fn) return null; // 解析期已白名单，此处是纵深防御
        return fn(...n.args)(rows, i);
      }
      case '+': case '-': case '*': case '/': {
        const a = ev(n.l);
        if (a === null) return null;
        const b = ev(n.r);
        if (b === null) return null;
        if (n.k === '+') return a + b;
        if (n.k === '-') return a - b;
        if (n.k === '*') return a * b;
        return b === 0 ? null : a / b; // 除零 → 剔除该股，不产生 Infinity
      }
      default: return null;
    }
  };
  const v = ev(ast);
  return Number.isFinite(v) ? v : null;
}

module.exports = {
  parseExpression,
  evalOnStock,
  inferDirection,
  OPS,
  OP_ARITY,
  REVERSAL_OPS,
  MAX_WINDOW,
  MAX_DEPTH,
  MAX_LEN,
  ExprError,
};
