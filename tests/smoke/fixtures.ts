import { _electron as electron, expect, test as base } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const test = base.extend<{ petApp: ElectronApplication; petPage: Page }>({
  petApp: async ({ playwright: _playwright }, use) => {
    const profile = await mkdtemp(join(tmpdir(), 'whale-pet-regression-'))
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value
    }
    env['APPDATA'] = profile
    env['LOCALAPPDATA'] = profile
    delete env['ELECTRON_RUN_AS_NODE']
    delete env['ELECTRON_RENDERER_URL']
    delete env['WHALE_PET_HIT_TRACE']
    let app: ElectronApplication | undefined
    try {
      app = await electron.launch({
        args: [resolve(__dirname, '../../out/main/index.js'), `--user-data-dir=${profile}`],
        env,
      })
      await use(app)
    } finally {
      try {
        if (app !== undefined) await app.close()
      } finally {
        await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      }
    }
  },
  petPage: async ({ petApp }, use) => {
    const page = await petApp.firstWindow()
    await expect(page.locator('.pet-sprite')).toBeVisible()
    await use(page)
  },
})

export { expect }
