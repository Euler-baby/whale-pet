import type { ElectronApplication, Page } from '@playwright/test'

import type { SpriteState } from '../../src/shared/types'
import { expect, test } from './fixtures'

async function setState(app: ElectronApplication, state: SpriteState): Promise<void> {
  await app.evaluate(({ BrowserWindow }, state) => {
    const win = BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().endsWith('/index.html'),
    )
    if (win === undefined) throw new Error('宠物窗口不存在')
    win.webContents.send('pet:event', { type: 'pet-state', spriteState: state })
  }, state)
}

async function imageReady(page: Page, extension: 'webp' | 'png'): Promise<void> {
  const image = page.locator('.pet-sprite__image')
  await expect(image).toHaveAttribute('src', new RegExp(`\\.${extension}$`))
  await expect
    .poll(() =>
      image.evaluate((element) => {
        const image = element as unknown as {
          complete: boolean
          naturalWidth: number
          naturalHeight: number
        }
        return image.complete && image.naturalWidth === 480 && image.naturalHeight === 480
      }),
    )
    .toBe(true)
}

test('三态精灵可解码、命中盒固定，减少动态效果切静态并停止CSS动画', async ({ petApp, petPage }) => {
  await petPage.emulateMedia({ reducedMotion: 'no-preference' })
  for (const state of ['idle', 'happy', 'sleepy'] as const) {
    await setState(petApp, state)
    await expect(petPage.locator(`.pet-sprite--${state}`)).toHaveCount(1)
    await imageReady(petPage, 'webp')
    expect(await petPage.locator('.pet-sprite').boundingBox()).toEqual({
      x: 40,
      y: 4,
      width: 240,
      height: 240,
    })
    await petPage.emulateMedia({ reducedMotion: 'reduce' })
    await imageReady(petPage, 'png')
    const animation = await petPage.locator('.pet-sprite__body').evaluate((element) => {
      const view = globalThis as unknown as {
        getComputedStyle: (element: unknown) => { animationName: string }
      }
      return view.getComputedStyle(element).animationName
    })
    expect(animation).toBe('none')
    await petPage.emulateMedia({ reducedMotion: 'no-preference' })
  }

  // Eliminate CSS movement as a false positive: only WebP frame changes may
  // change these screenshots. Sleepy frames last 900ms, avoiding idle's short blink.
  const css = await petPage.addStyleTag({
    content:
      '.pet-sprite__body { animation: none !important; } .bubble-area { visibility: hidden !important; }',
  })
  try {
    await imageReady(petPage, 'webp')
    const first = await petPage.locator('.pet-sprite').screenshot()
    await expect
      .poll(async () => !first.equals(await petPage.locator('.pet-sprite').screenshot()), {
        timeout: 6000,
        intervals: [200, 300, 400],
      })
      .toBe(true)
  } finally {
    await css.evaluate((element) => element.remove())
  }
})

test('图片失败后切静态可恢复，隐藏窗口暂停并在显示后继续', async ({ petApp, petPage }) => {
  await petPage.emulateMedia({ reducedMotion: 'no-preference' })
  await imageReady(petPage, 'webp')
  await petPage.locator('.pet-sprite__image').dispatchEvent('error')
  await expect(petPage.locator('.pet-sprite__fallback')).toHaveCount(1)
  await petPage.emulateMedia({ reducedMotion: 'reduce' })
  await imageReady(petPage, 'png')
  await expect(petPage.locator('.pet-sprite__fallback')).toHaveCount(0)
  await petPage.emulateMedia({ reducedMotion: 'no-preference' })
  await imageReady(petPage, 'webp')

  try {
    await petApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide())
    expect(
      await petApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()),
    ).toBe(false)
    await expect(petPage.locator('.pet-sprite__body')).toHaveAttribute(
      'data-animation-paused',
      'true',
    )
    await imageReady(petPage, 'png')
    const playState = await petPage.locator('.pet-sprite__body').evaluate((element) => {
      const view = globalThis as unknown as {
        getComputedStyle: (element: unknown) => { animationPlayState: string }
      }
      return view.getComputedStyle(element).animationPlayState
    })
    expect(playState).toBe('paused')
  } finally {
    await petApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show())
  }
  await expect(petPage.locator('.pet-sprite__body')).toHaveAttribute(
    'data-animation-paused',
    'false',
  )
  await imageReady(petPage, 'webp')
})
