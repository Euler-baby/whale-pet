/**
 * HUD / 提醒冒烟（契约 1.9；0.3.2 docs/25 §7）
 *
 * HUD 由 main 计算（Bootstrap.urgentTasks / `pet:event.tasks-urgent`），宠物窗只展示；
 * 用例通过 `page.evaluate` 调真实 IPC 建任务/改设置触发 main 事件，再断言宠物窗 DOM，
 * 不新增产品通道、不复刻 main 的 HUD 逻辑。
 *
 * 时序注意：任务提醒 tick 固定 30 秒（启动立即跑一次），涉及「排队角标/汇总/提前量」的
 * 用例要等下一 tick（≤30s，已设较长超时）；免打扰 23:00–07:00 的完整时序由 task-reminder
 * 单测覆盖，smoke 在 DND 时段跳过需要普通提醒的用例。5/15/30/60 提前量边界与 DND 判定
 * 主要靠单测，这里只验证 5 分钟档的真实触发。
 *
 * 本机 DSH 沙箱内 Electron 无法启动（spawn EPERM），这些用例由宿主执行 `pnpm smoke`。
 */
import type { Locator, Page } from '@playwright/test'

import type { PetApi } from '../../src/shared/ipc'
import type { UrgentTasksState } from '../../src/shared/types'
import { expect, test } from './fixtures'

interface HudBootstrap {
  ipcVersion: string
  settings: { hudScope: string; reminderLeadMin: number }
  urgentTasks: UrgentTasksState
}

interface TaskSeedInput {
  title: string
  importance?: 'urgent' | 'high' | 'normal' | 'low'
  dueAt?: number | null
  projectId?: string
}

function hud(page: Page): Locator {
  return page.getByRole('region', { name: '紧急任务 HUD' })
}

/** 免打扰固定 23:00–07:00（0.3.2 普通提醒静默；紧急不走 DND） */
function inDndHours(): boolean {
  const hour = new Date().getHours()
  return hour >= 23 || hour < 7
}

async function getBootstrap(page: Page): Promise<HudBootstrap> {
  return page.evaluate(async () =>
    (globalThis as unknown as { pet: { bootstrap: () => Promise<HudBootstrap> } }).pet.bootstrap(),
  )
}

async function createTask(page: Page, input: TaskSeedInput): Promise<string> {
  return page.evaluate(async (options) => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    const created = await pet.createTask({
      title: options.title,
      ...(options.importance === undefined ? {} : { importance: options.importance }),
      ...(options.dueAt === undefined ? {} : { dueAt: options.dueAt }),
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    })
    return created.id
  }, input)
}

async function toggleDone(page: Page, id: string): Promise<void> {
  await page.evaluate(async (taskId) => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    await pet.toggleTask({ id: taskId, done: true })
  }, id)
}

test('无紧急任务：不渲染 HUD，bootstrap.urgentTasks 为空，显示普通问候气泡', async ({
  petPage,
}) => {
  await expect(hud(petPage)).toHaveCount(0)

  const bootstrap = await getBootstrap(petPage)
  expect(bootstrap.ipcVersion).toBe('2.0.0')
  expect(bootstrap.urgentTasks).toEqual({ tasks: [], total: 0, queued: 0 })
  expect(bootstrap.settings.hudScope).toBe('urgent')
  // HUD 空闲时保留常规问候气泡（8 秒自动消失，尽早断言）
  await expect(petPage.locator('.bubble')).toBeVisible()
})

test('1 条紧急：tasks-urgent 事件 + HUD 标题/剩余/打开按钮，点击打开任务面板且 HUD 常驻', async ({
  petApp,
  petPage,
}) => {
  // 同一次 evaluate 内先订阅事件再建任务，验证 main 的 tasks-urgent 推送与 HudTask 形状
  const eventState = await petPage.evaluate(async () => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    const eventPromise = new Promise<UrgentTasksState>((resolve) => {
      const off = pet.onEvent((event) => {
        if (event.type === 'tasks-urgent') {
          off()
          resolve(event.urgentTasks)
        }
      })
    })
    await pet.createTask({
      title: 'HUD-紧急单条',
      importance: 'urgent',
      dueAt: Date.now() + 2 * 60 * 60_000,
    })
    return eventPromise
  })
  expect(eventState.total).toBe(1)
  expect(eventState.tasks).toHaveLength(1)
  expect(eventState.tasks[0]).toMatchObject({
    title: 'HUD-紧急单条',
    importance: 'urgent',
    category: 'life',
    projectName: null,
  })
  expect(eventState.tasks[0]?.dueAt).toEqual(expect.any(Number))
  expect(eventState.queued).toBe(0)

  const card = hud(petPage)
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-hud-scope', 'urgent')
  await expect(card.locator('.hud__title')).toHaveText('紧急任务 · 1')
  const row = card.locator('.hud__row')
  await expect(row).toHaveCount(1)
  await expect(row).toHaveAttribute('aria-label', '任务「HUD-紧急单条」')
  // 剩余约 2 小时 → soon 分级
  await expect(row.locator('.hud__due')).toHaveClass(/hud__due--soon/)
  await expect(card.locator('.hud__more')).toHaveCount(0)
  await expect(card.locator('.hud__badge')).toHaveCount(0)
  // HUD 活跃时普通问候气泡被抑制
  await expect(petPage.locator('.bubble')).toHaveCount(0)
  // HUD 常驻，不自动消失
  await petPage.waitForTimeout(1500)
  await expect(card).toBeVisible()

  // 「打开」→ 真实打开任务面板
  const opened = petApp.waitForEvent('window')
  await card.getByRole('button', { name: '打开任务清单' }).click()
  const tasksPage = await opened
  await expect(tasksPage.getByRole('heading', { level: 1, name: '任务清单' })).toBeVisible()
  await expect(card).toBeVisible()
})

test('>3 条紧急：最多 3 行 +「还有 N 条」，total 与 bootstrap 同步，删除后重算', async ({
  petPage,
}) => {
  for (let index = 1; index <= 4; index += 1) {
    await createTask(petPage, { title: `HUD-多条-${index}`, importance: 'urgent' })
  }

  const card = hud(petPage)
  await expect(card.locator('.hud__title')).toHaveText('紧急任务 · 4')
  await expect(card.locator('.hud__row')).toHaveCount(3)
  await expect(card.locator('.hud__more')).toHaveText('还有 1 条')

  const state = (await getBootstrap(petPage)).urgentTasks
  expect(state.total).toBe(4)
  expect(state.tasks).toHaveLength(3)
  expect(state.queued).toBe(0)
  expect(state.tasks[0]).toMatchObject({
    importance: 'urgent',
    category: 'life',
    projectName: null,
  })

  // 删除已在 HUD 展示的一条 → total 3，不再显示「还有 N 条」
  const removeId = state.tasks[0]?.id ?? ''
  expect(removeId).not.toBe('')
  await petPage.evaluate(async (taskId) => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    await pet.deleteTask(taskId)
  }, removeId)
  await expect(card.locator('.hud__title')).toHaveText('紧急任务 · 3')
  await expect(card.locator('.hud__more')).toHaveCount(0)
  await expect(card.locator('.hud__row')).toHaveCount(3)
})

test('完成/降级触发 HUD 重算；全部清空后 HUD 消失并恢复普通问候', async ({ petPage }) => {
  const firstId = await createTask(petPage, { title: 'HUD-完成一条', importance: 'urgent' })
  const secondId = await createTask(petPage, { title: 'HUD-降级一条', importance: 'urgent' })
  const card = hud(petPage)
  await expect(card.locator('.hud__title')).toHaveText('紧急任务 · 2')

  // 完成一条 → 未完成紧急只剩 1 条
  await toggleDone(petPage, firstId)
  await expect(card.locator('.hud__title')).toHaveText('紧急任务 · 1')
  await expect(card.locator('.hud__row')).toHaveCount(1)

  // 降级最后一条 → HUD 消失
  await petPage.evaluate(async (taskId) => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    await pet.updateTask({ id: taskId, patch: { importance: 'normal' } })
  }, secondId)
  await expect(card).toHaveCount(0)

  // HUD 空闲后恢复普通问候气泡
  await expect(petPage.locator('.bubble')).toBeVisible()
})

test('hudScope 切换：urgent-due 纳入今天到期的普通任务，切回 urgent 后移除', async ({
  petPage,
}) => {
  await createTask(petPage, { title: 'HUD-范围-紧急', importance: 'urgent' })
  // 已过期的普通任务：属于「今天到期/已过期」，urgent-due 范围应纳入（不受 04:00 边界影响）
  await createTask(petPage, { title: 'HUD-范围-今天到期', dueAt: Date.now() - 60_000 })

  const card = hud(petPage)
  await expect(card.locator('.hud__title')).toHaveText('紧急任务 · 1')

  await petPage.evaluate(async () => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    await pet.updateSettings({ hudScope: 'urgent-due' })
  })
  await expect(card).toHaveAttribute('data-hud-scope', 'urgent-due')
  await expect(card.locator('.hud__title')).toHaveText('紧急与今日到期 · 2')
  await expect(card.locator('.hud__row')).toHaveCount(2)

  await petPage.evaluate(async () => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    await pet.updateSettings({ hudScope: 'urgent' })
  })
  await expect(card).toHaveAttribute('data-hud-scope', 'urgent')
  await expect(card.locator('.hud__title')).toHaveText('紧急任务 · 1')
  await expect(card.locator('.hud__row')).toHaveCount(1)
})

test('项目紧急任务：HUD 行显示「项目：名称」', async ({ petPage }) => {
  await petPage.evaluate(async () => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    const project = await pet.createProject({ name: 'HUD项目' })
    await pet.createTask({ title: 'HUD-项目紧急', projectId: project.id, importance: 'urgent' })
  })

  const card = hud(petPage)
  await expect(card.locator('.hud__row')).toHaveCount(1)
  await expect(card.locator('.hud__project')).toHaveText('项目：HUD项目')
  await expect(card.locator('.hud__row')).toHaveAttribute('aria-label', '任务「HUD-项目紧急」')
})

test('HUD 活跃时普通提醒排队 + 角标；清空 HUD 后立即出现 1 条汇总气泡', async ({ petPage }) => {
  test.skip(inDndHours(), '免打扰 23:00–07:00 时段普通提醒静默，需在白天重跑')
  test.setTimeout(150_000)

  const urgentId = await createTask(petPage, { title: 'HUD-排队-紧急', importance: 'urgent' })
  await createTask(petPage, {
    title: 'HUD-排队-普通',
    dueAt: Date.now() + 2 * 60_000,
  })
  const card = hud(petPage)
  await expect(card.locator('.hud__title')).toHaveText('紧急任务 · 1')

  // 等下一 tick：HUD 活跃 → 普通提醒入队并标记，HUD 出现角标
  const badge = card.locator('.hud__badge')
  await expect(badge).toBeVisible({ timeout: 35_000 })
  await expect(badge).toHaveText('+1 条提醒')
  await expect(badge).toHaveAttribute('aria-label', '还有 1 条提醒排队')
  // 普通提醒不弹气泡（HUD 活跃时抑制）
  await expect(petPage.locator('.bubble')).toHaveCount(0)
  expect((await getBootstrap(petPage)).urgentTasks.queued).toBe(1)

  // 完成紧急任务 → HUD 空闲，main 立即发 1 条汇总气泡（toggle 的 refreshHud 同步触发）
  await toggleDone(petPage, urgentId)
  await expect(card).toHaveCount(0)
  const bubble = petPage.locator('.bubble')
  await expect(bubble).toBeVisible()
  await expect(bubble).toContainText('还有 1 条任务提醒')
  await expect(bubble).toContainText('HUD-排队-普通')
  // 汇总成功发送 → 队列清空
  expect((await getBootstrap(petPage)).urgentTasks).toEqual({
    tasks: [],
    total: 0,
    queued: 0,
  })
})

test('紧急任务到期：只更新 HUD（remindedAt 推进），不弹任务气泡', async ({ petPage }) => {
  test.setTimeout(120_000)
  const taskId = await createTask(petPage, {
    title: 'HUD-到期紧急',
    importance: 'urgent',
    dueAt: Date.now() + 1_000,
  })
  const card = hud(petPage)
  await expect(card.locator('.hud__row')).toHaveAttribute('aria-label', '任务「HUD-到期紧急」')

  // 等下一 tick 处理（≤30s）：紧急任务只推进 remindedAt，不弹气泡
  await expect
    .poll(
      async () =>
        petPage.evaluate(async (id) => {
          const pet = (globalThis as unknown as { pet: PetApi }).pet
          const snapshot = await pet.listTasks({ scope: 'all' })
          return snapshot.tasks.find((task) => task.id === id)?.remindedAt ?? null
        }, taskId),
      { timeout: 35_000 },
    )
    .not.toBeNull()

  await expect(petPage.locator('.bubble')).toHaveCount(0)
  await expect(card).toBeVisible()
  // 到期后剩余分级变为 imminent/overdue（渲染层 now 每 30s 刷新）
  await expect(card.locator('.hud__due')).toHaveClass(/hud__due--(imminent|overdue)/)
})

test('提前量实际触发：reminderLeadMin=5 时提前窗口内弹醒目提醒卡（12 秒自动消失）', async ({
  petPage,
}) => {
  test.skip(inDndHours(), '免打扰 23:00–07:00 时段普通提醒静默，需在白天重跑')
  test.setTimeout(150_000)

  await petPage.evaluate(async () => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    await pet.updateSettings({ reminderLeadMin: 5, hudScope: 'urgent' })
    await pet.createTask({ title: 'HUD-提前量-5', dueAt: Date.now() + 3 * 60_000 })
  })

  // 等下一 tick（≤30s）：提前 5 分钟窗口内应弹「还有 N 分钟」。
  // 注意：启动问候气泡可能先出现，必须先等目标任务文案，不能先断言任意 .bubble 可见。
  const bubble = petPage.locator('.bubble')
  await expect(bubble).toContainText('HUD-提前量-5', { timeout: 45_000 })
  await expect(bubble).toContainText('还有')
  // 0.4.2：任务提醒使用醒目 reminder 卡（大标题/强调色/动作），不再是普通台词气泡
  await expect(bubble).toHaveClass(/bubble--reminder/)
  await expect(bubble).toHaveAttribute('role', 'alert')
  await expect(bubble.locator('.bubble__eyebrow')).toHaveText('任务提醒')
  await expect(bubble.locator('.bubble__title')).toContainText('HUD-提前量-5')
  await expect(petPage.getByRole('button', { name: '打开任务清单', exact: true })).toBeVisible()
  await expect(petPage.getByRole('button', { name: '关闭提醒', exact: true })).toBeVisible()

  // 自动消失 12s（而非旧 8s/硬编码 2s）：9s 时仍在，随后在 12s 左右消失
  await petPage.waitForTimeout(9_000)
  await expect(bubble).toBeVisible()
  await expect(bubble).toHaveCount(0, { timeout: 6_000 })
})

test('搁置/完成紧急任务退出 HUD，恢复/取消完成后按当前资格返回（docs/37 T-06/N-06）', async ({
  petPage,
}) => {
  const taskId = await createTask(petPage, { title: 'HUD-搁置恢复', importance: 'urgent' })
  const card = hud(petPage)
  await expect(card.locator('.hud__title')).toHaveText('紧急任务 · 1')

  // 搁置：立即退出 HUD（不进入普通提醒队列）
  await petPage.evaluate(async (id) => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    await pet.setTaskArchived({ id, archived: true })
  }, taskId)
  await expect(card).toHaveCount(0)
  expect((await getBootstrap(petPage)).urgentTasks).toEqual({ tasks: [], total: 0, queued: 0 })

  // 恢复：按当前资格重新进入 HUD，保留原 ID
  await petPage.evaluate(async (id) => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    await pet.setTaskArchived({ id, archived: false })
  }, taskId)
  await expect(card).toHaveCount(1)
  await expect(card.locator('.hud__row')).toHaveAttribute('data-task-id', taskId)

  // 完成：退出 HUD（done 不是 HUD 候选）
  await petPage.evaluate(async (id) => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    await pet.toggleTask({ id, done: true })
  }, taskId)
  await expect(card).toHaveCount(0)
})
