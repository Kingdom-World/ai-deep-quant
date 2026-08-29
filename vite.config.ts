import { defineConfig } from 'vite'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

// vite-plugin-compression 为 CJS 包，用 createRequire 兼容 nodenext 解析
const require = createRequire(import.meta.url)
const compression = require('vite-plugin-compression')

// 从 .env 读取站点密码，开发代理自动附带认证头（后端启用 Basic Auth 时 dev 模式仍可用）
function readEnvVar(name: string): string {
  try {
    const raw = readFileSync(new URL('./.env', import.meta.url), 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)\\s*$`))
      if (m) return m[1].replace(/^["']|["']$/g, '')
    }
  } catch {
    /* 无 .env 时忽略 */
  }
  return ''
}
const siteUser = process.env.SITE_USERNAME || readEnvVar('SITE_USERNAME') || 'admin'
const sitePass = process.env.SITE_PASSWORD || readEnvVar('SITE_PASSWORD')
const devAuthHeaders = sitePass
  ? { Authorization: `Basic ${Buffer.from(`${siteUser}:${sitePass}`).toString('base64')}` }
  : {}

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
    // 前端 /api 请求代理到后端（Node: 3001 / Python-Flask: 5000，由 VITE_API_TARGET 控制）
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:3001',
        changeOrigin: true,
        headers: devAuthHeaders,
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
