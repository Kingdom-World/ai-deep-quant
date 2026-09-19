/// <reference types="vite/client" />

// 构建版本戳（vite.config.ts 的 define 注入，build 时替换为实际构建时间）
declare const __BUILD_TIME__: string;
