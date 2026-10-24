/**
 * 独立打卡（Habit）冒烟（0.4.2，契约 2.0；docs/37 H-01..H-15 中可快速执行部分）
 *
 * 0.4.2 打卡卡默认收起：只显示名称/频率短语/当前状态/本期打卡/展开按钮；
 * 展开后才显示本期起止、备注、周期说明、下期生效、已打卡时间与编辑/历史/删除。
 *
 * 覆盖：打卡页空态、每日/每周创建、收起/展开、本期打卡与重复幂等、编辑（改名即时 / 频率变更下期生效）、
 * 只读历史、删除限制（有历史不可删）、与任务/项目/HUD/统计完全独立、宠物隐藏时打卡仍保存且
 * 不补播庆祝、减少动态效果下静态图。
 *
 * 周期边界（04:00 / 周切换 / 跨月 / 桥接周期）、跨时区等由 `tests/unit/habits.test.ts`
 * 与 `tests/unit/task-store.test.ts` 固定时钟覆盖；本文件只做真实 Electron 的 UI/数据闭环。
 *
 * 本机 DSH 沙箱内 Electron 无法启动（spawn EPERM），这些用例由宿主执行 `pnpm smoke`。
 */
import type { Locator, Page } from '@playwright/test'

import type { PetApi } from '../../src/shared/ipc'
import { expect, test } from './fixtures'

function habitsTab(page: Page): Locator {
  return page.getByRole('tablist', { name: '一级导航' }).getByRole('tab', { name: '打卡' })
}

async function openHabits(page: Page): Promise<void> {
  await habitsTab(page).click()
  await expect(page.getByText(/每项独立/)).toBeVisible({ timeout: 15_000 })
}

function habitCard(page: Page, name: string): Locator {
  return page.locator('.habit-card').filter({ hasText: name })
}

/** 展开打卡卡详情（收起状态默认只显示名称/频率/状态/打卡/展开） */
/** 展开打卡卡详情（幂等：编辑后 expandedIds 保留，卡片可能仍是展开状态） */
async function expandHabit(card: Locator, name: string): Promise<void> {
  if ((await card.getAttribute('data-expanded')) === 'true') return
  await card.getByRole('button', { name: `展开「${name}」详情` }).click()
  await expect(card).toHaveAttribute('data-expanded', 'true')
}

/** 收起打卡卡详情（幂等：已收起则不点） */
async function collapseHabit(card: Locator, name: string): Promise<void> {
  if ((await card.getAttribute('data-expanded')) === 'false') return
  await card.getByRole('button', { name: `收起「${name}」详情` }).click()
  await expect(card).toHaveAttribute('data-expanded', 'false')
}

/** 用头部按钮打开「新建打卡项目」模态弹窗（空态里还有同名按钮） */
async function openHabitCreate(page: Page): Promise<Locator> {
  await page.locator('.tasks__topbar').getByRole('button', { name: '新建打卡项目' }).click()
  return page.getByRole('dialog', { name: '新建打卡项目' })
}

async function createHabit(
  page: Page,
  name: string,
  options: { weeklyWeekday?: number; note?: string } = {},
): Promise<Locator> {
  const dialog = await openHabitCreate(page)
  await dialog.getByLabel('名称', { exact: true }).fill(name)
  if (options.note !== undefined) {
    await dialog.getByLabel('备注（可选）', { exact: true }).fill(options.note)
  }
  if (options.weeklyWeekday !== undefined) {
    await dialog.getByLabel('频率', { exact: true }).selectOption('weekly')
    await dialog
      .getByLabel('每周截止星期', { exact: true })
      .selectOption(String(options.weeklyWeekday))
  }
  await dialog.getByRole('button', { name: '创建打卡项目', exact: true }).click()
  const card = habitCard(page, name)
  await expect(card).toHaveCount(1)
  return card
}

async function habitSnapshot(page: Page, name: string) {
  return page.evaluate(async (expectedName) => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    const habits = await pet.listHabits()
    return habits.find((entry) => entry.habit.name === expectedName) ?? null
  }, name)
}

test('① 打卡页空态与默认 IA：独立于待办，无 streak/旧历史入口', async ({ petApp, petPage }) => {
  const windowOpened = petApp.waitForEvent('window')
  await petPage.evaluate(() => (globalThis as unknown as { pet: PetApi }).pet.openTasks())
  const page = await windowOpened
  await expect(page.getByRole('heading', { level: 1, name: '任务清单' })).toBeVisible()

  await openHabits(page)
  await expect(page.getByText('还没有打卡项目，先新建一个')).toBeVisible()
  await expect(
    page.locator('.tasks__topbar').getByRole('button', { name: '新建打卡项目' }),
  ).toBeVisible()
  await expect(page.getByPlaceholder('添加任务，回车保存')).toHaveCount(0)
  await expect(page.getByText(/连续/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: '今日打卡' })).toHaveCount(0)

  const stats = await page.evaluate(async () => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    return pet.getTaskStats()
  })
  expect(Object.keys(stats).sort()).toEqual(
    ['overdue', 'todayDone', 'todayKey', 'todayTotal', 'totalTodo'].sort(),
  )
})

test('② 新建每日打卡：默认收起只显示摘要，展开后显示周期/备注/时间/编辑历史删除', async ({
  petApp,
  petPage,
}) => {
  const windowOpened = petApp.waitForEvent('window')
  await petPage.evaluate(() => (globalThis as unknown as { pet: PetApi }).pet.openTasks())
  const page = await windowOpened
  await openHabits(page)

  const card = await createHabit(page, '每天背英语单词', { note: '每天 20 个' })
  // 收起：名称/频率/状态/打卡/展开；详情内容与操作按钮不渲染
  await expect(card).toHaveAttribute('data-expanded', 'false')
  await expect(card.locator('.habit-card__name')).toHaveText('每天背英语单词')
  await expect(card.locator('.habit-card__frequency')).toHaveText('每天 04:00 换周期')
  await expect(card.locator('.habit-card__todo')).toHaveText('本周期未打卡')
  await expect(card.getByRole('button', { name: '打卡「每天背英语单词」' })).toBeVisible()
  await expect(page.getByRole('button', { name: '展开「每天背英语单词」详情' })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await expect(card.locator('.habit-card__cycle')).toHaveCount(0)
  await expect(card.getByRole('button', { name: '编辑打卡项目「每天背英语单词」' })).toHaveCount(0)
  await expect(card.locator('.habit-card__note')).toHaveCount(0)

  // 展开：周期/备注/打卡时间/编辑历史删除出现
  await expandHabit(card, '每天背英语单词')
  await expect(card.locator('.habit-card__cycle')).toHaveText(
    /^本期：\d{2}-\d{2} 04:00 → \d{2}-\d{2} 04:00$/,
  )
  await expect(card.locator('.habit-card__note')).toHaveText('每天 20 个')
  await expect(card.locator('.habit-card__checked-at')).toHaveText('已打卡时间：本周期还没有记录')
  await expect(card.getByRole('button', { name: '编辑打卡项目「每天背英语单词」' })).toBeVisible()
  await expect(card.getByRole('button', { name: '查看「每天背英语单词」打卡历史' })).toBeVisible()
  await expect(card.getByRole('button', { name: '删除打卡项目「每天背英语单词」' })).toBeVisible()

  // 收起后详情隐藏
  await collapseHabit(card, '每天背英语单词')
  await expect(card.locator('.habit-card__cycle')).toHaveCount(0)
})

test('③ 本期打卡：按钮禁用、收起摘要「本周期已打卡」、展开显示时间、重复提交幂等', async ({
  petApp,
  petPage,
}) => {
  const windowOpened = petApp.waitForEvent('window')
  await petPage.evaluate(() => (globalThis as unknown as { pet: PetApi }).pet.openTasks())
  const page = await windowOpened
  await openHabits(page)

  const card = await createHabit(page, '每天背单词-打卡')
  await card.getByRole('button', { name: '打卡「每天背单词-打卡」' }).click()
  await expect(page.getByText('打卡成功')).toBeVisible()
  await expect(card.locator('.habit-card__done')).toHaveText('本周期已打卡')
  const checkinButton = card.getByRole('button', { name: '打卡「每天背单词-打卡」' })
  await expect(checkinButton).toBeDisabled()
  await expect(checkinButton).toHaveText('已打卡')

  await expandHabit(card, '每天背单词-打卡')
  await expect(card.locator('.habit-card__checked-at')).toHaveText(
    /^已打卡时间：\d{2}-\d{2} \d{2}:\d{2}$/,
  )

  // 同一周期重复请求：返回既有记录 isNew=false，不产生第二条
  const duplicate = await page.evaluate(async () => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    const habits = await pet.listHabits()
    const snapshot = habits[0]
    if (snapshot === undefined) throw new Error('缺少打卡项目')
    return pet.checkinHabit({
      habitId: snapshot.habit.id,
      cycleKey: snapshot.habit.currentCycle.key,
    })
  })
  expect(duplicate.isNew).toBe(false)
  const after = await page.evaluate(async () => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    const habits = await pet.listHabits()
    return (await pet.listHabitHistory({ habitId: habits[0]!.habit.id })).records.length
  })
  expect(after).toBe(1)
})

test('④ 每周打卡：频率/截止星期选项与 04:00 说明（展开显示）', async ({ petApp, petPage }) => {
  const windowOpened = petApp.waitForEvent('window')
  await petPage.evaluate(() => (globalThis as unknown as { pet: PetApi }).pet.openTasks())
  const page = await windowOpened
  await openHabits(page)

  const card = await createHabit(page, '每周健身', { weeklyWeekday: 7 })
  await expect(card.locator('.habit-card__frequency')).toHaveText('每周日 04:00 截止')
  await expandHabit(card, '每周健身')
  await expect(card.locator('.habit-card__hint')).toHaveText(
    '周日当天 04:00 换周期，周日白天属于下一期。',
  )
  const snapshot = await habitSnapshot(page, '每周健身')
  expect(snapshot?.habit.currentCycle.schedule).toEqual({
    frequency: 'weekly',
    deadlineWeekday: 7,
  })
})

test('⑤ 编辑打卡项目：名称即时生效，频率变更显示「下期生效」预览（展开操作）', async ({
  petApp,
  petPage,
}) => {
  const windowOpened = petApp.waitForEvent('window')
  await petPage.evaluate(() => (globalThis as unknown as { pet: PetApi }).pet.openTasks())
  const page = await windowOpened
  await openHabits(page)

  const card = await createHabit(page, '每天读书')
  await expandHabit(card, '每天读书')
  await card.getByRole('button', { name: '编辑打卡项目「每天读书」' }).click()
  const dialog = page.getByRole('dialog', { name: '编辑打卡项目' })
  await dialog.getByLabel('名称', { exact: true }).fill('每天读书-改名')
  await dialog.getByLabel('频率', { exact: true }).selectOption('weekly')
  await dialog.getByLabel('每周截止星期', { exact: true }).selectOption('1')
  await expect(dialog.getByText(/下期预览/)).toBeVisible()
  await dialog.getByRole('button', { name: '保存修改', exact: true }).click()

  const renamed = habitCard(page, '每天读书-改名')
  await expect(renamed).toHaveCount(1)
  // 名称立即生效；当前周期规则仍为每天，变更排到下一周期（收起状态显示当前规则）
  await expect(renamed.locator('.habit-card__frequency')).toHaveText('每天 04:00 换周期')
  await expandHabit(renamed, '每天读书-改名')
  await expect(renamed.locator('.habit-card__pending')).toContainText('下期改为每周一 04:00 截止')
  await expect(renamed.locator('.habit-card__pending')).toContainText('（下期生效）')
})

test('⑥ 只读历史：展开后打开，显示已打卡记录，无补卡/连续天数', async ({ petApp, petPage }) => {
  const windowOpened = petApp.waitForEvent('window')
  await petPage.evaluate(() => (globalThis as unknown as { pet: PetApi }).pet.openTasks())
  const page = await windowOpened
  await openHabits(page)

  const card = await createHabit(page, '背单词-历史')
  await card.getByRole('button', { name: '打卡「背单词-历史」' }).click()
  await expect(card.locator('.habit-card__done')).toHaveText('本周期已打卡')
  await expandHabit(card, '背单词-历史')
  await card.getByRole('button', { name: '查看「背单词-历史」打卡历史' }).click()
  const history = page.getByRole('dialog', { name: /「背单词-历史」打卡历史（只读）/ })
  await expect(history).toBeVisible()
  await expect(history.locator('.habit-history__item')).toHaveCount(1)
  await expect(history.locator('.habit-history__item')).toContainText('已打卡')
  await expect(history.getByText(/连续/)).toHaveCount(0)
  await expect(history.getByRole('button', { name: /补卡/ })).toHaveCount(0)
  await history.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(history).not.toBeVisible()
})

test('⑦ 删除限制：有历史不可删；无历史可删（展开操作）', async ({ petApp, petPage }) => {
  const windowOpened = petApp.waitForEvent('window')
  await petPage.evaluate(() => (globalThis as unknown as { pet: PetApi }).pet.openTasks())
  const page = await windowOpened
  await openHabits(page)

  const withHistory = await createHabit(page, '有历史打卡')
  await withHistory.getByRole('button', { name: '打卡「有历史打卡」' }).click()
  await expect(withHistory.locator('.habit-card__done')).toHaveText('本周期已打卡')
  await expandHabit(withHistory, '有历史打卡')
  page.once('dialog', (dialog) => void dialog.accept())
  await withHistory.getByRole('button', { name: '删除打卡项目「有历史打卡」' }).click()
  await expect(page.getByText('该打卡项目已有历史记录，不能删除')).toBeVisible()
  await expect(habitCard(page, '有历史打卡')).toHaveCount(1)

  const deletable = await createHabit(page, '可删打卡')
  await expandHabit(deletable, '可删打卡')
  page.once('dialog', (dialog) => void dialog.accept())
  await deletable.getByRole('button', { name: '删除打卡项目「可删打卡」' }).click()
  await expect(page.getByText('已删除打卡项目')).toBeVisible()
  await expect(habitCard(page, '可删打卡')).toHaveCount(0)
  await expect(habitCard(page, '有历史打卡')).toHaveCount(1)
})

test('⑧ 完全独立：打卡不改变任务列表/统计/项目/HUD', async ({ petApp, petPage }) => {
  const windowOpened = petApp.waitForEvent('window')
  await petPage.evaluate(() => (globalThis as unknown as { pet: PetApi }).pet.openTasks())
  const page = await windowOpened
  const panel = page.getByRole('dialog', { name: '新建任务面板' })
  await page.getByRole('button', { name: '新建任务', exact: true }).click()
  await panel.getByPlaceholder('添加任务，回车保存').fill('独立-待办任务')
  await panel.getByPlaceholder('添加任务，回车保存').press('Enter')
  await expect(panel.getByText('已添加')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-item')).toHaveCount(1)

  const before = await page.evaluate(async () => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    const tasks = await pet.listTasks({ scope: 'all' })
    const stats = await pet.getTaskStats()
    return { tasks: tasks.tasks, stats, urgentTasks: (await pet.bootstrap()).urgentTasks }
  })
  await openHabits(page)
  const card = await createHabit(page, '独立-打卡项目')
  await card.getByRole('button', { name: '打卡「独立-打卡项目」' }).click()
  await expect(card.locator('.habit-card__done')).toHaveText('本周期已打卡')

  const after = await page.evaluate(async () => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    const tasks = await pet.listTasks({ scope: 'all' })
    const stats = await pet.getTaskStats()
    return { tasks: tasks.tasks, stats, urgentTasks: (await pet.bootstrap()).urgentTasks }
  })
  expect(after.tasks).toEqual(before.tasks)
  expect(after.stats).toEqual(before.stats)
  expect(after.urgentTasks).toEqual(before.urgentTasks)
})

test('⑨ 隐藏宠物时打卡仍保存；恢复显示后不补播庆祝动作', async ({ petApp, petPage }) => {
  const windowOpened = petApp.waitForEvent('window')
  await petPage.evaluate(() => (globalThis as unknown as { pet: PetApi }).pet.openTasks())
  const page = await windowOpened
  await openHabits(page)

  const card = await createHabit(page, '隐藏打卡')
  await petPage.evaluate(() => (globalThis as unknown as { pet: PetApi }).pet.setVisible(false))
  await expect
    .poll(() =>
      petApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((entry) =>
          entry.webContents.getURL().includes('index.html'),
        )
        return win?.isVisible()
      }),
    )
    .toBe(false)
  await card.getByRole('button', { name: '打卡「隐藏打卡」' }).click()
  await expect(card.locator('.habit-card__done')).toHaveText('本周期已打卡')

  await petPage.evaluate(() => (globalThis as unknown as { pet: PetApi }).pet.setVisible(true))
  await expect.poll(() => petPage.locator('.pet-sprite').isVisible()).toBe(true)
  // 隐藏期间 main 不发送 celebrate；恢复后不应补播
  await expect(petPage.locator('.pet-sprite')).toHaveAttribute('data-action', '')
  const snapshot = await habitSnapshot(page, '隐藏打卡')
  expect(snapshot?.currentCheckin).not.toBeNull()
})

test('⑩ 减少动态效果：打卡成功保存且使用静态图（不播动画）', async ({ petApp, petPage }) => {
  const windowOpened = petApp.waitForEvent('window')
  await petPage.evaluate(() => (globalThis as unknown as { pet: PetApi }).pet.openTasks())
  const page = await windowOpened
  await openHabits(page)

  await petPage.emulateMedia({ reducedMotion: 'reduce' })
  const card = await createHabit(page, '减少动态打卡')
  await card.getByRole('button', { name: '打卡「减少动态打卡」' }).click()
  await expect(card.locator('.habit-card__done')).toHaveText('本周期已打卡')
  await expect(petPage.locator('.pet-sprite')).toHaveAttribute('data-static', 'true')
  await expect(petPage.locator('.pet-sprite__image')).toHaveAttribute('src', /\.png$/)
  await petPage.emulateMedia({ reducedMotion: 'no-preference' })

  const snapshot = await habitSnapshot(page, '减少动态打卡')
  expect(snapshot?.currentCheckin).not.toBeNull()
})
