// ─────────────────────────────────────────────────────────────
// 实验对比 · 纯判定函数（跨栈共享：前端 import / node:test 直接测）
//
//   抽离动机（红队建议）：前端 0 组件测试，而「多选对比」的判定逻辑
//   （勾选上限、参数差异/一致分类）是合并后最容易出错的部分——
//   抽成纯函数后可以用现有 node:test 框架直接锁死边界。
//
//   为什么放 shared/：与 shared/rsi.mjs 同一模式——.mjs 前端可直接 import，
//   后端/测试环境可直接 require（Node ≥20.19），不引入构建期双真相源。
// ─────────────────────────────────────────────────────────────

/** 最多同时对比的实验条数 */
export const MAX_COMPARE = 4;

/** 实验唯一键：ts 为 ISO 时间，每次回测唯一，可据此稳定勾选 */
export const recKey = (e) => e.ts;

/**
 * 勾选切换的**纯核心**：给定当前选择与被点记录，算出下一步选择与提示文案。
 * 不做任何 setState——调用方拿到 { next, warn } 后自行更新，
 * 保证调用处的 state updater 保持纯函数（React 19 严格模式会重复执行 updater）。
 * @returns {{ next: string[], warn: string }} warn 非空表示触发了上限拦截（可见提示，非静默）
 */
export function nextSelection(selected, rec, max = MAX_COMPARE) {
  const k = recKey(rec);
  if (selected.includes(k)) {
    return { next: selected.filter((x) => x !== k), warn: '' };
  }
  if (selected.length >= max) {
    return {
      next: selected,
      warn: `最多对比 ${max} 条实验，已选中 ${max} 条。请先取消勾选其中一条，再添加第 ${max + 1} 条。`,
    };
  }
  return { next: [...selected, k], warn: '' };
}

/** 参与对比的全部实验的参数键并集（保持首次出现顺序） */
export function paramKeyUnion(records) {
  const set = new Set();
  records.forEach((r) => Object.keys(r.params || {}).forEach((k) => set.add(k)));
  return Array.from(set);
}

/**
 * 参数差异分类：只高亮「取值不同」的参数行，取值一致（或全员缺失）的归入 identical。
 * 判定规则（与 ExperimentsTab 原 useMemo 逐行等价）：
 *   任一实验缺失该键 → differing；取值 JSON 序列化后多于一种 → differing；否则 identical。
 * @returns {{ differing: string[], identical: { key: string, value: number }[] }}
 */
export function diffParams(records) {
  const diff = [];
  const same = [];
  for (const k of paramKeyUnion(records)) {
    const vals = records.map((r) => (r.params || {})[k]);
    const missing = vals.some((v) => v === undefined);
    const distinct = new Set(vals.map((v) => JSON.stringify(v))).size > 1;
    if (missing || distinct) diff.push(k);
    else same.push({ key: k, value: vals[0] });
  }
  return { differing: diff, identical: same };
}
