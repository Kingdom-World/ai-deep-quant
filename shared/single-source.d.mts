// 口径单一源清单 类型声明（与 shared/single-source.cjs 一一对应）

/** 一条"防分叉"守卫：数值/标识符不得在 allow 之外被重新定义 */
export interface SingleSourceGuard {
  /** 正则**字符串**（便于序列化给接口/前端） */
  pattern: string;
  reason: string;
  /** 允许出现的位置（相对仓库路径前缀） */
  allow: string[];
}

export interface SingleSourceEntry {
  id: string;
  label: string;
  /** 唯一权威文件（相对仓库根） */
  source: string;
  /** 必须在该文件里出现的导出名 */
  exports: string[];
  note: string;
  guards: SingleSourceGuard[];
  /** 必须存在的数据文件（数据类单一源用） */
  mustExist?: string[];
}

/** 守卫命中记录（file 为**相对路径**，不泄露绝对路径） */
export interface SingleSourceViolation {
  file: string;
  line: number;
  text: string;
}

export interface SingleSourceCheckResult {
  id: string;
  label: string;
  source: string;
  note: string;
  ok: boolean;
  issues: string[];
  exports: { name: string; found: boolean }[];
  guards: { pattern: string; reason: string; allow: string[]; violations: SingleSourceViolation[] }[];
}

export interface SingleSourceReport {
  ok: boolean;
  total: number;
  passed: number;
  scannedFiles: number;
  entries: SingleSourceCheckResult[];
  note: string;
}

export const SINGLE_SOURCES: SingleSourceEntry[];
export const SKIP_DIRS: Set<string>;
export const SCAN_EXT: Set<string>;

export function listRepoFiles(root: string, opts?: { skipDirs?: Set<string>; exts?: Set<string> }): string[];
export function verifyEntry(entry: SingleSourceEntry, root: string, files: string[]): SingleSourceCheckResult;
export function verifySingleSources(root: string, entries?: SingleSourceEntry[]): SingleSourceReport;
