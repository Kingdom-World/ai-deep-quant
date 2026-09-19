// ─────────────────────────────────────────────────────────────
// 原子落盘工具（全站共用）
//   临时文件 + fsync + rename 提交。Windows 下杀毒/索引器会短暂锁住目标文件
//   导致 rename EPERM（本项目 PaperStore 已实测发生）——
//   失败时同步休眠重试，仍失败降级为直接覆写：宁可非原子也绝不丢数据。
//   fsync 背景：部署形态为家庭 Windows 主机（无 UPS），蓝屏/断电时
//   rename 可能已提交而内容仍在系统缓存未刷盘 → 目标文件"存在但为空/截断"。
//   paper 账本每 5s write-through 高频写入，该窗口真实存在，故写入后强制刷盘。
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

/** 同步休眠（Atomics.wait，不占事件循环回调） */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 超时返回属正常 */ }
}

/** 写入并强制刷盘：fsync 返回后内容已落盘，断电/蓝屏不丢 */
function writeFileDurably(file, text) {
  const fh = fs.openSync(file, 'w');
  try {
    fs.writeSync(fh, text); // 字符串默认按 utf8 编码（注意：writeSync 第三参是 position，不能传 encoding）
    fs.fsyncSync(fh);
  } finally {
    fs.closeSync(fh);
  }
}

/**
 * 原子写文本文件（调用方需先确保目录存在）
 * @returns {boolean} 是否成功
 */
function writeTextAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileDurably(tmp, text);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 尽力清理 */ }
    console.error(`[atomic-write] 临时文件写入失败 ${path.basename(file)}:`, e.message);
    return false;
  }
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, file);
      return true;
    } catch {
      sleepSync(120);
    }
  }
  try {
    writeFileDurably(file, text); // 降级路径同样 fsync，尽力保数据
    try { fs.unlinkSync(tmp); } catch { /* 清理临时文件失败无碍 */ }
    console.warn(`[atomic-write] rename 连续失败，已直接覆写保住数据: ${path.basename(file)}`);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 尽力清理 */ }
    console.error(`[atomic-write] 持久化彻底失败 ${path.basename(file)}:`, e.message);
    return false;
  }
}

/** 原子写 JSON（pretty=true 时带两空格缩进，便于人工排查） */
function writeJsonAtomic(file, data, pretty = false) {
  return writeTextAtomic(file, JSON.stringify(data, null, pretty ? 2 : 0));
}

module.exports = { writeTextAtomic, writeJsonAtomic, writeFileDurably };
