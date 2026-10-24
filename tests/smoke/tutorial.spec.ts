/**
 * 使用教程静态页冒烟（0.4.1 补丁）
 *
 * 教程入口接线在 main 的原生右键/托盘菜单里；Playwright 无法直接点击 native menu，
 * 因此这里由测试在主进程创建普通 BrowserWindow 直接加载构建产物
 * `out/renderer/tutorial.html`，验证教程页本身：标题、h1、5 组 section、关闭按钮、
 * 无 `window.pet`/Node 能力也能正常渲染、关闭后窗口销毁。
 * 菜单接线（右键 + 托盘「使用教程…」）由人工/代码检查覆盖（docs/qa-checklist §10）。
 *
 * 与产品 tutorial-window 一致：无 preload、无 IPC 角色、nodeIntegration=false。
 * 本机 DSH 沙箱内 Electron 无法启动（spawn EPERM），由宿主执行 `pnpm smoke`。
 */
import { resolve } from 'node:path'

import { expect, test } from './fixtures'

const TUTORIAL_FILE = resolve(__dirname, '../../out/renderer/tutorial.html')

test('教程静态页：主进程窗口加载 tutorial.html，标题/h1/5 组/关闭可用且无 window.pet', async ({
  petApp,
  petPage,
}) => {
  await expect(petPage.locator('.pet-sprite')).toBeVisible()

  const opened = petApp.waitForEvent('window')
  await petApp.evaluate(async ({ BrowserWindow }, filePath) => {
    const win = new BrowserWindow({
      width: 560,
      height: 620,
      show: false,
      title: '使用教程 · 鲸鱼娘',
      webPreferences: {
        // 与产品 tutorial-window 一致：静态页，无 preload/Node/沙箱桥；
        // 保持 sandbox + contextIsolation，只加载本地静态页面。
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
      },
    })
    win.setMenu(null)
    await win.loadFile(filePath)
    win.show()
  }, TUTORIAL_FILE)
  const tutorial = await opened

  try {
    // 窗口标题（native）与页面 title 都含「使用教程」
    await expect(tutorial).toHaveTitle(/使用教程/)
    await expect
      .poll(async () =>
        petApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((win) => win.webContents.getURL().includes('tutorial.html'))
            ?.getTitle(),
        ),
      )
      .toContain('使用教程')

    // h1 + 5 组 h2（顺序与标题固定）
    await expect(tutorial.getByRole('heading', { level: 1, name: '使用教程' })).toBeVisible()
    await expect(tutorial.getByRole('heading', { level: 2 })).toHaveCount(5)
    for (const name of ['桌宠操作', '清单与项目', '搁置与完成', '独立打卡', '提醒与恢复']) {
      await expect(tutorial.getByRole('heading', { level: 2, name, exact: true })).toBeVisible()
    }
    // 目录 5 条 + 5 张 section 卡 + 实际内容已渲染
    await expect(
      tutorial.getByRole('navigation', { name: '教程目录' }).getByRole('link'),
    ).toHaveCount(5)
    await expect(tutorial.locator('section.tutorial-card')).toHaveCount(5)
    await expect(tutorial.getByText(/再次点击已选分类可取消/)).toBeVisible()
    // 「免打扰与隐藏」是当前条目标签；正文也含“免打扰”，用 exact 限定标签。
    await expect(tutorial.getByText('免打扰与隐藏', { exact: true })).toBeVisible()
    await expect(tutorial.getByText('5 组要点，约 2 分钟读完')).toBeVisible()

    // 纯静态页：没有 preload 注入的 window.pet API，也没有 Node require。
    // 注意：教程 section 的 id（如历史 id="pet"）会被浏览器映射成 window.pet（DOM named access），
    // 不能仅凭 typeof window.pet === 'undefined' 判断 preload 是否存在；以“无 bootstrap API”为准。
    const preloadProbe = await tutorial.evaluate(() => {
      const candidate = (globalThis as unknown as { pet?: { bootstrap?: unknown } }).pet
      return {
        hasBootstrap: typeof candidate?.bootstrap === 'function',
        requireType: typeof (globalThis as unknown as { require?: unknown }).require,
      }
    })
    expect(preloadProbe.hasBootstrap).toBe(false)
    expect(preloadProbe.requireType).toBe('undefined')

    // 「关闭教程」按钮可用 → 关闭窗口并销毁
    const closeButton = tutorial.getByRole('button', { name: '关闭教程', exact: true })
    await expect(closeButton).toBeEnabled()
    const closed = tutorial.waitForEvent('close')
    await closeButton.click()
    await closed
    await expect
      .poll(() =>
        petApp.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().filter(
              (win) => !win.isDestroyed() && win.webContents.getURL().includes('tutorial.html'),
            ).length,
        ),
      )
      .toBe(0)
  } finally {
    // 失败时清理测试创建的窗口，避免污染 fixtures 的 app 生命周期
    await petApp.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && win.webContents.getURL().includes('tutorial.html')) {
          win.destroy()
        }
      }
    })
  }
})
