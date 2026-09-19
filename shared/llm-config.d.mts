// shared/llm-config.mjs 的类型声明（供 TypeScript 前端引用唯一实现源）
//   .mjs 本身是 JS，TS 无法直接推断，故此处补声明。
//   口径：T2「自配 API」档的配置存储 —— Key 只存本机浏览器，永不上传服务端。

export interface ProviderPreset {
  label: string;
  base: string;
}

/** 供应商预设（与 server/ai/cloud.cjs 的 PROVIDERS 同源同口径） */
export declare const PROVIDERS: Record<string, ProviderPreset>;

/** 各供应商的推荐模型（仅作下拉提示；T2 是用户自己的 key，不受平台白名单约束） */
export declare const SUGGESTED_MODELS: Record<string, string[]>;

export declare const STORAGE_KEY: string;

export interface NormalizedConfig {
  provider: string;
  base: string;
  model: string;
  key: string;
  /** 校验错误列表，空数组表示通过 */
  errors: string[];
  ok: boolean;
  /** 是否走用户自备 key（T2 判定用） */
  byok: boolean;
}

/** 把用户输入归一化为可用配置；字段缺失时 errors 非空、ok 为 false */
export declare function normalizeConfig(raw?: unknown): NormalizedConfig;

/** 解析存储字符串；任何异常返回 null（不抛） */
export declare function parseStored(text?: string | null): NormalizedConfig | null;

/** 序列化为存储字符串（只含 provider/base/model/key 四个字段） */
export declare function serializeConfig(cfg?: unknown): string;

export interface ConfigStore {
  load(): NormalizedConfig | null;
  save(cfg?: unknown): { ok: boolean; errors?: string[] };
  clear(): void;
  maskedKey(): string;
}

/** 创建配置管理器；store 需形如 localStorage（getItem/setItem/removeItem） */
export declare function createConfigStore(store?: unknown): ConfigStore;

/** key 掩码展示（保留首 6 尾 4） */
export declare function maskKey(key?: string): string;

/** 档位说明文案（与方案书同口径，避免各处硬编码） */
export declare const TIER_NOTES: { rule: string; byok: string; platform: string };
