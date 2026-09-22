// ─────────────────────────────────────────────────────────────
// 窄屏检测 Hook
//
//   为什么用 JS 而不是 CSS @media：
//     本项目大量使用**内联样式**（组件级样式不经过样式表），
//     `@media` 够不到内联样式 ⇒ 需要响应式时只能用 JS 检测后切换 style 值。
//
//   默认断点 520px：低于它按"手机"处理（375–430px 的主流机型都在此档）。
//   用 `matchMedia` + `change` 事件：旋转屏幕/拖动窗口宽度时会实时更新。
// ─────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react';

export function useIsNarrow(maxWidth = 520) {
  const [narrow, setNarrow] = useState(
    typeof window !== 'undefined' ? window.matchMedia(`(max-width: ${maxWidth}px)`).matches : false,
  );

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [maxWidth]);

  return narrow;
}
