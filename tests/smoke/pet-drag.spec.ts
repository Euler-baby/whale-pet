/**
 * 桌宠拖拽边界冒烟（0.4.2：允许拖到屏幕最底边覆盖任务栏，至少整窗可见）
 *
 * 可自动部分：通过 `pet.moveBy` 走真实 drag→clamp 路径（display.bounds，含任务栏区域），
 * 断言窗口整窗落在目标屏幕内、底部能贴到 display.bounds 底边（若有任务栏则越过 workArea 底边）、
 * 顶部/左侧钳制、拖到屏幕底部后精灵仍可点击、`resetPosition` 回主屏工作区右下角。
 * 宿主人工项：任务栏遮挡/自动隐藏任务栏、点击穿透、多屏/DPI、拖拽手感与位置记忆重启，
 * 见 docs/qa-checklist §11。
 *
 * 本机 DSH 沙箱内 Electron 无法启动（spawn EPERM），由宿主执行 `pnpm smoke`。
 */
import type { PetApi } from '../../src/shared/ipc'
import { expect, test } from './fixtures'

interface WindowSnapshot {
  bounds: { x: number; y: number; width: number; height: number }
  displayBounds: { x: number; y: number; width: number; height: number }
  workArea: { x: number; y: number; width: number; height: number }
}

test('拖拽到底边可覆盖任务栏且整窗可见；顶部钳制；重置回主屏工作区', async ({
  petApp,
  petPage,
}) => {
  await expect(petPage.locator('.pet-sprite')).toBeVisible()

  const snapshot = (): Promise<WindowSnapshot> =>
    petApp.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find((entry) =>
        entry.webContents.getURL().includes('index.html'),
      )
      if (win === undefined) throw new Error('宠物窗口不存在')
      const bounds = win.getBounds()
      const display = screen.getDisplayNearestPoint({
        x: bounds.x + Math.floor(bounds.width / 2),
        y: bounds.y + Math.floor(bounds.height / 2),
      })
      return {
        bounds,
        displayBounds: display.bounds,
        workArea: display.workArea,
      }
    })

  // 向下拖到远超屏幕：clamp 到 display.bounds 底边（允许覆盖任务栏）
  await petPage.evaluate(() => (globalThis as unknown as { pet: PetApi }).pet.moveBy(0, 10000))
  const bottom = await snapshot()
  const b = bottom.bounds
  const db = bottom.displayBounds
  const wa = bottom.workArea
  expect(b.x).toBeGreaterThanOrEqual(db.x - 1)
  expect(b.x + b.width).toBeLessThanOrEqual(db.x + db.width + 1)
  expect(b.y).toBeGreaterThanOrEqual(db.y - 1)
  expect(b.y + b.height).toBeLessThanOrEqual(db.y + db.height + 1)
  // 贴底：窗口底边 = 屏幕底边（允许 1 DIP 误差），而不是被任务栏顶边挡住
  expect(b.y + b.height).toBeGreaterThanOrEqual(db.y + db.height - 2)
  // 若任务栏在底部（workArea 比 bounds 矮），窗口确实覆盖任务栏区域
  if (wa.y + wa.height < db.y + db.height) {
    expect(b.y + b.height).toBeGreaterThan(wa.y + wa.height)
  }
  // 拖到屏幕底部后精灵仍完整可见、可交互
  await expect(petPage.locator('.pet-sprite')).toBeVisible()
  await petPage.locator('.pet-sprite').click()
  await expect(petPage.locator('.pet-sprite--happy')).toHaveCount(1)

  // 向左上拖到远超屏幕：clamp 到 display.bounds 左上角，整窗可见
  await petPage.evaluate(() =>
    (globalThis as unknown as { pet: PetApi }).pet.moveBy(-10000, -10000),
  )
  const top = await snapshot()
  expect(top.bounds.x).toBeGreaterThanOrEqual(top.displayBounds.x - 1)
  expect(top.bounds.y).toBeGreaterThanOrEqual(top.displayBounds.y - 1)
  expect(top.bounds.x).toBeLessThanOrEqual(top.displayBounds.x + 1)
  expect(top.bounds.y).toBeLessThanOrEqual(top.displayBounds.y + 1)

  // 重置位置：回主屏 workArea 右下角，不覆盖任务栏
  await petPage.evaluate(() => (globalThis as unknown as { pet: PetApi }).pet.resetPosition())
  const reset = await petApp.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows().find((entry) =>
      entry.webContents.getURL().includes('index.html'),
    )
    if (win === undefined) throw new Error('宠物窗口不存在')
    return { bounds: win.getBounds(), workArea: screen.getPrimaryDisplay().workArea }
  })
  const r = reset.bounds
  const primary = reset.workArea
  expect(r.x).toBeGreaterThanOrEqual(primary.x - 1)
  expect(r.y).toBeGreaterThanOrEqual(primary.y - 1)
  expect(r.x + r.width).toBeLessThanOrEqual(primary.x + primary.width + 1)
  expect(r.y + r.height).toBeLessThanOrEqual(primary.y + primary.height + 1)
})
