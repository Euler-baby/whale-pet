/**
 * tasks.json v2 → v3 迁移冒烟（0.4.0；docs/37 §5 M-01..M-10 中可自动化部分）
 *
 * 全部用例使用 mkdtemp 隔离目录 + 人工构造 v2/settings 夹具，**不读取个人 userData**。
 * 覆盖：原字节备份（tasks.v2.json/settings.json/manifest 哈希）、v3 丢弃旧 checkins 并记录
 * droppedLegacyCheckins、任务/项目/提醒消费映射保留、settings 迁移期间不改写、重启不重复迁移、
 * 坏 v2/非法 v2/未知版本/非法 v3 与备份失败时保护原文件（不重置、不清空、无半迁移）。
 *
 * 时序：迁移发生在 main `createTaskStore` 初始化（窗口 ready 前）；断言在应用运行期间读取磁盘，
 * 避免退出时 settings 正常 flush 覆盖“迁移未改写 settings”的证据。
 *
 * 本机 DSH 沙箱内 Electron 无法启动（spawn EPERM），这些用例由宿主执行 `pnpm smoke`。
 */
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { PetApi } from '../../src/shared/ipc'

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')

const T0 = 1_760_000_000_000
const HOUR = 3_600_000

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

function launch(profile: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${profile}`],
    env: isolatedEnv(profile),
  })
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function openTasks(application: ElectronApplication, pet: Page): Promise<Page> {
  const opened = application.waitForEvent('window')
  await pet.evaluate(() => (globalThis as unknown as { pet: PetApi }).pet.openTasks())
  const page = await opened
  await expect(page.getByRole('heading', { level: 1, name: '任务清单' })).toBeVisible()
  return page
}

interface V2Fixture {
  bytes: string
  checkinCount: number
  tasks: Array<Record<string, unknown>>
  projects: Array<Record<string, unknown>>
}

/** 合法 v2：5 条任务（含项目任务/已完成/两阶段提醒消费）+ 2 条旧打卡 + 1 个项目 */
function buildValidV2Fixture(): V2Fixture {
  const due = T0 + 4 * HOUR
  const tasks: Array<Record<string, unknown>> = [
    {
      id: 'task-life',
      title: '旧任务-生活',
      category: 'life',
      projectId: null,
      importance: 'high',
      status: 'todo',
      dueAt: due,
      remindedAt: null,
      note: '迁移备注',
      createdAt: T0,
      updatedAt: T0,
      completedAt: null,
      todayPinnedDayKey: null,
    },
    {
      id: 'task-done',
      title: '旧任务-已完成',
      category: 'sport',
      projectId: null,
      importance: 'normal',
      status: 'done',
      dueAt: null,
      remindedAt: null,
      note: null,
      createdAt: T0 - 2 * HOUR,
      updatedAt: T0 - HOUR,
      completedAt: T0 - HOUR,
      todayPinnedDayKey: null,
    },
    {
      id: 'task-proj',
      title: '旧任务-项目',
      category: null,
      projectId: 'proj-1',
      importance: 'urgent',
      status: 'todo',
      dueAt: null,
      remindedAt: null,
      note: null,
      createdAt: T0 - HOUR,
      updatedAt: T0 - HOUR,
      completedAt: null,
      todayPinnedDayKey: null,
    },
    {
      id: 'task-soon-consumed',
      title: '旧任务-仅临近已提醒',
      category: 'study',
      projectId: null,
      importance: 'normal',
      status: 'todo',
      dueAt: due,
      remindedAt: due - 20 * 60_000,
      note: null,
      createdAt: T0 - HOUR,
      updatedAt: T0,
      completedAt: null,
      todayPinnedDayKey: null,
    },
    {
      id: 'task-due-consumed',
      title: '旧任务-两阶段已提醒',
      category: 'life',
      projectId: null,
      importance: 'normal',
      status: 'todo',
      dueAt: due,
      remindedAt: due + 5 * 60_000,
      note: null,
      createdAt: T0 - HOUR,
      updatedAt: T0,
      completedAt: null,
      todayPinnedDayKey: null,
    },
  ]
  const projects = [
    { id: 'proj-1', name: '旧项目', note: '项目备注', createdAt: T0, updatedAt: T0 },
  ]
  const checkins = [
    { dayKey: '2026-10-20', checkedAt: T0, doneCount: 1, totalCount: 2, note: null },
    {
      dayKey: '2026-10-19',
      checkedAt: T0 - 24 * HOUR,
      doneCount: 0,
      totalCount: 1,
      note: '旧备注',
    },
  ]
  return {
    bytes: `${JSON.stringify({ version: 2, tasks, projects, checkins }, null, 2)}\n`,
    checkinCount: checkins.length,
    tasks,
    projects,
  }
}

const V2_SETTINGS_BYTES = `${JSON.stringify({
  autostart: true,
  muted: false,
  reminderLeadMin: 30,
  legacyField: 'keep-me',
})}\n`

async function writeV2Fixture(profile: string): Promise<V2Fixture> {
  const fixture = buildValidV2Fixture()
  await writeFile(join(profile, 'tasks.json'), fixture.bytes, 'utf8')
  await writeFile(join(profile, 'settings.json'), V2_SETTINGS_BYTES, 'utf8')
  return fixture
}

async function backupDirs(profile: string): Promise<string[]> {
  try {
    const entries = await readdir(join(profile, 'backups'), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
}

test('⑮ v2→v3 迁移：原字节备份、v3 丢弃旧打卡、任务/项目/提醒映射保留、settings 不改写', async () => {
  test.setTimeout(120_000)
  const profile = await mkdtemp(join(tmpdir(), 'whale-pet-migrate-'))
  let application: ElectronApplication | undefined
  try {
    const fixture = await writeV2Fixture(profile)
    const settingsBefore = await readFile(join(profile, 'settings.json'))

    application = await launch(profile)
    const pet = await application.firstWindow()
    await expect(pet.locator('.pet-sprite')).toBeVisible()

    // bootstrap：契约 2.0.0 + 旧 settings（缺 version/hudScope/custom）读取兼容
    const bootstrap = await pet.evaluate(async () =>
      (globalThis as unknown as { pet: PetApi }).pet.bootstrap(),
    )
    expect(bootstrap.ipcVersion).toBe('2.0.0')
    expect(bootstrap.settings).toMatchObject({
      autostart: true,
      reminderLeadMin: 30,
      customReminderLeadMin: null,
      hudScope: 'urgent',
    })

    // 迁移未改写 settings（证据必须在应用运行期间读取）
    expect(sha256(await readFile(join(profile, 'settings.json')))).toBe(sha256(settingsBefore))

    const migrated = await readJson(join(profile, 'tasks.json'))
    expect(migrated['version']).toBe(3)
    expect(migrated).not.toHaveProperty('checkins')
    expect(migrated['habits']).toEqual([])
    expect(migrated['habitCheckins']).toEqual([])

    const migration = migrated['migration'] as Record<string, unknown>
    expect(migration).toMatchObject({
      fromVersion: 2,
      droppedLegacyCheckins: fixture.checkinCount,
      tasksSha256: sha256(fixture.bytes),
      settingsSha256: sha256(settingsBefore),
    })
    expect(migration['backupId']).toEqual(expect.any(String))

    const migratedTasks = migrated['tasks'] as Array<Record<string, unknown>>
    expect(migratedTasks.map((task) => task['id'])).toEqual(fixture.tasks.map((task) => task['id']))
    expect(migrated['projects']).toEqual(fixture.projects)

    const byId = new Map(migratedTasks.map((task) => [String(task['id']), task]))
    expect(byId.get('task-life')).toMatchObject({
      title: '旧任务-生活',
      category: 'life',
      importance: 'high',
      note: '迁移备注',
      archivedAt: null,
      reminderLeadMinOverride: null,
    })
    const lifeReminderState = byId.get('task-life')?.['reminderState'] as
      Record<string, unknown> | undefined
    expect(lifeReminderState?.dueAt).toBe(byId.get('task-life')?.['dueAt'])
    expect(byId.get('task-soon-consumed')?.['reminderState']).toMatchObject({
      soonConsumedAt: expect.any(Number),
      dueConsumedAt: null,
    })
    expect(byId.get('task-due-consumed')?.['reminderState']).toMatchObject({
      soonConsumedAt: expect.any(Number),
      dueConsumedAt: expect.any(Number),
    })
    // 已完成任务保持 done/completedAt
    expect(byId.get('task-done')).toMatchObject({
      status: 'done',
      completedAt: T0 - HOUR,
    })

    // 备份目录：独占 pre-v3-*，包含原字节 + manifest（最后写、complete:true、哈希可复核）
    const dirs = await backupDirs(profile)
    expect(dirs).toHaveLength(1)
    expect(dirs[0]).toMatch(/^pre-v3-/)
    expect(dirs[0]).toBe(migration['backupId'])
    const backupDir = join(profile, 'backups', dirs[0]!)
    expect(await readFile(join(backupDir, 'tasks.v2.json'), 'utf8')).toBe(fixture.bytes)
    expect(await readFile(join(backupDir, 'settings.json'), 'utf8')).toBe(
      settingsBefore.toString('utf8'),
    )
    const manifest = await readJson(join(backupDir, 'manifest.json'))
    expect(manifest).toMatchObject({
      backupId: migration['backupId'],
      complete: true,
      files: {
        tasks: { present: true, sha256: sha256(fixture.bytes) },
        settings: { present: true, sha256: sha256(settingsBefore) },
      },
    })

    // UI：任务/项目可读，旧打卡入口已不存在
    const page = await openTasks(application, pet)
    await page.getByRole('tab', { name: '全部', exact: true }).click()
    await expect(page.locator('.task-item').filter({ hasText: '旧任务-生活' })).toHaveCount(1)
    await expect(page.getByRole('button', { name: '今日打卡' })).toHaveCount(0)
    await expect(page.getByText(/连续/)).toHaveCount(0)
  } finally {
    try {
      if (application !== undefined) await application.close()
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    }
  }
})

test('⑯ 已完成迁移的 v3：重启不重复迁移、不新增备份，新数据（习惯/搁置）保留', async () => {
  test.setTimeout(150_000)
  const profile = await mkdtemp(join(tmpdir(), 'whale-pet-migrate-restart-'))
  let application: ElectronApplication | undefined
  const boot = (): Promise<ElectronApplication> => launch(profile)
  try {
    await writeV2Fixture(profile)
    application = await boot()
    const pet = await application.firstWindow()
    await expect(pet.locator('.pet-sprite')).toBeVisible()
    const page = await openTasks(application, pet)
    // 迁移后新写数据：创建打卡项目 + 搁置一条旧任务
    await page.evaluate(async () => {
      const api = (globalThis as unknown as { pet: PetApi }).pet
      await api.createHabit({
        name: '迁移后新习惯',
        schedule: { frequency: 'daily', deadlineWeekday: null },
      })
      const snapshot = await api.listTasks({ scope: 'all' })
      const target = snapshot.tasks.find((task) => task.title === '旧任务-生活')
      if (target === undefined) throw new Error('缺少迁移任务')
      await api.setTaskArchived({ id: target.id, archived: true })
    })
    const firstMigration = (await readJson(join(profile, 'tasks.json')))['migration'] as Record<
      string,
      unknown
    >
    expect(await backupDirs(profile)).toHaveLength(1)
    const firstPid = application.process().pid

    await application.close()
    application = undefined
    application = await boot()
    expect(application.process().pid).not.toBe(firstPid)
    const newPet = await application.firstWindow()
    await expect(newPet.locator('.pet-sprite')).toBeVisible()
    const reopened = await openTasks(application, newPet)

    // 不重复迁移、不新增备份
    expect(await backupDirs(profile)).toHaveLength(1)
    const second = await readJson(join(profile, 'tasks.json'))
    expect(second['migration']).toEqual(firstMigration)
    const tasks = second['tasks'] as Array<Record<string, unknown>>
    expect(tasks.find((task) => task['title'] === '旧任务-生活')?.['archivedAt']).toEqual(
      expect.any(Number),
    )
    expect(second['habits']).toHaveLength(1)

    const data = await reopened.evaluate(async () => {
      const api = (globalThis as unknown as { pet: PetApi }).pet
      const habits = await api.listHabits()
      const archived = await api.listTasks({ scope: 'all', view: 'archived' })
      return {
        habitNames: habits.map((entry) => entry.habit.name),
        archivedTitles: archived.tasks.map((task) => task.title),
      }
    })
    expect(data.habitNames).toEqual(['迁移后新习惯'])
    expect(data.archivedTitles).toEqual(['旧任务-生活'])
  } finally {
    try {
      if (application !== undefined) await application.close()
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    }
  }
})

test('⑰ 坏 v2 / 非法 v2 / 未知版本 / 非法 v3：保护原文件，不重置、无备份', async () => {
  test.setTimeout(180_000)
  const scenarios: Array<{ name: string; content: string }> = [
    { name: '坏 JSON', content: '{"version": 2, "tasks": [' },
    {
      name: '非法 v2（XOR 违规）',
      content: JSON.stringify({
        version: 2,
        tasks: [
          {
            id: 'x',
            title: '坏',
            category: null,
            projectId: null,
            importance: 'normal',
            status: 'todo',
            dueAt: null,
            remindedAt: null,
            note: null,
            createdAt: 1,
            updatedAt: 1,
            completedAt: null,
            todayPinnedDayKey: null,
          },
        ],
        projects: [],
        checkins: [],
      }),
    },
    { name: '未知版本 v4', content: JSON.stringify({ version: 4, tasks: [], projects: [] }) },
    { name: '旧 v1', content: JSON.stringify({ version: 1, tasks: [], checkins: [] }) },
  ]

  for (const scenario of scenarios) {
    const profile = await mkdtemp(join(tmpdir(), 'whale-pet-migrate-protect-'))
    let application: ElectronApplication | undefined
    try {
      await writeFile(join(profile, 'tasks.json'), scenario.content, 'utf8')
      application = await launch(profile)
      const pet = await application.firstWindow()
      await expect(pet.locator('.pet-sprite')).toBeVisible()
      const bootstrap = await pet.evaluate(async () =>
        (globalThis as unknown as { pet: PetApi }).pet.bootstrap(),
      )
      expect(bootstrap.ipcVersion).toBe('2.0.0')

      // 原文件字节不变、不产生迁移备份（绝不清空成空 v2/v3）
      expect(await readFile(join(profile, 'tasks.json'), 'utf8')).toBe(scenario.content)
      expect(await backupDirs(profile)).toEqual([])

      // 任务写操作被拒绝（保护错误态）
      const writeResult = await pet.evaluate(async () => {
        const api = (globalThis as unknown as { pet: PetApi }).pet
        try {
          await api.createTask({ title: '保护态写入' })
          return 'written'
        } catch (error) {
          return String(error)
        }
      })
      expect(writeResult).toMatch(/保护|迁移失败|不支持/)

      // 任务窗显示加载失败并提供重试（不是空数据）
      const page = await openTasks(application, pet)
      await expect(page.getByText('任务加载失败')).toBeVisible()
      await expect(page.getByRole('button', { name: '重试' })).toBeVisible()
    } finally {
      try {
        if (application !== undefined) await application.close()
      } finally {
        await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      }
    }
  }
})

test('⑱ 备份失败（backups 路径被文件占用）：停止迁移、原 v2/settings 字节不变', async () => {
  test.setTimeout(120_000)
  const profile = await mkdtemp(join(tmpdir(), 'whale-pet-migrate-backupfail-'))
  let application: ElectronApplication | undefined
  try {
    const fixture = await writeV2Fixture(profile)
    // 让 backupRoot（userData/backups）无法作为目录创建 → 备份失败
    await writeFile(join(profile, 'backups'), 'not-a-directory', 'utf8')
    application = await launch(profile)
    const pet = await application.firstWindow()
    await expect(pet.locator('.pet-sprite')).toBeVisible()

    expect(await readFile(join(profile, 'tasks.json'), 'utf8')).toBe(fixture.bytes)
    expect(sha256(await readFile(join(profile, 'settings.json')))).toBe(sha256(V2_SETTINGS_BYTES))
    const writeResult = await pet.evaluate(async () => {
      const api = (globalThis as unknown as { pet: PetApi }).pet
      try {
        await api.createTask({ title: '备份失败写入' })
        return 'written'
      } catch (error) {
        return String(error)
      }
    })
    expect(writeResult).toMatch(/保护|迁移失败/)
    const page = await openTasks(application, pet)
    await expect(page.getByText('任务加载失败')).toBeVisible()
  } finally {
    try {
      if (application !== undefined) await application.close()
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    }
  }
})

test('⑲ 新安装：无 tasks.json 不主动建文件；首次写盘为 v3(migration=null)；旧 settings 首次保存写 version=1', async () => {
  test.setTimeout(120_000)
  const profile = await mkdtemp(join(tmpdir(), 'whale-pet-fresh-'))
  let application: ElectronApplication | undefined
  try {
    await writeFile(
      join(profile, 'settings.json'),
      JSON.stringify({ autostart: false, muted: false, legacy: 'keep' }),
      'utf8',
    )
    application = await launch(profile)
    const pet = await application.firstWindow()
    await expect(pet.locator('.pet-sprite')).toBeVisible()
    // 新安装：没有文件时不主动写盘
    await expect
      .poll(async () => {
        try {
          await readFile(join(profile, 'tasks.json'))
          return 'exists'
        } catch {
          return 'missing'
        }
      })
      .toBe('missing')

    await pet.evaluate(() =>
      (globalThis as unknown as { pet: PetApi }).pet.createTask({ title: '新装首条任务' }),
    )
    const disk = await readJson(join(profile, 'tasks.json'))
    expect(disk['version']).toBe(3)
    expect(disk['migration']).toBeNull()
    expect(disk['habits']).toEqual([])
    expect(disk['habitCheckins']).toEqual([])
    expect((disk['tasks'] as Array<Record<string, unknown>>)[0]?.['title']).toBe('新装首条任务')

    // 旧 settings 缺 version：读取兼容；首次实际保存写 version=1 且保留未知字段
    await pet.evaluate(() =>
      (globalThis as unknown as { pet: PetApi }).pet.updateSettings({ muted: true }),
    )
    await expect
      .poll(async () => {
        try {
          return (await readJson(join(profile, 'settings.json')))['version']
        } catch {
          return null
        }
      })
      .toBe(1)
    const settingsDisk = await readJson(join(profile, 'settings.json'))
    expect(settingsDisk['legacy']).toBe('keep')
    expect(settingsDisk['muted']).toBe(true)
  } finally {
    try {
      if (application !== undefined) await application.close()
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    }
  }
})
