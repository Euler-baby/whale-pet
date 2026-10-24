import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * electron-vite 三端构建配置（Lead 维护）
 * - main：CJS，Node 环境；dependencies 外置（better-sqlite3 / zod）
 * - preload：必须是 CJS（A5：sandbox:true 不支持 ESM preload），产物 out/preload/index.js
 * - renderer：React + Vite，产物 out/renderer/index.html
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main'),
      },
    },
  },
  preload: {
    // 不要 externalize 依赖：sandbox:true 的 preload 不能 require 任意模块。
    // preload 只 import 契约里的通道常量/类型；zod 会打进 bundle（不产生运行时 require）。
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      // A5：preload 强制 CJS；package.json 无 "type": "module"，因此 .js 即 CJS
      // electron-vite v6 默认 externalizeDeps=true 会把 dependencies（zod）外置成 require("zod")，
      // 而 sandbox:true 的 preload 只能 require('electron') —— 必须关掉，让依赖打进 bundle。
      externalizeDeps: false,
      rollupOptions: {
        output: {
          format: 'cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        // 多入口（docs/05 §5 seam 4）：pet 窗 + settings 普通窗；以后追加 workspace 只需加 key
        input: {
          index: resolve('src/renderer/index.html'),
          settings: resolve('src/renderer/settings.html'),
          tasks: resolve('src/renderer/tasks.html'),
          tutorial: resolve('src/renderer/tutorial.html'),
        },
      },
    },
  },
})
