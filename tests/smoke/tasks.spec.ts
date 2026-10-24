/**
 * 任务清单 0.4.2 IA 冒烟（单列表 / 搁置清单 / 底部 FAB / 完成恢复 / 权限 / 窗口）
 *
 * 0.4.2 变化：删除「活动/已完成/搁置」状态 tabs；已完成任务留在单一列表（划掉，可取消完成）；
 * 「搁置 N」打开全部搁置任务清单（恢复/删除/返回）；顶部常驻 QuickAdd 改为右下角 FAB
 * + 底部新建面板（Esc/外部点击/关闭按钮）；统计 todayDone/todayTotal 排除搁置。
 *
 * 真实入口：托盘「任务清单…」打开任务窗（与 settings.spec 同一托盘捕获写法）。
 * 本机 DSH 沙箱内 Electron 无法启动（spawn EPERM），由宿主执行 `pnpm smoke`。
 */
import { _electron as electron, test as baseTest } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import type { Menu } from 'electron'
import { mkdir, mkdtemp, readFile, rmdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { PetApi } from '../../src/shared/ipc'
import { expect, test } from './fixtures'

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')

function isolatedEnv(profile: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env['APPDATA'] = profile
  env['LOCALAPPDATA'] = profile
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['ELECTRON_RENDERER_URL']
  delete env['WHALE_PET_HIT_TRACE']
  return env
}

async function launchIsolated(profile: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${profile}`],
    env: isolatedEnv(profile),
  })
}

async function captureTray(app: ElectronApplication, pet: Page): Promise<void> {
  await app.evaluate(({ Tray }) => {
    const state = globalThis as unknown as { smokeTrayMenu: Menu | null }
    state.smokeTrayMenu = null
    const original = Tray.prototype.setContextMenu
    Tray.prototype.setContextMenu = function (menu) {
      state.smokeTrayMenu = menu
      return original.call(this, menu)
    }
  })
  await pet.evaluate(() => (globalThis as unknown as { pet: PetApi }).pet.updateSettings({}))
}

async function clickTray(app: ElectronApplication, label: string): Promise<void> {
  await app.evaluate((_electron, label) => {
    const state = globalThis as unknown as { smokeTrayMenu: Menu | null }
    const item = state.smokeTrayMenu?.items.find((entry) => entry.label.includes(label))
    if (item === undefined) throw new Error(`托盘入口缺失: ${label}`)
    item.click()
  }, label)
}

async function openTasks(app: ElectronApplication): Promise<Page> {
  const opened = app.waitForEvent('window')
  await clickTray(app, '任务清单')
  const page = await opened
  expect(await page.title()).toContain('任务清单')
  await expect(page.getByRole('heading', { level: 1, name: '任务清单' })).toBeVisible()
  await expect(page.getByRole('tab', { name: '待办', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '新建任务', exact: true })).toBeVisible()
  return page
}

function scopeTabs(page: Page): Locator {
  return page.getByRole('tablist', { name: '任务范围' })
}

function categoryGroup(page: Page): Locator {
  return page.getByRole('group', { name: '任务分类' })
}

async function selectCategory(page: Page, label: '学习' | '生活' | '运动' | '项目'): Promise<void> {
  await categoryGroup(page).getByRole('button', { name: label }).click()
}

async function selectScope(page: Page, label: '今日' | '全部'): Promise<void> {
  await scopeTabs(page).getByRole('tab', { name: label }).click()
}

function taskRow(page: Page, title: string): Locator {
  return page.locator('.task-item').filter({ hasText: title })
}

/** FAB 打开底部新建面板 */
async function openComposer(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: '新建任务', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '新建任务面板' })
  await expect(panel).toBeVisible()
  return panel
}

/** 用底部面板快速录入（标题 + 回车），等待行出现，然后 Esc 关闭面板 */
async function addTaskViaComposer(page: Page, title: string): Promise<Locator> {
  const panel = await openComposer(page)
  const input = panel.getByPlaceholder('添加任务，回车保存')
  await input.fill(title)
  await input.press('Enter')
  await expect(panel.getByText('已添加')).toBeVisible()
  const row = taskRow(page, title)
  await expect(row).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(panel).not.toBeVisible()
  return row
}

async function readTaskFile(profile: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(profile, 'tasks.json'), 'utf8')) as Record<string, unknown>
}

function profileOf(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ app }) => app.getPath('userData'))
}

// ---------------------------------------------------------------------------
// 1. 默认 IA：单列表 + 无状态 tabs + 汇总/搁置入口 + FAB
// ---------------------------------------------------------------------------

test('① 默认 IA：单列表（无活动/已完成/搁置 tabs）、今日完成/当前范围、搁置入口与 FAB', async ({
  petApp,
  petPage,
}) => {
  await captureTray(petApp, petPage)
  const page = await openTasks(petApp)

  await expect(page.getByRole('tab', { name: '待办', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  // 0.4.2：不再有「任务状态」tabs；也没有活动/已完成/搁置 tab
  await expect(page.getByRole('tablist', { name: '任务状态' })).toHaveCount(0)
  for (const label of ['活动', '已完成', '搁置']) {
    await expect(page.getByRole('tab', { name: label, exact: true })).toHaveCount(0)
  }
  // 默认 今日 + 生活
  await expect(scopeTabs(page).getByRole('tab', { name: '今日', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(categoryGroup(page).getByRole('button', { name: '生活' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  // 汇总 + 搁置入口 + FAB
  await expect(page.locator('.tasks__summary')).toContainText('今日完成 0/0')
  await expect(page.locator('.tasks__summary')).toContainText('当前范围内 0 项')
  await expect(page.getByRole('button', { name: '打开搁置任务清单，共 0 项' })).toBeVisible()
  await expect(page.getByRole('button', { name: '新建任务', exact: true })).toBeVisible()
  await expect(page.getByText('今日范围内没有任务')).toBeVisible()
  // 顶部不再常驻 QuickAdd（录入只在 FAB 面板里）
  await expect(page.getByPlaceholder('添加任务，回车保存')).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// 2. FAB 底部新建面板：打开/提交/Esc/外部点击/关闭按钮
// ---------------------------------------------------------------------------

test('② FAB 新建面板：打开/提交/Esc/外部点击/关闭按钮；提交后列表更新', async ({
  petApp,
  petPage,
}) => {
  await captureTray(petApp, petPage)
  const page = await openTasks(petApp)

  // 打开 + 提交（面板内 QuickAdd 回车保存）；提交后保持打开且标题清空
  const panel = await openComposer(page)
  await expect(panel.getByRole('heading', { name: '新建任务' })).toBeVisible()
  const input = panel.getByPlaceholder('添加任务，回车保存')
  await input.fill('FAB-提交任务')
  await input.press('Enter')
  await expect(panel.getByText('已添加')).toBeVisible()
  await expect(taskRow(page, 'FAB-提交任务')).toHaveCount(1)
  await expect(panel).toBeVisible()
  await expect(input).toHaveValue('')

  // Esc 关闭，焦点回 FAB
  await page.keyboard.press('Escape')
  await expect(panel).not.toBeVisible()
  await expect(page.getByRole('button', { name: '新建任务', exact: true })).toBeFocused()

  // 关闭按钮
  const panel2 = await openComposer(page)
  await panel2.getByRole('button', { name: '关闭新建任务面板' }).click()
  await expect(panel2).not.toBeVisible()

  // 点面板外部（遮罩）关闭
  const panel3 = await openComposer(page)
  await page.locator('.composer').click({ position: { x: 8, y: 8 } })
  await expect(panel3).not.toBeVisible()

  // 面板内可切换归属/重要性（复用 QuickAdd 详情）
  const panel4 = await openComposer(page)
  await panel4.getByRole('button', { name: '详情', exact: true }).click()
  await expect(panel4.getByLabel('任务归属', { exact: true })).toBeVisible()
  await expect(panel4.getByRole('group', { name: '任务重要性' })).toBeVisible()
  await page.keyboard.press('Escape')
})

// ---------------------------------------------------------------------------
// 3. 单列表完成：已完成留在列表划掉，再次勾选恢复；计数更新
// ---------------------------------------------------------------------------

test('③ 单列表完成：完成留在列表（划掉/完成于）、再次勾选恢复、今日完成计数', async ({
  petApp,
  petPage,
}) => {
  await captureTray(petApp, petPage)
  const page = await openTasks(petApp)
  const row = await addTaskViaComposer(page, '单列表-完成A')
  await expect(page.locator('.tasks__summary')).toContainText('今日完成 0/1')

  await row.getByRole('checkbox').click()
  // 已完成仍在同一列表，划掉 + 完成于时间戳
  await expect(row).toHaveCount(1)
  await expect(row).toHaveClass(/task-item--done/)
  await expect(row.locator('.task-item__stamp')).toHaveText(/^完成于 \d{2}-\d{2} \d{2}:\d{2}$/)
  await expect(row.getByRole('checkbox')).toBeChecked()
  await expect(page.locator('.tasks__summary')).toContainText('今日完成 1/1')
  await expect(page.getByText('已完成；再次勾选可恢复')).toBeVisible()

  // 再次勾选 = 取消完成，回到未完成
  await row.getByRole('checkbox').click()
  await expect(row).not.toHaveClass(/task-item--done/)
  await expect(row.getByRole('checkbox')).not.toBeChecked()
  await expect(page.locator('.tasks__summary')).toContainText('今日完成 0/1')
  await expect(page.getByText('已恢复为未完成')).toBeVisible()
})

// ---------------------------------------------------------------------------
// 4. 今日/全部范围交叉与分类筛选
// ---------------------------------------------------------------------------

test('④ 今日/全部范围交叉：未来任务只在「全部」；分类筛选不扩大日期范围', async ({
  petApp,
  petPage,
}) => {
  await captureTray(petApp, petPage)
  const page = await openTasks(petApp)

  const panel = await openComposer(page)
  await panel.getByRole('button', { name: '详情', exact: true }).click()
  await panel.getByLabel('到期时间', { exact: true }).fill('2035-06-15T18:30')
  await panel.getByPlaceholder('添加任务，回车保存').fill('未来-生活任务')
  await panel.getByPlaceholder('添加任务，回车保存').press('Enter')
  await expect(panel.getByText('已添加')).toBeVisible()
  await page.keyboard.press('Escape')
  // 未来生活任务不在「今日」谓词内
  await expect(taskRow(page, '未来-生活任务')).toHaveCount(0)
  await expect(page.getByText('今日范围内没有任务')).toBeVisible()

  await selectScope(page, '全部')
  await expect(taskRow(page, '未来-生活任务')).toHaveCount(1)
  await selectCategory(page, '学习')
  await expect(taskRow(page, '未来-生活任务')).toHaveCount(0)
  await expect(scopeTabs(page).getByRole('tab', { name: '全部', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await selectCategory(page, '生活')
  await expect(taskRow(page, '未来-生活任务')).toHaveCount(1)
})

// ---------------------------------------------------------------------------
// 5. 搁置清单：入口/返回/恢复/删除/全部搁置；统计排除搁置
// ---------------------------------------------------------------------------

test('⑤ 搁置清单：入口计数、独立清单（恢复/删除/返回）、全部搁置、统计排除搁置', async ({
  petApp,
  petPage,
}) => {
  await captureTray(petApp, petPage)
  const page = await openTasks(petApp)
  await addTaskViaComposer(page, '搁置任务-A')
  await addTaskViaComposer(page, '搁置任务-B')
  await expect(page.locator('.tasks__summary')).toContainText('今日完成 0/2')

  // 搁置 A：主列表移除、按钮计数 +1、统计排除搁置（今日完成分母变 1）
  await taskRow(page, '搁置任务-A').getByRole('button', { name: '搁置任务「搁置任务-A」' }).click()
  await expect(page.getByText('已搁置；可在「搁置任务清单」查看')).toBeVisible()
  await expect(taskRow(page, '搁置任务-A')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '打开搁置任务清单，共 1 项' })).toBeVisible()
  await expect(page.locator('.tasks__summary')).toContainText('今日完成 0/1')

  // 再搁置 B → 全部搁置任务都在清单中（不是“模式”）
  await taskRow(page, '搁置任务-B').getByRole('button', { name: '搁置任务「搁置任务-B」' }).click()
  await expect(page.getByRole('button', { name: '打开搁置任务清单，共 2 项' })).toBeVisible()

  // 打开搁置任务清单：标题/返回/行内恢复+删除，无完成勾选；FAB 隐藏
  await page.getByRole('button', { name: '打开搁置任务清单，共 2 项' }).click()
  const archive = page.getByRole('region', { name: '搁置任务清单' })
  await expect(archive).toBeVisible()
  await expect(page.getByRole('heading', { name: '搁置任务清单 · 2' })).toBeVisible()
  await expect(page.getByRole('button', { name: '返回待办' })).toBeVisible()
  await expect(page.getByRole('button', { name: '新建任务', exact: true })).toHaveCount(0)
  await expect(archive.locator('.task-item')).toHaveCount(2)
  await expect(archive.locator('.task-item__check')).toHaveCount(0)
  await expect(archive.getByRole('button', { name: '恢复任务「搁置任务-A」' })).toBeVisible()

  // 恢复 A → 清单剩 1、A 回待办
  await archive.getByRole('button', { name: '恢复任务「搁置任务-A」' }).click()
  await expect(page.getByText('已恢复为活动任务')).toBeVisible()
  await expect(page.getByRole('heading', { name: '搁置任务清单 · 1' })).toBeVisible()
  await page.getByRole('button', { name: '返回待办' }).click()
  await expect(taskRow(page, '搁置任务-A')).toHaveCount(1)

  // 删除 B（确认）→ 搁置清单空态
  await page.getByRole('button', { name: '打开搁置任务清单，共 1 项' }).click()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: '删除任务「搁置任务-B」' }).click()
  await expect(page.getByText('还没有搁置任务')).toBeVisible()
  await page.getByRole('button', { name: '返回待办' }).click()
  await expect(page.getByRole('button', { name: '打开搁置任务清单，共 0 项' })).toBeVisible()
})

// ---------------------------------------------------------------------------
// 6. 默认尺寸下 6 条短任务可见、FAB 不遮列表（自动部分；DPI 人工）
// ---------------------------------------------------------------------------

test('⑥ 默认尺寸：6 条短任务全部可见且 FAB 不遮挡任务行（DPI 人工项）', async ({
  petApp,
  petPage,
}) => {
  await captureTray(petApp, petPage)
  const page = await openTasks(petApp)
  await page.evaluate(async () => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    for (let index = 1; index <= 6; index += 1) {
      await pet.createTask({ title: `短任务${index}` })
    }
  })
  await expect(page.locator('.task-item')).toHaveCount(6)

  const layout = await page.evaluate(() => {
    // tsconfig.node 的 lib 不含 DOM：用最小结构类型访问注入页面的 DOM
    interface Box {
      left: number
      right: number
      top: number
      bottom: number
    }
    interface Elem {
      clientHeight: number
      offsetTop: number
      offsetHeight: number
      getBoundingClientRect(): Box
    }
    interface Doc {
      querySelector(selector: string): Elem | null
      querySelectorAll(selector: string): ArrayLike<Elem>
    }
    const doc = (globalThis as unknown as { document: Doc }).document
    const list = doc.querySelector('.tasks__list')
    const fab = doc.querySelector('.fab')
    const nodes = doc.querySelectorAll('.task-item')
    const rows: Elem[] = []
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]
      if (node !== undefined) rows.push(node)
    }
    if (list === null || fab === null) return null
    const fabRect = fab.getBoundingClientRect()
    const listRect = list.getBoundingClientRect()
    const lastRow = rows[rows.length - 1]
    return {
      rows: rows.length,
      lastRowBottom: lastRow === undefined ? 0 : lastRow.getBoundingClientRect().bottom,
      listBottom: listRect.bottom,
      listTop: listRect.top,
      fabOverlapsRow: rows.some((row) => {
        const rect = row.getBoundingClientRect()
        return !(
          rect.right <= fabRect.left ||
          rect.left >= fabRect.right ||
          rect.bottom <= fabRect.top ||
          rect.top >= fabRect.bottom
        )
      }),
    }
  })
  expect(layout).not.toBeNull()
  // 6 条短任务无需滚动即可全部看到（最后一行在列表可视底边以内）
  expect(layout?.rows).toBe(6)
  expect(layout?.lastRowBottom ?? 0).toBeLessThanOrEqual((layout?.listBottom ?? 0) + 1)
  // 6 行顶部也在列表视口内
  expect(layout?.listTop ?? 0).toBeLessThanOrEqual(layout?.lastRowBottom ?? 0)
  // FAB 不覆盖任何任务行（列表留出底部空间）
  expect(layout?.fabOverlapsRow).toBe(false)
})

// ---------------------------------------------------------------------------
// 7. 删除/撤销、编辑、保存失败、中文输入 回归
// ---------------------------------------------------------------------------

test('⑦ 删除取消/确认/30 秒撤销恢复原 ID 与状态', async ({ petApp, petPage }) => {
  await captureTray(petApp, petPage)
  const page = await openTasks(petApp)
  const row = await addTaskViaComposer(page, '撤销删除任务')
  await row.getByRole('checkbox').check()
  await expect(row).toHaveClass(/task-item--done/)
  const before = await page.evaluate(
    async () =>
      (await (globalThis as unknown as { pet: PetApi }).pet.listTasks({ scope: 'all' })).tasks[0],
  )

  page.once('dialog', (dialog) => void dialog.dismiss())
  await row.getByRole('button', { name: '删除任务「撤销删除任务」' }).click()
  await expect(row).toHaveCount(1)

  page.once('dialog', (dialog) => void dialog.accept())
  await row.getByRole('button', { name: '删除任务「撤销删除任务」' }).click()
  await expect(row).toHaveCount(0)
  await page.getByRole('button', { name: '撤销删除「撤销删除任务」' }).click()
  const after = await page.evaluate(
    async () =>
      (await (globalThis as unknown as { pet: PetApi }).pet.listTasks({ scope: 'all' })).tasks[0],
  )
  expect(after).toEqual(before)
})

test('⑧ 编辑任务：无分类下拉、归属只读提示、重要性/到期/提醒覆盖保存', async ({
  petApp,
  petPage,
}) => {
  await captureTray(petApp, petPage)
  const page = await openTasks(petApp)
  const row = await addTaskViaComposer(page, '编辑前任务')
  await row.getByRole('button', { name: '编辑任务「编辑前任务」' }).click()
  const editor = page.getByRole('dialog', { name: '编辑任务' })
  await expect(editor.getByText('归属：生活（本版不支持在分类/项目间移动）')).toBeVisible()
  await expect(editor.getByLabel('编辑分类', { exact: true })).toHaveCount(0)
  await editor.getByLabel('编辑标题', { exact: true }).fill('编辑后任务')
  await editor.getByLabel('编辑重要性', { exact: true }).selectOption('high')
  await editor.getByLabel('编辑到期时间', { exact: true }).fill('2035-06-15T18:30')
  await editor.getByLabel('编辑提醒提前量', { exact: true }).selectOption('custom')
  await editor.getByLabel('编辑自定义提前量（分钟）').fill('45')
  await editor.getByRole('button', { name: '保存修改', exact: true }).click()
  await expect(editor).not.toBeVisible()
  // dueAt 改为未来后任务离开「今日」谓词；切「全部」再断言行内展示
  await selectScope(page, '全部')
  const edited = taskRow(page, '编辑后任务')
  await expect(edited.locator('.task-item__importance')).toHaveText('重要')
  await expect(edited.locator('.task-item__reminder')).toHaveText('提醒 45 分钟')
  const stored = await page.evaluate(
    async () =>
      (await (globalThis as unknown as { pet: PetApi }).pet.listTasks({ scope: 'all' })).tasks[0],
  )
  expect(stored).toMatchObject({ importance: 'high', reminderLeadMinOverride: 45 })
})

test('⑨ 任务写入失败显示错误并保留编辑草稿，恢复可写后重试成功', async ({ petApp, petPage }) => {
  await captureTray(petApp, petPage)
  const page = await openTasks(petApp)
  const row = await addTaskViaComposer(page, '保存失败原值')
  await row.getByRole('button', { name: '编辑任务「保存失败原值」' }).click()
  const editor = page.getByRole('dialog', { name: '编辑任务' })
  await editor.getByLabel('编辑标题', { exact: true }).fill('保存失败后保留的输入')
  const profile = await profileOf(petApp)
  const blocker = join(profile, 'tasks.json.tmp')
  await mkdir(blocker)
  try {
    await editor.getByRole('button', { name: '保存修改', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: /保存失败/ })).toBeVisible()
    await expect(editor.getByLabel('编辑标题', { exact: true })).toHaveValue('保存失败后保留的输入')
    const stored = await page.evaluate(
      async () =>
        (await (globalThis as unknown as { pet: PetApi }).pet.listTasks({ scope: 'all' })).tasks[0],
    )
    expect(stored?.title).toBe('保存失败原值')
  } finally {
    await rmdir(blocker)
  }
  await editor.getByRole('button', { name: '保存修改', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await expect(page.locator('.task-item__title')).toHaveText('保存失败后保留的输入')
})

test('⑩ 中文组合输入回车不提交；外部刷新不覆盖编辑草稿', async ({ petApp, petPage }) => {
  await captureTray(petApp, petPage)
  const page = await openTasks(petApp)
  const panel = await openComposer(page)
  const input = panel.getByPlaceholder('添加任务，回车保存')
  await input.dispatchEvent('compositionstart')
  await input.fill('中文输入测试')
  await input.press('Enter')
  expect(
    await page.evaluate(
      async () =>
        (await (globalThis as unknown as { pet: PetApi }).pet.listTasks({ scope: 'all' })).tasks
          .length,
    ),
  ).toBe(0)
  await input.dispatchEvent('compositionend')
  await input.press('Enter')
  await expect(taskRow(page, '中文输入测试')).toHaveCount(1)
  await page.keyboard.press('Escape')

  await taskRow(page, '中文输入测试')
    .getByRole('button', { name: '编辑任务「中文输入测试」' })
    .click()
  const editor = page.getByRole('dialog', { name: '编辑任务' })
  await editor.getByLabel('编辑标题', { exact: true }).fill('仍在输入中的草稿')
  await petPage.evaluate(() =>
    (globalThis as unknown as { pet: PetApi }).pet.createTask({ title: '其他入口新增的任务' }),
  )
  await expect(page.locator('.task-item').filter({ hasText: '其他入口新增的任务' })).toHaveCount(1)
  await expect(editor.getByLabel('编辑标题', { exact: true })).toHaveValue('仍在输入中的草稿')
  await editor.getByRole('button', { name: '取消', exact: true }).click()
})

// ---------------------------------------------------------------------------
// 8. 项目入口回归（弹窗/卡片/混排/删除限制；0.4.2 单列表下仍成立）
// ---------------------------------------------------------------------------

test('⑪ 项目入口回归：模态新建、项目任务混排、非空项目不可删', async ({ petApp, petPage }) => {
  await captureTray(petApp, petPage)
  const page = await openTasks(petApp)
  await selectCategory(page, '项目')
  await expect(page.getByText('还没有项目，先建一个')).toBeVisible()

  // 顶部 summary 与空态各有一个「新建项目」；限定空态容器，避免 strict 命中 2 个
  await page.locator('.tasks__state').getByRole('button', { name: '新建项目', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新建项目' })
  await dialog.getByLabel('项目名称', { exact: true }).fill('0.4.2项目')
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click()
  await expect(page.getByRole('button', { name: '打开项目「0.4.2项目」' })).toBeVisible()

  // 项目详情新增紧急任务（今日可混排）
  await page.getByRole('button', { name: '打开项目「0.4.2项目」' }).click()
  const panel = await openComposer(page)
  await panel.getByRole('button', { name: '详情', exact: true }).click()
  await panel
    .getByRole('group', { name: '任务重要性' })
    .getByRole('button', { name: '紧急' })
    .click()
  await panel.getByPlaceholder('添加任务，回车保存').fill('0.4.2项目任务')
  await panel.getByPlaceholder('添加任务，回车保存').press('Enter')
  await expect(panel.getByText('已添加')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '返回项目列表' }).click()

  // 非空项目删除禁用
  const card = page.locator('.project-card').filter({ hasText: '0.4.2项目' })
  await expect(card.getByRole('button', { name: '删除项目「0.4.2项目」' })).toBeDisabled()

  // 取消项目分类 → 单列表混排（项目任务带项目标签）
  await selectCategory(page, '项目')
  await expect(page.getByText('全部分类混排（项目任务带项目标签）')).toBeVisible()
  await expect(taskRow(page, '0.4.2项目任务').locator('.task-tag')).toHaveText('项目：0.4.2项目')
})

// ---------------------------------------------------------------------------
// 9. 权限 + 旧通道
// ---------------------------------------------------------------------------

test('⑫ 任务窗权限：tasks/projects/habits 允许，window/settings 拒绝，旧 tasks:checkin 不存在', async ({
  petApp,
  petPage,
}) => {
  await captureTray(petApp, petPage)
  const page = await openTasks(petApp)

  const allowed = await page.evaluate(async () => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    const bootstrap = await pet.bootstrap()
    const created = await pet.createTask({ title: '权限-任务' })
    const archived = await pet.setTaskArchived({ id: created.id, archived: true })
    await pet.setTaskArchived({ id: created.id, archived: false })
    await pet.deleteTask(created.id)
    return {
      version: bootstrap.ipcVersion,
      archivedAt: archived.archivedAt,
      hasLegacyCheckin: 'checkinDay' in pet,
      hasHabits: 'listHabits' in pet,
    }
  })
  expect(allowed.version).toBe('2.0.0')
  expect(allowed.archivedAt).toEqual(expect.any(Number))
  expect(allowed.hasLegacyCheckin).toBe(false)
  expect(allowed.hasHabits).toBe(true)

  const rejected = await page.evaluate(async () => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    const calls = [
      () => pet.setClickThrough(true),
      () => pet.getClickThrough(),
      () => pet.moveBy(10, 10),
      () => pet.setVisible(false),
      () => pet.resetPosition(),
      () => pet.getPlacement(),
      () => pet.showContextMenu('pet'),
      () => pet.setBubbleVisible(false),
      () => pet.setBubbleRegion(null),
      () => pet.getSettings(),
      () => pet.updateSettings({ muted: true }),
      () => pet.openTasks(),
    ]
    const outcomes: boolean[] = []
    for (const call of calls) {
      try {
        await call()
        outcomes.push(false)
      } catch (error) {
        outcomes.push(String(error).includes('IPC_SENDER_REJECTED'))
      }
    }
    return outcomes
  })
  expect(rejected).toEqual(Array<boolean>(12).fill(true))
})

// ---------------------------------------------------------------------------
// 10. 任务窗最大化/还原（回归）
// ---------------------------------------------------------------------------

test('⑬ 任务窗可最大化/还原，还原后单列表仍可用', async ({ petApp, petPage }) => {
  await captureTray(petApp, petPage)
  const page = await openTasks(petApp)
  const findWindow = (): Promise<{ maximizable: boolean; maximized: boolean }> =>
    petApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((entry) =>
        entry.webContents.getURL().includes('tasks.html'),
      )
      if (win === undefined) throw new Error('任务窗不存在')
      return { maximizable: win.isMaximizable(), maximized: win.isMaximized() }
    })
  await expect.poll(findWindow).toEqual({ maximizable: true, maximized: false })
  await petApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((entry) => entry.webContents.getURL().includes('tasks.html'))
      ?.maximize()
  })
  await expect.poll(async () => (await findWindow()).maximized).toBe(true)
  await expect(page.getByRole('tab', { name: '待办', exact: true })).toBeVisible()
  await petApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((entry) => entry.webContents.getURL().includes('tasks.html'))
      ?.unmaximize()
  })
  await expect.poll(async () => (await findWindow()).maximized).toBe(false)
  await expect(page.getByRole('button', { name: '新建任务', exact: true })).toBeVisible()
})

// ---------------------------------------------------------------------------
// 11. tasks.json v3 与 TaskStats（统计排除搁置的 API 面）
// ---------------------------------------------------------------------------

test('⑭ tasks.json v3 落盘；TaskStats 5 字段且统计排除搁置', async ({ petApp, petPage }) => {
  await captureTray(petApp, petPage)
  const page = await openTasks(petApp)
  const row = await addTaskViaComposer(page, '磁盘-任务')
  await expect(row).toHaveCount(1)
  const profile = await profileOf(petApp)
  const disk = await readTaskFile(profile)
  expect(disk['version']).toBe(3)
  expect(disk).not.toHaveProperty('checkins')
  expect('migration' in disk).toBe(true)
  const diskTasks = disk['tasks'] as Array<Record<string, unknown>>
  expect(diskTasks[0]).toMatchObject({
    title: '磁盘-任务',
    archivedAt: null,
    reminderLeadMinOverride: null,
  })

  // 搁置后 TaskStats.todayTotal 排除搁置；archived 视图仍可取回
  const stats = await page.evaluate(async () => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    const before = await pet.getTaskStats()
    const snapshot = await pet.listTasks({ scope: 'all' })
    const target = snapshot.tasks[0]
    if (target === undefined) throw new Error('缺少任务')
    await pet.setTaskArchived({ id: target.id, archived: true })
    const after = await pet.getTaskStats()
    const archived = await pet.listTasks({ scope: 'all', view: 'archived' })
    return {
      keys: Object.keys(before).sort(),
      beforeTotal: before.todayTotal,
      afterTotal: after.todayTotal,
      archivedCount: archived.tasks.length,
    }
  })
  expect(stats.keys).toEqual(['overdue', 'todayDone', 'todayKey', 'todayTotal', 'totalTodo'].sort())
  expect(stats.beforeTotal).toBe(1)
  expect(stats.afterTotal).toBe(0)
  expect(stats.archivedCount).toBe(1)
})

// ---------------------------------------------------------------------------
// 独立启动：任务窗尺寸/最小尺寸/可最大化（与其它 spec 相同口径）
// ---------------------------------------------------------------------------

baseTest('任务窗尺寸 900×680、最小 720×480、可最大化', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'whale-pet-tasks-window-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ autostart: false }), 'utf8')
  let application: ElectronApplication | undefined
  try {
    application = await launchIsolated(profile)
    const pet = await application.firstWindow()
    await expect(pet.locator('.pet-sprite')).toBeVisible()
    const opened = application.waitForEvent('window')
    await pet.evaluate(() => (globalThis as unknown as { pet: PetApi }).pet.openTasks())
    const tasks = await opened
    await expect(tasks.getByRole('heading', { level: 1, name: '任务清单' })).toBeVisible()
    const bounds = await application.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((entry) =>
        entry.webContents.getURL().includes('tasks.html'),
      )
      return win === undefined
        ? null
        : {
            outer: win.getBounds(),
            minSize: win.getMinimumSize(),
            maximizable: win.isMaximizable(),
          }
    })
    expect(bounds).not.toBeNull()
    expect(Math.abs((bounds?.outer.width ?? 0) - 900)).toBeLessThanOrEqual(1)
    expect(Math.abs((bounds?.outer.height ?? 0) - 680)).toBeLessThanOrEqual(1)
    expect(bounds?.minSize).toEqual([720, 480])
    expect(bounds?.maximizable).toBe(true)
  } finally {
    try {
      if (application !== undefined) await application.close()
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    }
  }
})
