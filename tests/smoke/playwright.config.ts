import { defineConfig } from '@playwright/test'

/**
 * Electron 集成与回归测试
 *
 * 运行：pnpm build && pnpm smoke
 * - 用 Playwright `_electron` 启动构建产物，验证窗口、设置、权限、动画与隐藏启动
 * - 当前设置使用 JSON；无 SQLite 原生依赖或 rebuild 前置步骤
 * - 每个测试使用独立 user-data-dir / APPDATA，避免污染真实用户数据
 */
export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts$/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env['CI'],
  reporter: [['list'], ['html', { open: 'never' }]],
  outputDir: '../../test-results',
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})
