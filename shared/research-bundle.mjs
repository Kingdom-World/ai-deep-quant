// 转发壳（实现落在 .cjs：平台运行时禁用 require(ESM)，只有 .cjs 两边都能装载）
export { BUNDLE_VERSION, KIND, buildResearchBundle, renderResearchReport } from './research-bundle.cjs';
