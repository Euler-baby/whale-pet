import type { PetApi } from '../../src/shared/ipc'
import { expect, test } from './fixtures'

const captureDir =
  process.env['WHALE_CAPTURE_ACTIONS_DIR'] ?? 'docs/validation/tasks-20261023-0331-timing'

test('长按摸头与普通点击分开，命中盒尺寸保持静止', async ({ petPage }) => {
  const sprite = petPage.locator('.pet-sprite')
  await petPage.evaluate(() => {
    interface ElementLike {
      dataset: Record<string, string | undefined>
      getBoundingClientRect(): { width: number; height: number }
    }
    const browser = globalThis as unknown as {
      document: { querySelector(selector: string): ElementLike | null }
      MutationObserver: new (callback: () => void) => {
        observe(target: ElementLike, options: unknown): void
      }
    }
    const visual = browser.document.querySelector('.pet-sprite__visual')
    const button = browser.document.querySelector('.pet-sprite')
    if (!visual || !button) throw new Error('精灵未显示')
    visual.dataset['transitionCount'] = '0'
    visual.dataset['hitBoxStable'] = 'true'
    new browser.MutationObserver(() => {
      if (visual.dataset['transitioning'] !== 'true') return
      visual.dataset['transitionCount'] = String(Number(visual.dataset['transitionCount']) + 1)
      const bounds = button.getBoundingClientRect()
      if (bounds.width !== 240 || bounds.height !== 240) visual.dataset['hitBoxStable'] = 'false'
    }).observe(visual, { attributes: true, attributeFilter: ['data-transitioning'] })
  })
  const bounds = await sprite.boundingBox()
  expect(bounds?.width).toBe(240)
  expect(bounds?.height).toBe(240)
  await sprite.click()
  await expect(sprite).toHaveAttribute('data-action', '')
  const point = await sprite.boundingBox()
  if (!point) throw new Error('精灵未显示')
  await petPage.mouse.move(point.x + 120, point.y + 120)
  await petPage.mouse.down()
  await expect(sprite).toHaveAttribute('data-action', 'pat')
  if (process.env['WHALE_CAPTURE_ACTIONS'] === '1') {
    await petPage.waitForTimeout(440)
    await petPage.screenshot({ path: `${captureDir}/pat.png` })
  }
  await petPage.mouse.up()
  await expect(sprite).toHaveAttribute('data-action', '', { timeout: 4000 })
  expect((await sprite.boundingBox())?.width).toBe(240)
  await expect(sprite.locator('.pet-sprite__visual')).toHaveAttribute('data-hit-box-stable', 'true')
  const count = await sprite.locator('.pet-sprite__visual').getAttribute('data-transition-count')
  expect(Number(count)).toBeGreaterThanOrEqual(2)
})

test('完成任务播放庆祝，新增紧急任务只播放一次担心', async ({ petPage }) => {
  const sprite = petPage.locator('.pet-sprite')
  await petPage.evaluate(async () => {
    await (globalThis as unknown as { pet: PetApi }).pet.setVisible(true)
  })
  const id = await petPage.evaluate(async () => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    return (await pet.createTask({ title: '动作完成回归' })).id
  })
  // Main emits before the IPC reply; capture both events and DOM while the call is active.
  const eventTypes = await petPage.evaluate(async (taskId) => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    const events: string[] = []
    const stop = pet.onEvent((event) => events.push(event.type))
    const task = await pet.toggleTask({ id: taskId })
    await new Promise((resolve) => setTimeout(resolve, 200))
    stop()
    return { events, status: task.status }
  }, id)
  expect(eventTypes).toMatchObject({ status: 'done' })
  expect(eventTypes.events).toContain('pet-action')
  await expect(sprite).toHaveAttribute('data-action', 'celebrate')
  if (process.env['WHALE_CAPTURE_ACTIONS'] === '1') {
    await petPage.waitForTimeout(300)
    await petPage.screenshot({ path: `${captureDir}/celebrate.png` })
  }
  await expect(sprite).toHaveAttribute('data-action', '', { timeout: 4000 })
  await Promise.all([
    expect(sprite).toHaveAttribute('data-action', 'concern'),
    petPage.evaluate(async () => {
      await (globalThis as unknown as { pet: PetApi }).pet.createTask({
        title: '动作紧急回归',
        importance: 'urgent',
      })
    }),
  ])
  await expect(sprite).toHaveAttribute('data-action', '', { timeout: 4000 })
  await petPage.waitForTimeout(1200)
  await expect(sprite).toHaveAttribute('data-action', '')
})

test('减少动态效果使用静态帧，HUD 仍可点击', async ({ petPage }) => {
  await petPage.emulateMedia({ reducedMotion: 'reduce' })
  const sprite = petPage.locator('.pet-sprite')
  await expect(sprite).toHaveAttribute('data-static', 'true')
  const id = await petPage.evaluate(async () => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    return (await pet.createTask({ title: '静态动作紧急', importance: 'urgent' })).id
  })
  await expect(sprite).toHaveAttribute('data-action', 'concern')
  if (process.env['WHALE_CAPTURE_ACTIONS'] === '1')
    await petPage.screenshot({ path: `${captureDir}/concern.png` })
  await expect(sprite.locator('img')).toHaveAttribute('src', /concern.*png/)
  if (process.env['WHALE_CAPTURE_ACTIONS'] === '1')
    await petPage.screenshot({ path: `${captureDir}/reduced-motion.png` })
  await expect(petPage.getByRole('region', { name: '紧急任务 HUD' })).toBeVisible()
  await petPage.evaluate(async (taskId) => {
    await (globalThis as unknown as { pet: PetApi }).pet.toggleTask({ id: taskId })
  }, id)
})
