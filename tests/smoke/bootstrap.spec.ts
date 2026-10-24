/**
 * v1 冒烟：窗口存在 + `window.pet.bootstrap()` 返回契约 2.0 数据 + 设置读写 + 退出
 *
 * 这是「preload CJS 注入成功 + IPC 契约可用 + JSON 设置可写」的机器证据：
 * - 若 preload 生成 ESM / 引用了第三方 require，`window.pet` 为 undefined → 用例失败
 * - 若 main 未注册 app:bootstrap / settings:*，invoke 会报错 → 用例失败
 *
 * 隔离：`--user-data-dir` + 临时 APPDATA/LOCALAPPDATA。
 * 清理：启动失败时 `app` 仍为 null，afterAll 必须保护（Codex 报告 06 §2 的缺陷）。
 * 运行前置：`pnpm build`（产物 out/main/index.js、out/preload/index.js）。
 */
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

interface BootstrapLike {
  ipcVersion: string
  now: number
  spriteState: string
  settings: {
    autostart: boolean
    muted: boolean
    reminderLeadMin: number
    customReminderLeadMin: number | null
    hudScope: string
  }
  autostartSupported: boolean
  windowVisible: boolean
  clickThrough: boolean
  placement: { bounds: { x: number; y: number; width: number; height: number } } | null
  /** 契约 1.9（0.3.2）：HUD 当前状态（最多 3 条 + 总数 + 排队角标） */
  urgentTasks: {
    tasks: Array<{
      id: string
      title: string
      dueAt: number | null
      importance: string
      category: string | null
      projectName: string | null
    }>
    total: number
    queued: number
  }
}

const ROOT = resolve(__dirname, '../..')
const MAIN_ENTRY = join(ROOT, 'out', 'main', 'index.js')

/** 只保留已定义的 env（Electron 子进程用） */
function electronEnv(testAppData: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env['APPDATA'] = testAppData
  env['LOCALAPPDATA'] = testAppData
  // DSH 环境变量 ELECTRON_RUN_AS_NODE=1 会让 Electron 以纯 Node 运行（无窗口）
  delete env['ELECTRON_RUN_AS_NODE']
  return env
}

let app: ElectronApplication | null = null
let page: Page | null = null
let testAppData = ''

function requireApp(): ElectronApplication {
  if (app === null) throw new Error('Electron 未启动成功，无法执行该用例')
  return app
}

function requirePage(): Page {
  if (page === null) throw new Error('窗口未创建，无法执行该用例')
  return page
}

test.beforeAll(async () => {
  testAppData = await mkdtemp(join(tmpdir(), 'whale-pet-smoke-'))
  app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${testAppData}`],
    env: electronEnv(testAppData),
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  try {
    if (app !== null) await app.close()
  } finally {
    if (testAppData !== '') {
      await rm(testAppData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    }
  }
})

test('① 窗口存在且可见', async () => {
  const application = requireApp()
  const currentPage = requirePage()
  expect(application.windows().length).toBeGreaterThan(0)

  // firstWindow() means the page exists, not that ready-to-show has fired.
  await expect
    .poll(
      () =>
        application.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0]
          return win !== undefined && !win.isDestroyed() && win.isVisible()
        }),
      { message: 'BrowserWindow 应在 ready-to-show 后可见' },
    )
    .toBe(true)

  // renderer 页面已加载（透明窗黑底兜底不影响 DOM）
  await expect.poll(() => currentPage.url()).not.toBe('about:blank')

  // 尺寸判据（docs/05 §2.1）：内容区严格 320×400 DIP；外框允许 ≤1 DIP 的 DWM/边框差异
  const size = await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win === undefined || win.isDestroyed()) return null
    return { content: win.getContentBounds(), outer: win.getBounds() }
  })
  expect(size, 'BrowserWindow 应可读取 bounds').not.toBeNull()
  expect(size?.content.width).toBe(320)
  expect(size?.content.height).toBe(400)
  expect(Math.abs((size?.outer.width ?? 0) - 320)).toBeLessThanOrEqual(1)
  expect(Math.abs((size?.outer.height ?? 0) - 400)).toBeLessThanOrEqual(1)

  // renderer CSS 视口 = 内容区（DIP）
  const viewport = await currentPage.evaluate(() => {
    const view = globalThis as unknown as { innerWidth: number; innerHeight: number }
    return { w: view.innerWidth, h: view.innerHeight }
  })
  expect(viewport.w).toBe(320)
  expect(viewport.h).toBe(400)
})

test('② window.pet.bootstrap() 返回契约 2.0 数据', async () => {
  const result = await requirePage().evaluate(async (): Promise<BootstrapLike | null> => {
    // 页面上下文没有 DOM 类型（tsconfig.node 的 lib 为 ES2023），用 globalThis 取 preload 注入的 API
    const pet = (globalThis as unknown as { pet?: { bootstrap: () => Promise<BootstrapLike> } }).pet
    if (pet === undefined) return null
    return pet.bootstrap()
  })

  expect(
    result,
    'window.pet 必须由 preload 注入；若为 null 检查 out/preload/index.js 是否为 CJS 且无第三方 require',
  ).not.toBeNull()
  const bootstrap = result as BootstrapLike

  expect(bootstrap.ipcVersion).toBe('2.0.0')
  expect(typeof bootstrap.now).toBe('number')
  expect(bootstrap.spriteState).toBe('idle')
  // 契约 2.0：settings 含 reminderLeadMin（15）/customReminderLeadMin（默认 null）/hudScope（urgent）
  expect(bootstrap.settings).toEqual({
    autostart: false,
    muted: false,
    reminderLeadMin: 15,
    customReminderLeadMin: null,
    hudScope: 'urgent',
  })
  // 无紧急任务时 HUD 状态为空
  expect(bootstrap.urgentTasks).toEqual({ tasks: [], total: 0, queued: 0 })
  // dev/测试运行不是安装版：自启不可写注册表，但设置值仍可保存
  expect(bootstrap.autostartSupported).toBe(false)
  expect(bootstrap.windowVisible).toBe(true)
  expect(typeof bootstrap.clickThrough).toBe('boolean')
  expect(bootstrap.placement === null || typeof bootstrap.placement === 'object').toBe(true)
})

test('③ 设置读写：updateSettings 写入后 getSettings 可读回', async () => {
  const result = await requirePage().evaluate(async () => {
    const pet = (
      globalThis as unknown as {
        pet: {
          updateSettings: (patch: {
            muted?: boolean
            reminderLeadMin?: number
            customReminderLeadMin?: number | null
            hudScope?: string
          }) => Promise<unknown>
          getSettings: () => Promise<{
            muted: boolean
            reminderLeadMin: number
            customReminderLeadMin: number | null
            hudScope: string
          }>
        }
      }
    ).pet
    await pet.updateSettings({
      muted: true,
      reminderLeadMin: 30,
      customReminderLeadMin: 45,
      hudScope: 'urgent-due',
    })
    return pet.getSettings()
  })
  expect(result.muted).toBe(true)
  expect(result.reminderLeadMin).toBe(30)
  expect(result.customReminderLeadMin).toBe(45)
  expect(result.hudScope).toBe('urgent-due')
})

test('④ 设置变更广播：updateSettings 后 renderer 收到 settings 事件', async () => {
  const result = await requirePage().evaluate(async () => {
    const pet = (
      globalThis as unknown as {
        pet: {
          onEvent: (
            listener: (event: { type: string; settings?: { muted: boolean } }) => void,
          ) => () => void
          updateSettings: (patch: { muted?: boolean }) => Promise<unknown>
        }
      }
    ).pet
    return await new Promise<boolean>((resolve) => {
      const off = pet.onEvent((event) => {
        if (event.type === 'settings' && event.settings?.muted === true) {
          off()
          resolve(true)
        }
      })
      void pet.updateSettings({ muted: true })
    })
  })
  expect(result, '设置变更必须广播到窗口（docs/16 反向同步）').toBe(true)
})

test('⑤ IPC 2.0 API 形状：新增 tasks:set-archived/habits×6，旧 tasks:checkin 彻底移除', async () => {
  const result = await requirePage().evaluate(async () => {
    const pet = (globalThis as unknown as { pet: Record<string, unknown> }).pet
    const keys = Object.keys(pet).sort()
    return {
      keys,
      hasOldCheckin: 'checkinDay' in pet,
      hasSetArchived: typeof pet['setTaskArchived'] === 'function',
      hasHabits: [
        'listHabits',
        'createHabit',
        'updateHabit',
        'deleteHabit',
        'checkinHabit',
        'listHabitHistory',
      ].every((name) => typeof pet[name] === 'function'),
    }
  })
  expect(result.hasOldCheckin).toBe(false)
  expect(result.keys).not.toContain('checkinDay')
  expect(result.hasSetArchived).toBe(true)
  expect(result.hasHabits).toBe(true)
  // 24 条旧 invoke 名称中仅删除 tasks:checkin；新增 archive+habits 后共 31
  for (const name of [
    'listTasks',
    'createTask',
    'updateTask',
    'toggleTask',
    'deleteTask',
    'getTaskStats',
    'restoreTask',
    'listProjects',
    'createProject',
    'updateProject',
    'deleteProject',
    'setTaskArchived',
  ]) {
    expect(result.keys).toContain(name)
  }
})

test('⑥ 点击精灵触发本地台词（pointer capture 在按钮上，click 路由不被劫持）', async () => {
  const currentPage = requirePage()
  // Continuous breathing prevents Playwright's actionability stability check.
  // Use the existing reduced-motion CSS for this routing test; native-input
  // acceptance separately exercises the animated sprite.
  await currentPage.emulateMedia({ reducedMotion: 'reduce' })
  try {
    await expect(currentPage.locator('.pet-sprite')).toBeVisible()
    await currentPage.locator('.pet-sprite').click()
    // 点击后进入 happy（3s 后回落），气泡显示本地台词
    await expect(currentPage.locator('.pet-sprite--happy')).toHaveCount(1)
    await expect(currentPage.locator('.bubble')).toBeVisible()
  } finally {
    await currentPage.emulateMedia({ reducedMotion: null })
  }
})

test('⑦ 精灵底边点击到达按钮（气泡尖角不抢点击，docs/13 回归）', async () => {
  const currentPage = requirePage()
  const sprite = currentPage.locator('.pet-sprite')

  // 等 ⑤ 的 happy 回落，避免用“已经 happy”误判
  await expect
    .poll(async () => (await sprite.getAttribute('class')) ?? '')
    .not.toMatch(/pet-sprite--happy/)

  const box = await sprite.boundingBox()
  if (box === null) throw new Error('无法获取精灵包围盒')
  // 底边内 2px：与气泡尖角（bubble::before，top:-5px）重叠的区域
  await currentPage.mouse.click(box.x + box.width / 2, box.y + box.height - 2)
  await expect(currentPage.locator('.pet-sprite--happy')).toHaveCount(1)
})

test('⑧ 关闭应用后进程退出（退出无残留）', async () => {
  const application = requireApp()
  const pid = application.process().pid
  if (pid === undefined) throw new Error('Electron 子进程缺少 pid')
  await application.close()
  app = null
  expect(pid).toBeGreaterThan(0)
})
