import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// 说明：eslint-plugin-react 当前版本(7.x/8.0-rc)与 ESLint 10 存在 API 不兼容，
// 故未启用其规则集；本项目 TS + React Hooks 检查由以下配置覆盖：
//   - typescript-eslint: TS 类型相关规则
//   - eslint-plugin-react-hooks: Hooks 规则
//   - eslint-config-prettier: 关闭与 Prettier 冲突的格式规则
export default defineConfig([
  globalIgnores(['dist', 'ashare-mcp', 'server', 'node_modules']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      prettier,
    ],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // 数据加载模式：effect 内同步 setState 是常见且必要的（触发首次加载），降为警告
      'react-hooks/set-state-in-effect': 'warn',
      // 错误透传（保留原始 error）在本项目桥接层是有意为之
      'preserve-caught-error': 'off',
      // 非空断言用于图表类型收窄，属合理用法
      '@typescript-eslint/no-non-null-assertion': 'warn',
    },
  },
])
