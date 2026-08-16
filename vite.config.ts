import { defineConfig } from 'vite'
import { createRequire } from 'node:module'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

// vite-plugin-compression 为 CJS 包，用 createRequire 兼容 nodenext 解析
const require = createRequire(import.meta.url)
const compression = require('vite-plugin-compression')

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    // 生产环境 gzip 压缩（.gz 文件；兼容无 gzip 的场景自动回退）
    compression({
      threshold: 10240, // 10KB 以上才压缩
      algorithm: 'gzip',
      ext: '.gz',
      deleteOriginFile: false,
    }),
  ],
  server: {
    // 前端 /api 请求代理到独立数据服务（解决跨域 + 局域网统一入口）
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
    // 忽略编辑器临时文件，避免 watcher EBUSY 崩溃
    watch: {
      ignored: ['**/.tmpdir/**', '**/*.tmp', '**/*.mjs'],
    },
  },
  build: {
    // 代码分割（vite 8 / rolldown：advancedChunks 按需分包）
    rollupOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: 'echarts', test: /node_modules[\\/]echarts/ },
            { name: 'react-vendor', test: /node_modules[\\/](react|react-dom|react-router-dom|scheduler)/ },
          ],
        },
      },
    },
  },
})
