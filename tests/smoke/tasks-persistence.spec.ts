/**
 * 任务/项目/习惯持久化与提醒冒烟（0.4.0，契约 2.0；tasks.json v3）
 *
 * 覆盖：真正退出并重启主进程后，编辑/完成/搁置/删除撤销缓存/习惯打卡的持久化；
 * tasks.json v3 形状（无顶层 checkins、habits/habitCheckins 落盘、migration=null）；
 * 项目/项目任务重启保留；隐藏窗口跳过提醒、显示后补发的 DND 保护。
 *
 * 本机 DSH 沙箱内 Electron 无法启动（spawn EPERM），由宿主执行 `pnpm smoke`。
 */
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { PetApi } from '../../src/shared/ipc'
import type { Task } from '../../src/shared/types'

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

async function openTasks(app: ElectronApplication, pet: Page): Promise<Page> {
  const opened = app.waitForEvent('window')
  await pet.evaluate(() => (globalThis as unknown as { pet: PetApi }).pet.openTasks())
  const page = await opened
  await expect(page.getByRole('heading', { name: '任务清单', exact: true })).toBeVisible()
  return page
}

/** 0.4.2：顶部 QuickAdd 已移除；用 FAB 打开底部面板录入，提交后 Esc 关闭避免 overlay 拦截 */
async function addTaskViaComposer(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: '新建任务', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '新建任务面板' })
  await expect(panel).toBeVisible()
  const input = panel.getByPlaceholder('添加任务，回车保存')
  await input.fill(title)
  await input.press('Enter')
  await expect(panel.getByText('已添加')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel).not.toBeVisible()
}

test('真正退出并重启：编辑/完成/搁置/习惯打卡持久化，撤销缓存不跨进程；tasks.json v3 落盘', async () => {
  test.setTimeout(150_000)
  const profile = await mkdtemp(join(tmpdir(), 'whale-pet-tasks-restart-'))
  const env = isolatedEnv(profile)
  let application: ElectronApplication | undefined
  const launch = () =>
    electron.launch({
      args: [resolve(__dirname, '../../out/main/index.js'), `--user-data-dir=${profile}`],
      env,
    })
  try {
    application = await launch()
    const pet = await application.firstWindow()
    await expect(pet.locator('.pet-sprite')).toBeVisible()
    const page = await openTasks(application, pet)

    // 1) 普通任务：创建 → 编辑备注 → 完成
    await addTaskViaComposer(page, '重启后继续学习')
    const row = page.locator('.task-item').filter({ hasText: '重启后继续学习' })
    await row.getByRole('button', { name: '编辑任务「重启后继续学习」' }).click()
    const editor = page.getByRole('dialog', { name: '编辑任务' })
    await editor.getByLabel('备注', { exact: true }).fill('这条备注需要真正写入磁盘')
    await editor.getByRole('button', { name: '保存修改', exact: true }).click()
    await expect(editor).not.toBeVisible()
    await row.getByRole('checkbox').click()
    // 0.4.2 完成后留在单列表（划掉）；用 main 快照等待完成落库，不依赖视图切换。
    await expect
      .poll(async () =>
        page.evaluate(async (title) => {
          const api = (globalThis as unknown as { pet: PetApi }).pet
          const snapshot = await api.listTasks({ scope: 'all' })
          return snapshot.tasks.find((task) => task.title === title)?.status
        }, '重启后继续学习'),
      )
      .toBe('done')

    // 2) 搁置任务：创建 → 搁置
    await addTaskViaComposer(page, '重启后仍在搁置')
    const archiveRow = page.locator('.task-item').filter({ hasText: '重启后仍在搁置' })
    await archiveRow.getByRole('button', { name: '搁置任务「重启后仍在搁置」' }).click()
    await expect(archiveRow).toHaveCount(0)

    // 3) 习惯：创建 → 本期打卡（与任务统计完全独立）
    await page.getByRole('tab', { name: '打卡', exact: true }).click()
    const habit = await page.evaluate(async () => {
      const api = (globalThis as unknown as { pet: PetApi }).pet
      const created = await api.createHabit({
        name: '重启后仍在的打卡',
        schedule: { frequency: 'daily', deadlineWeekday: null },
      })
      return api.checkinHabit({
        habitId: created.habit.id,
        cycleKey: created.habit.currentCycle.key,
      })
    })
    expect(habit.isNew).toBe(true)

    // 4) 删除后不应跨进程撤销
    const removedId = await page.evaluate(async () => {
      const api = (globalThis as unknown as { pet: PetApi }).pet
      const removed = await api.createTask({ title: '删除后不应复活' })
      await api.deleteTask(removed.id)
      return removed.id
    })

    const before = await page.evaluate(async () => {
      const api = (globalThis as unknown as { pet: PetApi }).pet
      return {
        all: await api.listTasks({ scope: 'all' }),
        archived: await api.listTasks({ scope: 'all', view: 'archived' }),
        habits: await api.listHabits(),
      }
    })

    const firstPid = application.process().pid
    await application.close()
    application = undefined
    const disk = JSON.parse(await readFile(join(profile, 'tasks.json'), 'utf8')) as {
      version: number
      tasks: Task[]
      projects: unknown[]
      habits: Array<{ id: string }>
      habitCheckins: Array<{ habitId: string }>
      migration: unknown
    }
    // v3：无顶层 checkins；migration 为新安装 null；习惯与打卡同文件落盘
    expect(disk.version).toBe(3)
    expect(disk).not.toHaveProperty('checkins')
    expect(disk.migration).toBeNull()
    // 落盘顺序为插入顺序，与 listTasks 排序无关：按 ID 对内容
    const diskById = new Map(disk.tasks.map((task) => [task.id, task]))
    expect(diskById.size).toBe(before.all.tasks.length)
    for (const task of before.all.tasks) {
      expect(diskById.get(task.id)).toEqual(task)
    }
    expect(disk.projects).toEqual([])
    expect(disk.habits).toHaveLength(1)
    expect(disk.habitCheckins).toHaveLength(1)
    expect(disk.habitCheckins[0]?.habitId).toBe(disk.habits[0]?.id)

    application = await launch()
    expect(application.process().pid).not.toBe(firstPid)
    const newPet = await application.firstWindow()
    await expect(newPet.locator('.pet-sprite')).toBeVisible()
    const reopened = await openTasks(application, newPet)
    const after = await reopened.evaluate(async () => {
      const api = (globalThis as unknown as { pet: PetApi }).pet
      return {
        all: await api.listTasks({ scope: 'all' }),
        archived: await api.listTasks({ scope: 'all', view: 'archived' }),
        habits: await api.listHabits(),
      }
    })
    expect(after.all.tasks).toEqual(before.all.tasks)
    expect(after.archived.tasks.map((task) => task.title)).toEqual(['重启后仍在搁置'])
    expect(after.habits).toHaveLength(1)
    expect(after.habits[0]?.currentCheckin).not.toBeNull()
    expect(
      await reopened.evaluate(async (id) => {
        try {
          await (globalThis as unknown as { pet: PetApi }).pet.restoreTask(id)
          return false
        } catch {
          return true
        }
      }, removedId),
    ).toBe(true)
  } finally {
    try {
      if (application !== undefined) await application.close()
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    }
  }
})

test('真正重启后项目/项目任务/完成状态保留，tasks.json v3 projects 落盘', async () => {
  test.setTimeout(150_000)
  const profile = await mkdtemp(join(tmpdir(), 'whale-pet-projects-restart-'))
  const env = isolatedEnv(profile)
  let application: ElectronApplication | undefined
  const launch = () =>
    electron.launch({
      args: [resolve(__dirname, '../../out/main/index.js'), `--user-data-dir=${profile}`],
      env,
    })
  try {
    application = await launch()
    const pet = await application.firstWindow()
    await expect(pet.locator('.pet-sprite')).toBeVisible()
    const page = await openTasks(application, pet)

    const seeded = await page.evaluate(async () => {
      const api = (globalThis as unknown as { pet: PetApi }).pet
      const project = await api.createProject({ name: '重启项目', note: '重启后仍在' })
      const todo = await api.createTask({ title: '项目任务-未完成', projectId: project.id })
      const done = await api.createTask({ title: '项目任务-已完成', projectId: project.id })
      await api.toggleTask({ id: done.id, done: true })
      return { projectId: project.id, todoId: todo.id, doneId: done.id }
    })

    const before = await page.evaluate(async (projectId) => {
      const api = (globalThis as unknown as { pet: PetApi }).pet
      return {
        projects: await api.listProjects(),
        tasks: (await api.listTasks({ scope: 'project', projectId })).tasks,
      }
    }, seeded.projectId)
    expect(before.projects.map((project) => project.name)).toEqual(['重启项目'])
    expect(before.tasks.map((task) => task.title)).toEqual(['项目任务-未完成', '项目任务-已完成'])

    const disk = JSON.parse(await readFile(join(profile, 'tasks.json'), 'utf8')) as {
      version: number
      projects: Array<{ id: string; name: string; note: string | null }>
      tasks: Task[]
    }
    expect(disk.version).toBe(3)
    expect(disk.projects).toEqual([
      expect.objectContaining({ id: seeded.projectId, name: '重启项目', note: '重启后仍在' }),
    ])
    const diskTask = disk.tasks.find((task) => task.id === seeded.todoId)
    expect(diskTask?.category).toBeNull()
    expect(diskTask?.projectId).toBe(seeded.projectId)

    const firstPid = application.process().pid
    await application.close()
    application = undefined

    application = await launch()
    expect(application.process().pid).not.toBe(firstPid)
    const newPet = await application.firstWindow()
    await expect(newPet.locator('.pet-sprite')).toBeVisible()
    const reopened = await openTasks(application, newPet)
    const after = await reopened.evaluate(async (projectId) => {
      const api = (globalThis as unknown as { pet: PetApi }).pet
      const projects = await api.listProjects()
      const tasks = (await api.listTasks({ scope: 'project', projectId })).tasks
      return {
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
          note: project.note,
        })),
        tasks: tasks.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          category: task.category,
          projectId: task.projectId,
        })),
      }
    }, seeded.projectId)
    expect(after.projects).toEqual([{ id: seeded.projectId, name: '重启项目', note: '重启后仍在' }])
    expect(after.tasks).toEqual([
      {
        id: seeded.todoId,
        title: '项目任务-未完成',
        status: 'todo',
        category: null,
        projectId: seeded.projectId,
      },
      {
        id: seeded.doneId,
        title: '项目任务-已完成',
        status: 'done',
        category: null,
        projectId: seeded.projectId,
      },
    ])

    // 项目入口 UI 也能读回
    await reopened
      .getByRole('group', { name: '任务分类' })
      .getByRole('button', { name: '项目' })
      .click()
    await expect(reopened.getByRole('button', { name: '打开项目「重启项目」' })).toBeVisible()
  } finally {
    try {
      if (application !== undefined) await application.close()
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    }
  }
})

test('隐藏超过一次提醒 tick 不消费任务；显示后真实到期气泡可打开面板', async () => {
  test.setTimeout(100_000)
  // 0.3.2 起普通提醒固定免打扰 23:00–07:00（静默消费不弹泡），夜间运行该用例会误报；
  // DND 时序由 task-reminder 单测覆盖，这里在 DND 时段跳过。
  const hour = new Date().getHours()
  test.skip(hour >= 23 || hour < 7, '免打扰 23:00–07:00 时段：普通提醒静默，需在白天重跑')
  const profile = await mkdtemp(join(tmpdir(), 'whale-pet-tasks-reminder-'))
  let application: ElectronApplication | undefined
  try {
    application = await electron.launch({
      args: [
        resolve(__dirname, '../../out/main/index.js'),
        `--user-data-dir=${profile}`,
        '--hidden',
      ],
      env: isolatedEnv(profile),
    })
    const pet = await application.firstWindow()
    await expect(pet.locator('.pet-sprite')).toHaveCount(1)
    const id = await pet.evaluate(async () => {
      const api = (globalThis as unknown as { pet: PetApi }).pet
      return (await api.createTask({ title: '真实隐藏后补发提醒', dueAt: Date.now() - 60_000 })).id
    })
    await pet.waitForTimeout(31_000)
    const hidden = await pet.evaluate(async () => {
      const api = (globalThis as unknown as { pet: PetApi }).pet
      return { bootstrap: await api.bootstrap(), snapshot: await api.listTasks({ scope: 'all' }) }
    })
    expect(hidden.bootstrap.windowVisible).toBe(false)
    expect(hidden.snapshot.tasks[0]?.remindedAt).toBeNull()
    expect(hidden.snapshot.tasks[0]?.reminderState).toMatchObject({
      soonConsumedAt: null,
      dueConsumedAt: null,
    })
    await pet.evaluate(() => (globalThis as unknown as { pet: PetApi }).pet.setVisible(true))
    const action = pet.getByRole('button', { name: '打开任务清单', exact: true })
    await expect(action).toBeVisible({ timeout: 35_000 })
    await expect(pet.locator('.bubble')).toContainText('真实隐藏后补发提醒')
    const opened = application.waitForEvent('window')
    await action.click()
    const page = await opened
    await expect(page.getByRole('heading', { name: '任务清单', exact: true })).toBeVisible()
    await expect(page.locator('.task-item__title')).toHaveText('真实隐藏后补发提醒')
    const saved = await page.evaluate(() =>
      (globalThis as unknown as { pet: PetApi }).pet.listTasks({ scope: 'all' }),
    )
    expect(saved.tasks[0]?.id).toBe(id)
    expect(saved.tasks[0]?.remindedAt).not.toBeNull()
    expect(saved.tasks[0]?.reminderState.dueConsumedAt).not.toBeNull()
  } finally {
    try {
      if (application !== undefined) await application.close()
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    }
  }
})
