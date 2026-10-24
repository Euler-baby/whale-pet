/**
 * 任务/习惯存储（tasks.json v3 + 迁移）单测 · Agent-Data（0.4.0）
 *
 * 口径：docs/35 §1–§5、docs/37 M-01～M-10 / T-06～T-12 / H-05～H-13。
 * - 全部用例在 os.tmpdir() 的 mkdtemp 目录内读写真实文件（每个用例后清理）
 * - 时间/ID 注入固定值；迁移/备份使用隔离临时目录
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildInitialHabitCycle } from '@shared/habits'
import type { HabitSchedule } from '@shared/types'
import { createTask } from '@shared/tasks'
import type { TaskStore } from '@shared/tasks'
import type { Habit, HabitCheckin, Project, Task } from '@shared/types'

import type { TasksFileV3 } from '../../src/main/services/task-migration'
import {
  createTaskStore,
  parseTasksFileV3,
  TASKS_FILE_VERSION,
  TASK_DELETE_UNDO_MS,
} from '../../src/main/services/task-store'

/** 2026-10-21（周三）10:00 本地时间 */
const BASE = new Date(2026, 9, 21, 10, 0, 0).getTime()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function at(hour: number, minute = 0, day = 21): number {
  return new Date(2026, 9, day, hour, minute, 0).getTime()
}

/**
 * 建临时目录：优先 os.tmpdir()；受限沙箱里不可写时回退 node_modules/.cache。
 */
function createTempDir(): string {
  try {
    return mkdtempSync(join(tmpdir(), 'whale-store-'))
  } catch {
    const fallbackBase = join(process.cwd(), 'node_modules', '.cache')
    mkdirSync(fallbackBase, { recursive: true })
    return mkdtempSync(join(fallbackBase, 'whale-store-'))
  }
}

function seqIds(): () => string {
  let index = 0
  return () => {
    index += 1
    return `id-${String(index)}`
  }
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return { ...createTask({ title: '写周报', category: 'study' }, BASE, 'task-1'), ...overrides }
}

function makeHabitFixture(schedule: HabitSchedule, now: number = BASE, id = 'habit-1'): Habit {
  const { revision, cycle } = buildInitialHabitCycle(id, schedule, now)
  return {
    id,
    name: '背单词',
    note: null,
    createdAt: now,
    updatedAt: now,
    scheduleRevisions: [revision],
    currentCycle: cycle,
    pendingSchedule: null,
  }
}

const DAILY: HabitSchedule = { frequency: 'daily', deadlineWeekday: null }
const WEEKLY_SUNDAY: HabitSchedule = { frequency: 'weekly', deadlineWeekday: 7 }

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: TASKS_FILE_VERSION,
    tasks: [],
    projects: [],
    habits: [],
    habitCheckins: [],
    migration: null,
    ...overrides,
  })
}

function makeV2Task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'v2-task',
    title: '旧任务',
    category: 'study',
    projectId: null,
    importance: 'normal',
    status: 'todo',
    dueAt: null,
    remindedAt: null,
    note: null,
    createdAt: BASE,
    updatedAt: BASE,
    completedAt: null,
    todayPinnedDayKey: null,
    ...overrides,
  }
}

function v2Text(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 2,
    tasks: [],
    checkins: [],
    projects: [],
    ...overrides,
  })
}

let dir = ''
let filePath = ''
let settingsPath = ''
let backupRoot = ''
const stores: TaskStore[] = []

function openStore(
  overrides: { now?: () => number; id?: () => string; appVersion?: string } = {},
): TaskStore {
  const store = createTaskStore({
    filePath,
    settingsFilePath: settingsPath,
    backupRoot,
    appVersion: overrides.appVersion ?? '0.3.3',
    now: overrides.now,
    id: overrides.id,
  })
  stores.push(store)
  return store
}

function readFileJson(): TasksFileV3 {
  return JSON.parse(readFileSync(filePath, 'utf8')) as TasksFileV3
}

function backupDirs(): string[] {
  if (!existsSync(backupRoot)) return []
  return readdirSync(backupRoot)
}

beforeEach(() => {
  dir = createTempDir()
  filePath = join(dir, 'tasks.json')
  settingsPath = join(dir, 'settings.json')
  backupRoot = join(dir, 'backups')
  stores.length = 0
})

afterEach(() => {
  for (const store of stores) store.flush()
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// v3 解析
// ---------------------------------------------------------------------------

describe('parseTasksFileV3', () => {
  it('文件不存在 → missing', () => {
    const result = parseTasksFileV3(null)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('missing')
    expect(result.data).toBeNull()
  })

  it('坏 JSON / 非对象 / 版本不符', () => {
    expect(parseTasksFileV3('{ not json').reason).toBe('invalid-json')
    expect(parseTasksFileV3('[]').reason).toBe('invalid-shape')
    expect(parseTasksFileV3(JSON.stringify({ version: 2 })).reason).toBe('unsupported-version')
    expect(parseTasksFileV3(JSON.stringify({ version: 4 })).reason).toBe('unsupported-version')
  })

  it('合法最小 v3：顶层 checkins 被忽略（不会写回）', () => {
    const result = parseTasksFileV3(payload({ checkins: [{ dayKey: '2026-10-20' }] }))
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({
      version: 3,
      tasks: [],
      projects: [],
      habits: [],
      habitCheckins: [],
      migration: null,
    })
  })

  it('任务缺新字段 / reminderState.dueAt 不一致 / done+archived / 覆盖非法 → invalid-shape', () => {
    const task = makeTask()
    const cases: Record<string, unknown>[] = [
      { ...task, archivedAt: undefined },
      { ...task, reminderLeadMinOverride: undefined },
      { ...task, reminderState: undefined },
      { ...task, reminderState: { ...task.reminderState, dueAt: 1 } },
      { ...task, status: 'done', completedAt: BASE, archivedAt: BASE },
      { ...task, reminderLeadMinOverride: 0 },
    ]
    for (const broken of cases) {
      expect(parseTasksFileV3(payload({ tasks: [broken] })).reason).toBe('invalid-shape')
    }
  })

  it('习惯/打卡不变量：key 不一致、pending 生效点不等于 endAt、打卡越界、cycleKey 重复 → invalid-shape', () => {
    const habit = makeHabitFixture(DAILY)
    const goodCheckin: HabitCheckin = {
      id: 'c1',
      habitId: habit.id,
      cycleKey: habit.currentCycle.key,
      cycle: habit.currentCycle,
      checkedAt: BASE + MINUTE,
      note: null,
    }

    expect(
      parseTasksFileV3(
        payload({ habits: [{ ...habit, currentCycle: { ...habit.currentCycle, key: 'bad' } }] }),
      ).reason,
    ).toBe('invalid-shape')

    expect(
      parseTasksFileV3(
        payload({
          habits: [
            {
              ...habit,
              pendingSchedule: {
                schedule: WEEKLY_SUNDAY,
                requestedAt: BASE,
                effectiveAt: BASE,
              },
            },
          ],
        }),
      ).reason,
    ).toBe('invalid-shape')

    // 没有对应 habit 的打卡
    expect(
      parseTasksFileV3(payload({ habits: [habit], habitCheckins: [{ ...goodCheckin }] })).ok,
    ).toBe(true)
    expect(
      parseTasksFileV3(
        payload({ habits: [habit], habitCheckins: [{ ...goodCheckin, habitId: 'missing' }] }),
      ).reason,
    ).toBe('invalid-shape')
    // 打卡时间落在周期之外
    expect(
      parseTasksFileV3(
        payload({
          habits: [habit],
          habitCheckins: [{ ...goodCheckin, checkedAt: habit.currentCycle.endAt }],
        }),
      ).reason,
    ).toBe('invalid-shape')
    // 同一 cycleKey 重复
    expect(
      parseTasksFileV3(
        payload({
          habits: [habit],
          habitCheckins: [goodCheckin, { ...goodCheckin, id: 'c2' }],
        }),
      ).reason,
    ).toBe('invalid-shape')
  })
})

// ---------------------------------------------------------------------------
// 加载与写入
// ---------------------------------------------------------------------------

describe('v3 加载与写入', () => {
  it('文件不存在 → 空 v3 内存，不主动写盘', () => {
    const store = openStore({ now: () => BASE })
    expect(store.getTasks()).toEqual([])
    expect(store.getProjects()).toEqual([])
    expect(store.listHabits(BASE)).toEqual([])
    expect(store.getStats(BASE)).toEqual({
      todayKey: '2026-10-21',
      todayTotal: 0,
      todayDone: 0,
      overdue: 0,
      totalTodo: 0,
    })
    expect(existsSync(filePath)).toBe(false)
  })

  it('合法 v3 读写：新增字段与 migration 回执保留，重启读回', () => {
    const receipt = {
      fromVersion: 2 as const,
      backupId: 'pre-v3-20261024-010203-abcd1234',
      tasksSha256: 'a'.repeat(64),
      settingsSha256: null,
      migratedAt: BASE,
      droppedLegacyCheckins: 2,
    }
    writeFileSync(filePath, payload({ migration: receipt }), 'utf8')

    const store = openStore({ id: () => 'task-a', now: () => BASE })
    expect(store.getTasks()).toEqual([])
    const created = store.create(
      { title: '新任务', dueAt: at(18), reminderLeadMinOverride: 30 },
      BASE,
    )
    expect(created).toMatchObject({
      archivedAt: null,
      reminderLeadMinOverride: 30,
      reminderState: { dueAt: at(18), soonConsumedAt: null, dueConsumedAt: null },
    })

    const onDisk = readFileJson()
    expect(onDisk.version).toBe(3)
    expect(onDisk.migration).toEqual(receipt)
    expect(onDisk.tasks).toEqual([created])

    const reopened = openStore()
    expect(reopened.getTasks()).toEqual([created])
  })

  it('未知版本 / 损坏 v3 → 保护错误态，不重置、不产生 .bad 备份', () => {
    for (const raw of [
      JSON.stringify({ version: 4, tasks: [] }),
      '{ broken',
      payload({ tasks: [{}] }),
    ]) {
      writeFileSync(filePath, raw, 'utf8')
      const store = openStore()
      expect(() => store.getTasks()).toThrow('任务文件版本不受支持或结构损坏')
      expect(readFileSync(filePath, 'utf8')).toBe(raw)
      expect(readdirSync(dir).some((name) => name.includes('.bad-'))).toBe(false)
      rmSync(filePath)
    }
  })

  it('读取非 ENOENT 错误 → 错误态（不覆盖原文件）', () => {
    mkdirSync(filePath)
    const store = openStore()
    expect(() => store.getTasks()).toThrow('无法读取任务文件')
    expect(readdirSync(filePath)).toEqual([])
  })

  it('写盘失败不污染内存，修复后可重试', () => {
    const store = openStore({ id: seqIds(), now: () => BASE })
    const created = store.create({ title: '已保存' }, BASE)
    const raw = readFileSync(filePath, 'utf8')

    mkdirSync(`${filePath}.tmp`)
    expect(() => store.create({ title: '写不进去' }, BASE)).toThrow('任务保存失败')
    expect(store.getTasks()).toEqual([created])
    expect(readFileSync(filePath, 'utf8')).toBe(raw)

    rmSync(`${filePath}.tmp`, { recursive: true, force: true })
    const retried = store.create({ title: '重试成功' }, BASE)
    expect(readFileJson().tasks).toEqual([created, retried])
  })
})

// ---------------------------------------------------------------------------
// v2 → v3 迁移
// ---------------------------------------------------------------------------

describe('v2 → v3 迁移', () => {
  function writeV2Fixture(): string {
    const raw = v2Text({
      projects: [{ id: 'proj-1', name: '项目一', note: '备注', createdAt: BASE, updatedAt: BASE }],
      tasks: [
        makeV2Task({ id: 't1', dueAt: at(18), remindedAt: at(17) }),
        makeV2Task({ id: 't2', dueAt: at(20, 18, 20), remindedAt: at(20, 19, 20) }),
        makeV2Task({ id: 't3', remindedAt: at(9) }),
        makeV2Task({ id: 't4', category: null, projectId: 'proj-1' }),
        makeV2Task({ id: 't5', status: 'done', completedAt: at(9) }),
      ],
      checkins: [
        { dayKey: '2026-10-19', checkedAt: BASE, doneCount: 1, totalCount: 2, note: null },
        { dayKey: '2026-10-20', checkedAt: BASE, doneCount: 0, totalCount: 1, note: '旧' },
      ],
    })
    writeFileSync(filePath, raw, 'utf8')
    return raw
  }

  it('成功迁移：备份原字节、丢弃旧 checkins、映射新字段、settings 不改写', () => {
    const settingsRaw = '{"version":1,"autostart":false}\n'
    writeFileSync(settingsPath, settingsRaw, 'utf8')
    const v2Raw = writeV2Fixture()
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    const store = openStore({ now: () => BASE })
    const tasks = store.getTasks()
    expect(tasks.map((task) => task.id)).toEqual(['t1', 't2', 't3', 't4', 't5'])
    expect(tasks.every((task) => task.archivedAt === null)).toBe(true)
    expect(tasks.every((task) => task.reminderLeadMinOverride === null)).toBe(true)

    const byId = new Map(tasks.map((task) => [task.id, task]))
    expect(byId.get('t1')?.reminderState).toEqual({
      dueAt: at(18),
      soonConsumedAt: at(17),
      dueConsumedAt: null,
    })
    expect(byId.get('t2')?.reminderState).toEqual({
      dueAt: at(20, 18, 20),
      soonConsumedAt: at(20, 19, 20),
      dueConsumedAt: at(20, 19, 20),
    })
    expect(byId.get('t3')?.reminderState).toEqual({
      dueAt: null,
      soonConsumedAt: null,
      dueConsumedAt: null,
    })
    expect(byId.get('t3')?.remindedAt).toBe(at(9))
    expect(store.getProjects()).toEqual([
      { id: 'proj-1', name: '项目一', note: '备注', createdAt: BASE, updatedAt: BASE },
    ])

    const onDisk = readFileJson()
    expect(onDisk.version).toBe(3)
    expect(onDisk.habits).toEqual([])
    expect(onDisk.habitCheckins).toEqual([])
    expect('checkins' in (onDisk as unknown as Record<string, unknown>)).toBe(false)
    expect(onDisk.migration).toMatchObject({ fromVersion: 2, droppedLegacyCheckins: 2 })
    expect(onDisk.migration?.backupId).toMatch(/^pre-v3-/)
    expect(onDisk.migration?.tasksSha256).toHaveLength(64)
    expect(onDisk.migration?.settingsSha256).toHaveLength(64)

    // 备份：原字节 + manifest 最后写；settings 未被迁移改写
    expect(backupDirs()).toHaveLength(1)
    const backupDir = join(backupRoot, backupDirs()[0] ?? '')
    expect(readFileSync(join(backupDir, 'tasks.v2.json'), 'utf8')).toBe(v2Raw)
    expect(readFileSync(join(backupDir, 'settings.json'), 'utf8')).toBe(settingsRaw)
    expect(readFileSync(settingsPath, 'utf8')).toBe(settingsRaw)
    const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8')) as {
      complete: boolean
      sourceAppVersion: string
      files: { tasks: { sha256: string }; settings: { sha256: string } }
    }
    expect(manifest.complete).toBe(true)
    expect(manifest.sourceAppVersion).toBe('0.3.3')
    expect(manifest.files.tasks.sha256).toBe(onDisk.migration?.tasksSha256)
    expect(infoSpy).toHaveBeenCalledTimes(1)
    infoSpy.mockRestore()
  })

  it('重启已完成迁移的 v3：不重复迁移、不新增备份', () => {
    writeV2Fixture()
    openStore()
    expect(backupDirs()).toHaveLength(1)
    const migratedRaw = readFileSync(filePath, 'utf8')

    openStore()
    expect(backupDirs()).toHaveLength(1)
    expect(readFileSync(filePath, 'utf8')).toBe(migratedRaw)
  })

  it('非法 v2 → 错误态保护原文件（不备份、不重置）', () => {
    const raw = v2Text({ tasks: [makeV2Task({ category: null, projectId: null })] })
    writeFileSync(filePath, raw, 'utf8')
    const store = openStore()
    expect(() => store.getTasks()).toThrow('任务文件迁移失败')
    expect(readFileSync(filePath, 'utf8')).toBe(raw)
    expect(backupDirs()).toEqual([])
  })

  it('备份失败 → 错误态，原 tasks/settings 不动', () => {
    const raw = writeV2Fixture()
    writeFileSync(settingsPath, '{"version":1}', 'utf8')
    // 用同名文件占住 backups 路径，令 mkdirSync(recursive) 失败
    writeFileSync(backupRoot, 'not-a-dir', 'utf8')

    const store = openStore()
    expect(() => store.getTasks()).toThrow('任务文件迁移失败')
    expect(readFileSync(filePath, 'utf8')).toBe(raw)
    expect(readFileSync(settingsPath, 'utf8')).toBe('{"version":1}')
  })

  it('settings 读取失败（路径是目录）→ 错误态保护原任务文件', () => {
    const raw = writeV2Fixture()
    rmSync(settingsPath, { force: true })
    mkdirSync(settingsPath)
    const store = openStore()
    expect(() => store.getTasks()).toThrow('任务文件迁移失败')
    expect(readFileSync(filePath, 'utf8')).toBe(raw)
  })

  it('v1/未知版本不自动迁移、不清空', () => {
    for (const raw of [
      JSON.stringify({ version: 1, tasks: [], checkins: [], projects: [] }),
      JSON.stringify({ version: 4, tasks: [], projects: [], habits: [], habitCheckins: [] }),
    ]) {
      writeFileSync(filePath, raw, 'utf8')
      const store = openStore()
      expect(() => store.getTasks()).toThrow('任务文件版本不受支持或结构损坏')
      expect(readFileSync(filePath, 'utf8')).toBe(raw)
      expect(backupDirs()).toEqual([])
      rmSync(filePath)
    }
  })
})

// ---------------------------------------------------------------------------
// 任务 CRUD / 状态 / 提醒消费
// ---------------------------------------------------------------------------

describe('任务 CRUD 与状态', () => {
  it('create/update 新字段往返，项目任务 XOR', () => {
    const store = openStore({ id: seqIds(), now: () => BASE })
    const project = store.createProject({ name: '项目一' }, BASE)
    const projectTask = store.create({ title: '项目任务', projectId: project.id }, BASE)
    expect(projectTask).toMatchObject({ category: null, projectId: project.id })
    expect(() =>
      store.create({ title: '冲突', category: 'study', projectId: project.id }, BASE),
    ).toThrow('项目任务不能设置分类')
    expect(() => store.create({ title: '无项目', projectId: 'missing' }, BASE)).toThrow(
      '项目不存在',
    )

    const updated = store.update(
      { id: projectTask.id, patch: { title: '改名', reminderLeadMinOverride: 5 } },
      BASE + 1_000,
    )
    expect(updated).toMatchObject({ title: '改名', reminderLeadMinOverride: 5 })
    expect(() => store.update({ id: projectTask.id, patch: { category: 'life' } }, BASE)).toThrow(
      '项目任务不支持修改分类',
    )

    const reopened = openStore()
    expect(reopened.getTasks()[0]).toMatchObject({ title: '改名', reminderLeadMinOverride: 5 })
  })

  it('改 dueAt：清 remindedAt 并重置两阶段；消费后改回可重新提醒', () => {
    const store = openStore({ id: () => 'task-a', now: () => BASE })
    const task = store.create({ title: '交周报', dueAt: at(18) }, BASE)
    store.consumeReminder({ id: task.id, phase: 'soon', at: at(17, 45) })
    expect(store.getTasks()[0]?.reminderState.soonConsumedAt).toBe(at(17, 45))

    const updated = store.update({ id: task.id, patch: { dueAt: at(19) } }, BASE + HOUR)
    expect(updated.remindedAt).toBeNull()
    expect(updated.reminderState).toEqual({
      dueAt: at(19),
      soonConsumedAt: null,
      dueConsumedAt: null,
    })
  })

  it('setDone：完成清 archivedAt；取消完成重置消费状态', () => {
    const store = openStore({ id: () => 'task-a', now: () => BASE })
    const task = store.create({ title: '任务', dueAt: at(18) }, BASE)
    store.consumeReminder({ id: task.id, phase: 'soon', at: at(17, 45) })
    store.setArchived(task.id, true, BASE)
    const done = store.setDone({ id: task.id, done: true }, BASE + 1_000)
    expect(done).toMatchObject({ status: 'done', completedAt: BASE + 1_000, archivedAt: null })

    const reopened = store.setDone({ id: task.id, done: false }, BASE + 3_000)
    expect(reopened).toMatchObject({ status: 'todo', completedAt: null, remindedAt: null })
    expect(reopened.reminderState).toEqual({
      dueAt: at(18),
      soonConsumedAt: null,
      dueConsumedAt: null,
    })
  })

  it('setArchived：仅 todo、重复幂等、恢复保留截止与消费标记；done 拒绝', () => {
    const store = openStore({ id: () => 'task-a', now: () => BASE })
    const task = store.create({ title: '任务', dueAt: at(18) }, BASE)
    store.consumeReminder({ id: task.id, phase: 'soon', at: at(17, 45) })
    expect(store.setArchived(task.id, true, BASE).archivedAt).toBe(BASE)
    expect(store.setArchived(task.id, true, BASE + 1_000).archivedAt).toBe(BASE)

    const restored = store.setArchived(task.id, false, BASE + 2_000)
    expect(restored.archivedAt).toBeNull()
    expect(restored.dueAt).toBe(at(18))
    expect(restored.reminderState.soonConsumedAt).toBe(at(17, 45))

    store.setDone({ id: task.id, done: true }, BASE + 3_000)
    expect(() => store.setArchived(task.id, true, BASE + 4_000)).toThrow('TASK_NOT_ACTIVE')
    expect(openStore().getTasks()[0]).toMatchObject({ status: 'done', archivedAt: null })
  })

  it('consumeReminder：单阶段幂等、due 补 soon、不可提醒任务拒绝', () => {
    const store = openStore({ id: seqIds(), now: () => BASE })
    const task = store.create({ title: '任务', dueAt: at(18) }, BASE)

    store.consumeReminder({ id: task.id, phase: 'due', at: at(18) })
    expect(store.getTasks()[0]).toMatchObject({
      remindedAt: at(18),
      reminderState: { soonConsumedAt: at(18), dueConsumedAt: at(18) },
    })
    // 幂等：重复消费不改变时间
    store.consumeReminder({ id: task.id, phase: 'due', at: at(19) })
    expect(store.getTasks()[0]?.reminderState.dueConsumedAt).toBe(at(18))
    expect(store.getTasks()[0]?.remindedAt).toBe(at(18))

    const noDue = store.create({ title: '无截止' }, BASE)
    expect(() => store.consumeReminder({ id: noDue.id, phase: 'soon', at: BASE })).toThrow(
      'TASK_NOT_ACTIVE',
    )
    store.setArchived(task.id, true, BASE + 5_000)
    expect(() => store.consumeReminder({ id: task.id, phase: 'soon', at: BASE + 5_000 })).toThrow(
      'TASK_NOT_ACTIVE',
    )
  })

  it('删除撤销保留新字段；项目删除后恢复报 PROJECT_NOT_FOUND', () => {
    const store = openStore({ id: seqIds(), now: () => BASE })
    const project = store.createProject({ name: '项目一' }, BASE)
    const task = store.create(
      { title: '项目任务', projectId: project.id, dueAt: at(18), reminderLeadMinOverride: 5 },
      BASE,
    )
    store.setArchived(task.id, true, BASE)
    const original = store.getTasks()[0]
    store.remove(task.id)
    expect(store.restore(task.id, BASE + 10_000)).toEqual(original)

    store.remove(task.id)
    store.removeProject(project.id)
    expect(() => store.restore(task.id, BASE + 2_000)).toThrow('PROJECT_NOT_FOUND')
  })

  it('30 秒撤销窗口后不可恢复；写失败不消耗撤销记录', () => {
    const store = openStore({ id: () => 'task-a', now: () => BASE })
    const task = store.create({ title: '任务' }, BASE)
    store.remove(task.id)
    mkdirSync(`${filePath}.tmp`)
    expect(() => store.restore(task.id, BASE + 10_000)).toThrow('任务保存失败')
    expect(store.getTasks()).toEqual([])
    rmSync(`${filePath}.tmp`, { recursive: true, force: true })
    expect(store.restore(task.id, BASE + 20_000)).toEqual(task)
    expect(() => store.restore(task.id, BASE + 25_000)).toThrow('无法撤销')
    expect(() => store.restore(task.id, BASE + 30_000 + TASK_DELETE_UNDO_MS)).toThrow('无法撤销')
  })
})

// ---------------------------------------------------------------------------
// 视图筛选 / 计数 / 统计
// ---------------------------------------------------------------------------

describe('getSnapshot 视图筛选与计数', () => {
  function seed(store: TaskStore): { project: Project } {
    const project = store.createProject({ name: '项目一' }, BASE)
    store.create({ title: '活动', category: 'life' }, BASE)
    store.create({ title: '逾期', category: 'life', dueAt: at(8) }, BASE)
    store.create({ title: '未来', category: 'life', dueAt: at(9, 0, 25) }, BASE)
    store.create({ title: '项目活动', projectId: project.id, dueAt: at(18) }, BASE)
    store.create({ title: '完成', category: 'life', dueAt: at(9) }, BASE)
    store.setDone({ id: 'id-6' }, at(10))
    return { project }
  }

  it('view/viewCounts：scope+分类后、view 前计数；仅带 view 时返回 viewCounts', () => {
    const store = openStore({ id: seqIds(), now: () => BASE })
    seed(store)

    const all = store.getSnapshot({ scope: 'all' }, BASE)
    expect(all.viewCounts).toBeUndefined()
    expect(all.tasks).toHaveLength(5)
    expect(all.stats).toEqual({
      todayKey: '2026-10-21',
      todayTotal: 4,
      todayDone: 1,
      overdue: 1,
      totalTodo: 4,
    })

    const active = store.getSnapshot({ scope: 'all', view: 'active' }, BASE)
    expect(active.tasks.map((task) => task.title)).not.toContain('完成')
    expect(active.viewCounts).toEqual({ active: 4, completed: 1, archived: 0, overdue: 1 })

    const lifeActive = store.getSnapshot({ scope: 'all', view: 'active', category: 'life' }, BASE)
    expect(lifeActive.tasks.map((task) => task.title).sort()).toEqual(['未来', '活动', '逾期'])
    expect(lifeActive.viewCounts).toEqual({ active: 3, completed: 1, archived: 0, overdue: 1 })

    const projectOnly = store.getSnapshot(
      { scope: 'all', view: 'active', category: 'project' },
      BASE,
    )
    expect(projectOnly.tasks.map((task) => task.title)).toEqual(['项目活动'])
  })

  it('搁置任务只出现在 archived view，且占用项目删除', () => {
    const store = openStore({ id: seqIds(), now: () => BASE })
    const { project } = seed(store)
    store.setArchived('id-5', true, BASE + 1_000)

    expect(store.getSnapshot({ scope: 'all', view: 'active' }, BASE + 2_000).viewCounts).toEqual({
      active: 3,
      completed: 1,
      archived: 1,
      overdue: 1,
    })
    expect(
      store
        .getSnapshot({ scope: 'all', view: 'archived' }, BASE + 2_000)
        .tasks.map((task) => task.title),
    ).toEqual(['项目活动'])
    expect(() => store.removeProject(project.id)).toThrow('项目下仍有任务')
  })

  it('scope=project 校验项目存在；viewScope=today 再按今日谓词筛', () => {
    const store = openStore({ id: seqIds(), now: () => BASE })
    const { project } = seed(store)
    expect(() => store.getSnapshot({ scope: 'project', projectId: 'missing' }, BASE)).toThrow(
      '项目不存在',
    )
    const all = store.getSnapshot({ scope: 'project', projectId: project.id }, BASE)
    expect(all.tasks.map((task) => task.title)).toEqual(['项目活动'])
    const today = store.getSnapshot(
      { scope: 'project', projectId: project.id, viewScope: 'today' },
      BASE,
    )
    expect(today.tasks.map((task) => task.title)).toEqual(['项目活动'])
  })
})

// ---------------------------------------------------------------------------
// 项目
// ---------------------------------------------------------------------------

describe('项目 CRUD（回归）', () => {
  it('创建/重名/改名/删除空项目；完成/搁置任务都算占用', () => {
    const store = openStore({ id: seqIds(), now: () => BASE })
    const project = store.createProject({ name: '  项目   A ', note: ' 备注 ' }, BASE)
    expect(project).toMatchObject({ name: '项目 A', note: '备注' })
    expect(() => store.createProject({ name: '项目 a' }, BASE)).toThrow('项目名称已存在')
    expect(() => store.createProject({ name: '   ' }, BASE)).toThrow('项目名称不能为空')

    const renamed = store.updateProject(
      { id: project.id, patch: { name: '项目 B', note: null } },
      BASE + 1,
    )
    expect(renamed).toMatchObject({ name: '项目 B', note: null })

    const task = store.create({ title: '任务', projectId: project.id }, BASE)
    store.setDone({ id: task.id, done: true }, BASE + 2)
    expect(() => store.removeProject(project.id)).toThrow('项目下仍有任务')
    store.remove(task.id)
    store.removeProject(project.id)
    expect(store.getProjects()).toEqual([])
    expect(() => store.removeProject(project.id)).toThrow('项目不存在')
  })
})

// ---------------------------------------------------------------------------
// Habit 存储
// ---------------------------------------------------------------------------

describe('Habit 存储', () => {
  it('createHabit 归一化/初始 revision/重名拒绝/重启保留', () => {
    const store = openStore({ id: seqIds(), now: () => BASE })
    const snapshot = store.createHabit(
      { name: '  背   单词 ', note: '  每天  ', schedule: DAILY },
      BASE,
    )
    expect(snapshot.habit).toMatchObject({ name: '背 单词', note: '每天' })
    expect(snapshot.habit.currentCycle.revision).toBe(1)
    expect(snapshot.habit.scheduleRevisions).toHaveLength(1)
    expect(snapshot.currentCheckin).toBeNull()
    expect(snapshot.habit.currentCycle.key).toBe(
      `${snapshot.habit.id}:1:${String(snapshot.habit.currentCycle.startAt)}`,
    )

    expect(() => store.createHabit({ name: '背 单词', schedule: DAILY }, BASE)).toThrow(
      '习惯名称已存在',
    )

    const reopened = openStore()
    expect(reopened.listHabits(BASE)[0]).toEqual(snapshot)
  })

  it('listHabits 推进周期并原子持久化；无变化不写盘', () => {
    const store = openStore({ id: () => 'habit-1', now: () => BASE })
    store.createHabit({ name: '背单词', schedule: DAILY }, BASE)

    const before = readFileSync(filePath, 'utf8')
    store.listHabits(BASE + HOUR)
    expect(readFileSync(filePath, 'utf8')).toBe(before)

    const advanced = store.listHabits(BASE + DAY)
    expect(advanced[0]?.habit.currentCycle.startAt).toBe(at(4, 0, 22))
    expect(readFileJson().habits[0]?.currentCycle.startAt).toBe(at(4, 0, 22))
  })

  it('updateHabit：改名/备注、规则修改排到 endAt、改回当前规则取消 pending', () => {
    const store = openStore({ id: () => 'habit-1', now: () => BASE })
    const created = store.createHabit({ name: '背单词', schedule: DAILY }, BASE)

    const renamed = store.updateHabit(
      { id: created.habit.id, patch: { name: '阅读', note: '每天 20 分钟' } },
      BASE + MINUTE,
    )
    expect(renamed.habit).toMatchObject({ name: '阅读', note: '每天 20 分钟' })

    const pending = store.updateHabit(
      { id: created.habit.id, patch: { schedule: WEEKLY_SUNDAY } },
      BASE + 2 * MINUTE,
    )
    expect(pending.habit.pendingSchedule).toMatchObject({
      schedule: WEEKLY_SUNDAY,
      effectiveAt: created.habit.currentCycle.endAt,
    })
    // 改回当前规则 → 取消 pending
    const cancelled = store.updateHabit(
      { id: created.habit.id, patch: { schedule: DAILY } },
      BASE + 3 * MINUTE,
    )
    expect(cancelled.habit.pendingSchedule).toBeNull()
    expect(cancelled.habit.scheduleRevisions).toHaveLength(1)

    expect(() => store.updateHabit({ id: 'missing', patch: { name: 'x' } }, BASE)).toThrow(
      'HABIT_NOT_FOUND',
    )
  })

  it('跨边界 update：先推进再排 pending，且与更新一次原子提交', () => {
    const store = openStore({ id: () => 'habit-1', now: () => BASE })
    const created = store.createHabit({ name: '背单词', schedule: DAILY }, BASE)
    // 次日 04:00 后修改规则：应先推进到新周期，再排到该周期 endAt
    const updated = store.updateHabit(
      { id: created.habit.id, patch: { schedule: WEEKLY_SUNDAY } },
      at(5, 0, 22),
    )
    expect(updated.habit.currentCycle.startAt).toBe(at(4, 0, 22))
    expect(updated.habit.pendingSchedule?.effectiveAt).toBe(at(4, 0, 23))
    expect(readFileJson().habits[0]?.currentCycle.startAt).toBe(at(4, 0, 22))
  })

  it('checkinHabit：首次 isNew、重复 isNew=false 且仅一条、旧 key CYCLE_CHANGED', () => {
    const store = openStore({ id: seqIds(), now: () => BASE })
    const created = store.createHabit({ name: '背单词', schedule: DAILY }, BASE)
    const key1 = created.habit.currentCycle.key

    const first = store.checkinHabit(
      { habitId: created.habit.id, cycleKey: key1, note: ' 首次 ' },
      BASE + MINUTE,
    )
    expect(first.isNew).toBe(true)
    expect(first.record).toMatchObject({ cycleKey: key1, note: '首次' })
    expect(first.habit.currentCheckin?.id).toBe(first.record.id)

    const second = store.checkinHabit(
      { habitId: created.habit.id, cycleKey: key1 },
      BASE + 2 * MINUTE,
    )
    expect(second.isNew).toBe(false)
    expect(second.record.id).toBe(first.record.id)
    expect(readFileJson().habitCheckins).toHaveLength(1)

    // 跨到下一周期：已有记录的旧 key 仍按幂等返回（不重复写）
    const afterBoundary = store.checkinHabit(
      { habitId: created.habit.id, cycleKey: key1 },
      at(5, 0, 22),
    )
    expect(afterBoundary.isNew).toBe(false)
    expect(readFileJson().habitCheckins).toHaveLength(1)

    // 旧 key 且无记录 → CYCLE_CHANGED（不补卡）
    const other = store.createHabit({ name: '阅读', schedule: DAILY }, at(5, 0, 22))
    const otherKey = other.habit.currentCycle.key
    expect(() =>
      store.checkinHabit({ habitId: other.habit.id, cycleKey: otherKey }, at(6, 0, 23)),
    ).toThrow('CYCLE_CHANGED')
  })

  it('checkin 写盘失败：不进内存、不产生记录，修复后可重试', () => {
    const store = openStore({ id: seqIds(), now: () => BASE })
    const created = store.createHabit({ name: '背单词', schedule: DAILY }, BASE)
    const key = created.habit.currentCycle.key
    const raw = readFileSync(filePath, 'utf8')

    mkdirSync(`${filePath}.tmp`)
    expect(() =>
      store.checkinHabit({ habitId: created.habit.id, cycleKey: key }, BASE + MINUTE),
    ).toThrow('任务保存失败')
    expect(readFileSync(filePath, 'utf8')).toBe(raw)
    expect(store.listHabits(BASE + MINUTE)[0]?.currentCheckin).toBeNull()

    rmSync(`${filePath}.tmp`, { recursive: true, force: true })
    const retried = store.checkinHabit(
      { habitId: created.habit.id, cycleKey: key },
      BASE + 2 * MINUTE,
    )
    expect(retried.isNew).toBe(true)
    expect(readFileJson().habitCheckins).toHaveLength(1)
  })

  it('跨边界打卡：推进到新周期并写入新 key（一次提交）', () => {
    const store = openStore({ id: () => 'habit-1', now: () => BASE })
    const created = store.createHabit({ name: '背单词', schedule: DAILY }, BASE)
    const nextKey = `${created.habit.id}:1:${String(at(4, 0, 22))}`

    const result = store.checkinHabit(
      { habitId: created.habit.id, cycleKey: nextKey },
      at(10, 0, 22),
    )
    expect(result.isNew).toBe(true)
    expect(result.habit.habit.currentCycle.startAt).toBe(at(4, 0, 22))
    const onDisk = readFileJson()
    expect(onDisk.habits[0]?.currentCycle.startAt).toBe(at(4, 0, 22))
    expect(onDisk.habitCheckins).toHaveLength(1)
    expect(onDisk.habitCheckins[0]?.cycle.startAt).toBe(at(4, 0, 22))
  })

  it('时钟回拨到 currentCycle.startAt 之前 → CLOCK_BEFORE_CURRENT_CYCLE', () => {
    const store = openStore({ id: () => 'habit-1', now: () => BASE })
    store.createHabit({ name: '背单词', schedule: DAILY }, BASE)
    expect(() => store.listHabits(at(3, 30))).toThrow('CLOCK_BEFORE_CURRENT_CYCLE')
    expect(() => store.checkinHabit({ habitId: 'habit-1', cycleKey: 'k' }, at(3, 30))).toThrow(
      'CLOCK_BEFORE_CURRENT_CYCLE',
    )
  })

  it('历史：cycle.startAt 倒序、limit/cursor 分页、非法 cursor 拒绝', () => {
    const store = openStore({ id: () => 'habit-1', now: () => BASE })
    const created = store.createHabit({ name: '背单词', schedule: DAILY }, BASE)
    const habitId = created.habit.id

    for (const day of [21, 22, 23]) {
      const now = at(10, 0, day)
      const key = `${created.habit.id}:1:${String(at(4, 0, day))}`
      store.checkinHabit({ habitId, cycleKey: key }, now)
    }

    const firstPage = store.listHabitHistory({ habitId, limit: 2 })
    expect(firstPage.records.map((record) => record.cycle.startAt)).toEqual([
      at(4, 0, 23),
      at(4, 0, 22),
    ])
    expect(firstPage.nextCursor).not.toBeNull()

    const secondPage = store.listHabitHistory({
      habitId,
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    })
    expect(secondPage.records.map((record) => record.cycle.startAt)).toEqual([at(4, 0, 21)])
    expect(secondPage.nextCursor).toBeNull()

    expect(() => store.listHabitHistory({ habitId, cursor: 'not-a-cursor' })).toThrow(
      '历史游标无效',
    )
  })

  it('deleteHabit：有历史拒绝 HABIT_HAS_HISTORY；空习惯可删；未找到报错', () => {
    const store = openStore({ id: seqIds(), now: () => BASE })
    const withHistory = store.createHabit({ name: '背单词', schedule: DAILY }, BASE)
    store.checkinHabit(
      { habitId: withHistory.habit.id, cycleKey: withHistory.habit.currentCycle.key },
      BASE + MINUTE,
    )
    expect(() => store.deleteHabit(withHistory.habit.id)).toThrow('HABIT_HAS_HISTORY')

    const empty = store.createHabit({ name: '跑步', schedule: WEEKLY_SUNDAY }, BASE)
    store.deleteHabit(empty.habit.id)
    expect(store.listHabits(BASE).map((snapshot) => snapshot.habit.name)).toEqual(['背单词'])
    expect(() => store.deleteHabit('missing')).toThrow('HABIT_NOT_FOUND')
  })

  it('listHabits 推进写盘失败：reject 且不返回半快照，文件/内存保持旧周期，重试成功', () => {
    const store = openStore({ id: () => 'habit-1', now: () => BASE })
    store.createHabit({ name: '背单词', schedule: DAILY }, BASE)
    const raw = readFileSync(filePath, 'utf8')

    mkdirSync(`${filePath}.tmp`)
    expect(() => store.listHabits(BASE + DAY)).toThrow('任务保存失败')
    expect(readFileSync(filePath, 'utf8')).toBe(raw)
    // 内存仍为旧周期
    expect(store.listHabits(BASE + HOUR)[0]?.habit.currentCycle.startAt).toBe(at(4, 0, 21))

    rmSync(`${filePath}.tmp`, { recursive: true, force: true })
    expect(store.listHabits(BASE + DAY)[0]?.habit.currentCycle.startAt).toBe(at(4, 0, 22))
    expect(readFileJson().habits[0]?.currentCycle.startAt).toBe(at(4, 0, 22))
  })

  it('跨周期持久化/重启（P1）：daily 与 weekly 推进后重新加载，任务/项目/习惯/历史正常', () => {
    let clockNow = BASE
    const store = openStore({ id: seqIds(), now: () => clockNow })
    const project = store.createProject({ name: '项目一' }, BASE)
    const task = store.create({ title: '任务', projectId: project.id, dueAt: at(18) }, BASE)
    const daily = store.createHabit({ name: '背单词', schedule: DAILY }, BASE)
    const weekly = store.createHabit({ name: '健身', schedule: WEEKLY_SUNDAY }, BASE)

    // daily 初始周期 10-21 04:00 ~ 10-22 04:00；weekly 初始周期 10-18 04:00 ~ 10-25 04:00
    expect(daily.habit.scheduleRevisions[0]?.effectiveAt).toBe(at(4, 0, 21))
    expect(weekly.habit.scheduleRevisions[0]?.effectiveAt).toBe(at(4, 0, 18))

    // 推进到 10-24：daily 跨 3 个周期（startAt 晚于 revision.effectiveAt），weekly 仍在首周期
    clockNow = at(10, 0, 24)
    const afterFirst = store.listHabits(clockNow)
    const dailyAdvanced = afterFirst.find((snapshot) => snapshot.habit.id === daily.habit.id)
    const weeklyAdvanced = afterFirst.find((snapshot) => snapshot.habit.id === weekly.habit.id)
    expect(dailyAdvanced?.habit.currentCycle.startAt).toBe(at(4, 0, 24))
    expect(dailyAdvanced?.habit.currentCycle.revision).toBe(1)
    expect(dailyAdvanced?.habit.currentCycle.startAt).toBeGreaterThan(
      daily.habit.scheduleRevisions[0]?.effectiveAt ?? Number.POSITIVE_INFINITY,
    )
    expect(weeklyAdvanced?.habit.currentCycle.startAt).toBe(at(4, 0, 18))

    // 在推进后的 daily 周期打卡：历史快照 startAt(10-24) 晚于 revision.effectiveAt(10-21)
    const checkin = store.checkinHabit(
      {
        habitId: daily.habit.id,
        cycleKey: dailyAdvanced?.habit.currentCycle.key ?? '',
      },
      clockNow,
    )
    expect(checkin.isNew).toBe(true)

    // 推进到 10-26 04:00：weekly 跨过 10-25 04:00 边界（startAt 晚于 effectiveAt）
    clockNow = at(4, 0, 26)
    store.listHabits(clockNow)

    // 重新 createTaskStore 读取同一隔离目录（P1：此前会误判结构损坏 → 全部读不出）
    const reopened = openStore({ id: seqIds(), now: () => clockNow })
    expect(reopened.getTasks().map((item) => item.id)).toEqual([task.id])
    expect(reopened.getProjects().map((item) => item.id)).toEqual([project.id])

    const snapshots = reopened.listHabits(clockNow)
    expect(snapshots).toHaveLength(2)
    const dailyAfter = snapshots.find((snapshot) => snapshot.habit.id === daily.habit.id)
    const weeklyAfter = snapshots.find((snapshot) => snapshot.habit.id === weekly.habit.id)
    expect(dailyAfter?.habit.currentCycle.revision).toBe(1)
    expect(dailyAfter?.habit.currentCycle.startAt).toBe(at(4, 0, 26))
    expect(dailyAfter?.habit.currentCycle.startAt).toBeGreaterThan(
      daily.habit.scheduleRevisions[0]?.effectiveAt ?? Number.POSITIVE_INFINITY,
    )
    expect(weeklyAfter?.habit.currentCycle.startAt).toBe(at(4, 0, 25))
    expect(weeklyAfter?.habit.currentCycle.startAt).toBeGreaterThan(
      weekly.habit.scheduleRevisions[0]?.effectiveAt ?? Number.POSITIVE_INFINITY,
    )

    // 历史仍在且可读
    const history = reopened.listHabitHistory({ habitId: daily.habit.id })
    expect(history.records).toHaveLength(1)
    expect(history.records[0]?.cycle.startAt).toBe(at(4, 0, 24))
    expect(history.records[0]?.cycle.revision).toBe(1)
    expect(history.nextCursor).toBeNull()
  })
})
