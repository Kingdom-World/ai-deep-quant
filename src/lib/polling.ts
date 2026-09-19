// ─────────────────────────────────────────────────────────────
// 可见性感知轮询工具
//
// 背景：页面原先普遍直接使用 window.setInterval 做行情轮询，存在三个问题：
//   1. 切到后台标签页 / 最小化后仍在持续请求，多个页面叠加形成请求风暴；
//   2. 上一轮请求未返回时下一轮已发出，慢接口下会请求叠加（报错也可能互相覆盖状态）；
//   3. 回到前台后要等满一个周期才刷新，用户看到的是过期行情。
//
// 本工具统一处理这三件事：后台自动暂停 · 上一轮未结束则跳过本轮 · 回前台立即补拉一次。
// 用法与原 setInterval 对齐，返回值为清理函数：
//   const stop = setVisibilityInterval(load, 15_000);
//   return () => { stop(); };
// ─────────────────────────────────────────────────────────────

export type PollingTask = () => void | Promise<void>;

/**
 * 创建可见性感知轮询
 * @param fn 每轮执行的任务（可为 async；执行期间不会重入）
 * @param intervalMs 轮询间隔（毫秒；<=0 时不启动）
 * @returns 停止轮询并移除监听的清理函数
 */
export function setVisibilityInterval(fn: PollingTask, intervalMs: number): () => void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => {};

  let running = false;
  let disposed = false;

  const isHidden = (): boolean =>
    typeof document !== 'undefined' && document.visibilityState === 'hidden';

  const tick = async (): Promise<void> => {
    if (disposed || running || isHidden()) return;
    running = true; // 防重入：慢接口下丢弃与上一轮重叠的执行
    try {
      await fn();
    } catch {
      // 单轮失败不终止轮询，交由下一轮自愈（调用方各自负责错误态展示）
    } finally {
      running = false;
    }
  };

  const timer = window.setInterval(() => {
    void tick();
  }, intervalMs);

  const onVisibilityChange = (): void => {
    if (!isHidden()) void tick(); // 回前台立即补拉，避免等满一个周期
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  return () => {
    disposed = true;
    window.clearInterval(timer);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  };
}
