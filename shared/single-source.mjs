// 转发壳（实现落在 .cjs：平台运行时禁用 require(ESM)，只有 .cjs 两边都能装载）
export { SINGLE_SOURCES, SKIP_DIRS, SCAN_EXT, listRepoFiles, verifyEntry, verifySingleSources } from './single-source.cjs';
