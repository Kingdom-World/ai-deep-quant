// 转发壳（实现落在 .cjs：平台运行时禁用 require(ESM)，只有 .cjs 两边都能装载）
export { LAYERS, AUX, CATEGORIES, LAYER_KEYS, isTeachingLayer } from './knowledge-layers.cjs';
