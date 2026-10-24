import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('隐藏启动完成后仍不显示；显式显示及关闭隐藏均可恢复', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'whale-pet-startup-'))
  let application: ElectronApplication | null = null
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env['APPDATA'] = profile
  env['LOCALAPPDATA'] = profile
  delete env['ELECTRON_RUN_AS_NODE']
  try {
    application = await electron.launch({
      args: [
        resolve(__dirname, '../../out/main/index.js'),
        `--user-data-dir=${profile}`,
        '--hidden',
      ],
      env,
    })
    const page = await application.firstWindow()
    await page.waitForLoadState('load')
    await expect(page.locator('.pet-sprite')).toHaveCount(1)
    // 留出异步 ready-to-show 首次绘制时间，防止仅检查初始 show:false 的假通过。
    await page.waitForTimeout(500)
    const initial = await application.evaluate(({ app, BrowserWindow }) => ({
      userData: app.getPath('userData'),
      visible: BrowserWindow.getAllWindows()[0]?.isVisible(),
    }))
    expect(initial.userData).toBe(profile)
    expect(initial.visible).toBe(false)
    await expect(page.locator('.pet-sprite__body')).toHaveAttribute('data-animation-paused', 'true')

    await page.evaluate(async () => {
      const pet = (
        globalThis as unknown as { pet: { setVisible: (visible: boolean) => Promise<void> } }
      ).pet
      await pet.setVisible(true)
    })
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.isVisible(),
      ),
    ).toBe(true)

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    expect(
      await application.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        return { exists: win !== undefined && !win.isDestroyed(), visible: win?.isVisible() }
      }),
    ).toEqual({ exists: true, visible: false })
  } finally {
    try {
      if (application !== null) await application.close()
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    }
  }
})
