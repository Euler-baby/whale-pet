import { resolve } from 'node:path'

import { defineConfig } from 'vitest/config'

/**
 * 单测入口：tests/unit/**\/*.test.ts
 * - 只跑纯函数与 Node 侧逻辑（不加载 Electron-ABI 原生模块，见 ADR-0002）
 * - DB 集成测试后续走 `_electron`/Playwright 运行时，不在本配置内
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // 纯函数单测无共享状态：threads 比 forks 轻，且在受限环境（无 piped stdio/fork 权限）可跑
    pool: 'threads',
    clearMocks: true,
  },
})
