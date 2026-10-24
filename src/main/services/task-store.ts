/**
 * 任务清单 + 独立打卡存储（tasks.json v3，JSON + 原子写）· Agent-Data
 *
 * 口径：docs/35-0.4.0-data-ipc-spec.md（0.4.0 / IPC 2.0）。
 * - 单文件 `userData/tasks.json` version=3：`{ version, tasks, projects, habits, habitCheckins, migration }`
 * - 单写者：只有 main 写；读取 → 严格校验 → 原子提交；失败不进内存、不污染文件
 * - v2 → v3：先原字节备份（task-migration.ts），转换成功才替换；失败保护原文件，**不再重置为空**
 * - 未知版本/损坏 v3 → 保护错误态（不沿用旧版“清空”路径）
 * - 0.4：删除旧整体打卡（checkins）；新增搁置 archivedAt、任务级提醒提前量、
 *   两阶段提醒消费状态 reminderState、状态视图 view/viewCounts；Habit 周期可推进并原子持久化
 * - 原子写：`tasks.json.tmp` → rename；写成功后才更新内存和返回，失败可重试
 * - 删除记录仅在 main 内保存 30 秒用于撤销；恢复保留全部原字段并校验项目引用
 * - 纯 Node（node:fs / node:crypto），时间/ID 可注入；不依赖 Electron
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  advanceHabit,
  buildInitialHabitCycle,
  HABIT_HISTORY_DEFAULT_LIMIT,
  HABIT_HISTORY_MAX_LIMIT,
  isCycleSnapshotConsistent,
  isHabitSchedule,
  isPendingConsistent,
  isSameSchedule,
  normalizeHabitCheckinNote,
  normalizeHabitName,
  normalizeHabitNote,
  planScheduleChange,
} from '@shared/habits'
import { parseDayKey } from '@shared/rules'
import {
  applyTaskArchived,
  applyTaskPatch,
  computeTaskStats,
  createTask,
  isTaskCategory,
  isTaskImportance,
  isValidReminderLeadMin,
  markReminderConsumed,
  normalizeProjectName,
  normalizeProjectNote,
  selectTaskList,
  setTaskDone,
} from '@shared/tasks'
import type { TaskReminderPhase, TaskStore } from '@shared/tasks'
import type {
  Habit,
  HabitCheckin,
  HabitCheckinInput,
  HabitCheckinResult,
  HabitCreateInput,
  HabitHistoryInput,
  HabitHistoryPage,
  HabitPendingSchedule,
  HabitScheduleRevision,
  HabitSnapshot,
  HabitUpdateInput,
  Project,
  ProjectCreateInput,
  ProjectUpdateInput,
  Task,
  TaskCategory,
  TaskCreateInput,
  TaskStatus,
  TaskToggleInput,
  TaskUpdateInput,
  TasksListInput,
  TasksSnapshot,
  TaskStats,
  TaskView,
  Timestamp,
} from '@shared/types'

import {
  migrateTasksV2ToV3,
  readTasksFileVersion,
  type MigrationReceipt,
  type TasksFileV3,
} from './task-migration'

/** 当前任务文件版本（v3 = 0.4.0：任务/项目/独立打卡；结构变更 +1） */
export const TASKS_FILE_VERSION = 3

/** 旧调用方兼容常量；任务变更现在立即原子落盘，不再防抖 */
export const TASKS_SAVE_DEBOUNCE_MS = 250

export const TASK_DELETE_UNDO_MS = 30_000

export type TasksParseReason =
  'missing' | 'invalid-json' | 'invalid-shape' | 'unsupported-version' | null

export interface TasksParseResult {
  /** 有效 v3 数据；ok=false 时为 null */
  data: TasksFileV3 | null
  ok: boolean
  reason: TasksParseReason
}

export interface TaskStoreOptions {
  /** 存储文件路径（main 注入 `userData/tasks.json`） */
  filePath: string
  /** 迁移备份用的 settings 路径；默认同目录 settings.json（只读备份） */
  settingsFilePath?: string
  /** 迁移备份根目录；默认同目录 backups/ */
  backupRoot?: string
  /** manifest.sourceAppVersion（main 注入 app.getVersion()） */
  appVersion?: string
  /** 时钟来源（删除撤销/迁移时间；测试注入固定值） */
  now?: () => number
  /** ID 生成器（任务/项目/习惯/打卡；默认 crypto.randomUUID） */
  id?: () => string
  /** 旧调用方兼容参数；当前立即落盘，此值不再生效 */
  debounceMs?: number
}

// ---------------------------------------------------------------------------
// 结构校验（纯函数，导出给单测）
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is Timestamp {
  return typeof value === 'number' && Number.isFinite(value)
}

function isTimestampOrNull(value: unknown): value is Timestamp | null {
  return value === null || isTimestamp(value)
}

function isNoteOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'todo' || value === 'done'
}

function isTaskViewValue(value: unknown): value is TaskView {
  return value === 'active' || value === 'completed' || value === 'archived'
}

/** 单条任务结构校验（v3 全字段必需；未知字段丢弃） */
function parseTask(value: unknown): Task | null {
  if (!isPlainObject(value)) return null
  const {
    id,
    title,
    category,
    projectId,
    importance,
    status,
    dueAt,
    remindedAt,
    note,
    createdAt,
    updatedAt,
    completedAt,
    todayPinnedDayKey,
    archivedAt,
    reminderLeadMinOverride,
    reminderState,
  } = value

  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof title !== 'string' || title.trim().length === 0) return null

  // XOR：非项目任务 category ∈ 三分类且 projectId=null；项目任务 category=null 且 projectId 非空
  let categoryValue: TaskCategory | null = null
  if (category !== null) {
    if (!isTaskCategory(category)) return null
    categoryValue = category
  }
  let projectIdValue: string | null = null
  if (projectId !== null) {
    if (typeof projectId !== 'string' || projectId.length === 0) return null
    projectIdValue = projectId
  }
  if ((categoryValue === null) === (projectIdValue === null)) return null

  if (!isTaskImportance(importance)) return null
  if (!isTaskStatus(status)) return null
  if (!isTimestampOrNull(dueAt) || !isTimestampOrNull(remindedAt)) return null
  if (!isTimestampOrNull(completedAt)) return null
  if (!isTimestamp(createdAt) || !isTimestamp(updatedAt)) return null
  if (!isNoteOrNull(note)) return null

  let todayPinnedValue: string | null = null
  if (todayPinnedDayKey !== null) {
    if (typeof todayPinnedDayKey !== 'string' || parseDayKey(todayPinnedDayKey) === null) {
      return null
    }
    todayPinnedValue = todayPinnedDayKey
  }

  // 搁置仅 todo；done 不得带 archivedAt（状态互斥）
  if (!isTimestampOrNull(archivedAt)) return null
  if (status === 'done' && archivedAt !== null) return null

  if (reminderLeadMinOverride !== null && !isValidReminderLeadMin(reminderLeadMinOverride)) {
    return null
  }

  if (!isPlainObject(reminderState)) return null
  const stateDueAt = reminderState['dueAt']
  const soonConsumedAt = reminderState['soonConsumedAt']
  const dueConsumedAt = reminderState['dueConsumedAt']
  if (!isTimestampOrNull(stateDueAt) || !isTimestampOrNull(soonConsumedAt)) return null
  if (!isTimestampOrNull(dueConsumedAt)) return null
  if (stateDueAt !== dueAt) return null

  return {
    id,
    title,
    category: categoryValue,
    projectId: projectIdValue,
    importance,
    status,
    dueAt,
    remindedAt,
    note,
    createdAt,
    updatedAt,
    completedAt,
    todayPinnedDayKey: todayPinnedValue,
    archivedAt,
    reminderLeadMinOverride,
    reminderState: { dueAt: stateDueAt, soonConsumedAt, dueConsumedAt },
  }
}

/** 单条项目结构校验（v3；未知字段丢弃） */
function parseProject(value: unknown): Project | null {
  if (!isPlainObject(value)) return null
  const { id, name, note, createdAt, updatedAt } = value

  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof name !== 'string') return null
  const normalizedName = normalizeProjectName(name)
  if (normalizedName === null) return null
  if (!isNoteOrNull(note)) return null
  if (!isTimestamp(createdAt) || !isTimestamp(updatedAt)) return null

  return { id, name: normalizedName, note: normalizeProjectNote(note), createdAt, updatedAt }
}

function parseRevision(value: unknown): HabitScheduleRevision | null {
  if (!isPlainObject(value)) return null
  const { revision, schedule, effectiveAt } = value
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null
  if (!isHabitSchedule(schedule)) return null
  if (!isTimestamp(effectiveAt)) return null
  return { revision, schedule, effectiveAt }
}

function parseHabitCycle(value: unknown): Habit['currentCycle'] | null {
  if (!isPlainObject(value)) return null
  const { key, revision, schedule, startAt, endAt } = value
  if (typeof key !== 'string' || key.length === 0) return null
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null
  if (!isHabitSchedule(schedule)) return null
  if (!isTimestamp(startAt) || !isTimestamp(endAt)) return null
  return { key, revision, schedule, startAt, endAt }
}

function parsePending(value: unknown): HabitPendingSchedule | null | undefined {
  if (value === null) return null
  if (!isPlainObject(value)) return undefined
  const { schedule, requestedAt, effectiveAt } = value
  if (!isHabitSchedule(schedule)) return undefined
  if (!isTimestamp(requestedAt) || !isTimestamp(effectiveAt)) return undefined
  return { schedule, requestedAt, effectiveAt }
}

/**
 * 单条习惯结构校验（v3，docs/35 §1.1）：
 * revision 从 1 严格递增、currentCycle 与 revision 历史一致、pending 生效点=当前周期 endAt。
 */
function parseHabit(value: unknown): Habit | null {
  if (!isPlainObject(value)) return null
  const { id, name, note, createdAt, updatedAt, scheduleRevisions, currentCycle, pendingSchedule } =
    value

  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof name !== 'string') return null
  const normalizedName = normalizeHabitName(name)
  if (normalizedName === null) return null
  if (!isNoteOrNull(note)) return null
  if (!isTimestamp(createdAt) || !isTimestamp(updatedAt)) return null
  if (!Array.isArray(scheduleRevisions) || scheduleRevisions.length === 0) return null

  const revisions: HabitScheduleRevision[] = []
  for (let index = 0; index < scheduleRevisions.length; index += 1) {
    const revision = parseRevision(scheduleRevisions[index])
    if (revision === null || revision.revision !== index + 1) return null
    revisions.push(revision)
  }

  const cycle = parseHabitCycle(currentCycle)
  if (cycle === null) return null
  const lastRevision = revisions[revisions.length - 1]
  if (lastRevision === undefined || lastRevision.revision !== cycle.revision) return null
  if (!isCycleSnapshotConsistent(id, cycle, revisions)) return null

  const pending = parsePending(pendingSchedule)
  if (pending === undefined) return null
  if (!isPendingConsistent(pending, cycle)) return null

  return {
    id,
    name: normalizedName,
    note: normalizeHabitNote(note),
    createdAt,
    updatedAt,
    scheduleRevisions: revisions,
    currentCycle: cycle,
    pendingSchedule: pending,
  }
}

/** 单条打卡记录校验：归属习惯存在、cycle 快照一致、key 匹配、checkedAt 落在周期内且不早于习惯创建 */
function parseHabitCheckin(
  value: unknown,
  habitsById: ReadonlyMap<string, Habit>,
): HabitCheckin | null {
  if (!isPlainObject(value)) return null
  const { id, habitId, cycleKey, cycle, checkedAt, note } = value

  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof habitId !== 'string' || habitId.length === 0) return null
  if (typeof cycleKey !== 'string' || cycleKey.length === 0) return null
  if (!isTimestamp(checkedAt)) return null
  if (!isNoteOrNull(note)) return null

  const snapshot = parseHabitCycle(cycle)
  if (snapshot === null) return null
  if (snapshot.key !== cycleKey) return null

  const habit = habitsById.get(habitId)
  if (habit === undefined) return null
  if (!isCycleSnapshotConsistent(habitId, snapshot, habit.scheduleRevisions)) return null
  if (checkedAt < snapshot.startAt || checkedAt >= snapshot.endAt) return null
  if (checkedAt < habit.createdAt) return null

  return {
    id,
    habitId,
    cycleKey,
    cycle: snapshot,
    checkedAt,
    note: normalizeHabitCheckinNote(note),
  }
}

function parseMigrationReceipt(value: unknown): MigrationReceipt | null | undefined {
  if (value === null) return null
  if (!isPlainObject(value)) return undefined
  const { fromVersion, backupId, tasksSha256, settingsSha256, migratedAt, droppedLegacyCheckins } =
    value
  if (fromVersion !== 2) return undefined
  if (typeof backupId !== 'string' || backupId.length === 0) return undefined
  if (typeof tasksSha256 !== 'string' || tasksSha256.length !== 64) return undefined
  if (
    settingsSha256 !== null &&
    (typeof settingsSha256 !== 'string' || settingsSha256.length !== 64)
  ) {
    return undefined
  }
  if (!isTimestamp(migratedAt)) return undefined
  if (
    typeof droppedLegacyCheckins !== 'number' ||
    !Number.isInteger(droppedLegacyCheckins) ||
    droppedLegacyCheckins < 0
  ) {
    return undefined
  }
  return {
    fromVersion: 2,
    backupId,
    tasksSha256,
    settingsSha256,
    migratedAt,
    droppedLegacyCheckins,
  }
}

function invalid(reason: Exclude<TasksParseReason, null>): TasksParseResult {
  return { data: null, ok: false, reason }
}

/**
 * 纯函数：解析 tasks.json v3 文本（null = 文件不存在）。
 * 任一记录非法 → 整体 invalid-shape；未知字段丢弃；v3 不接受顶层 checkins（不会写回）。
 */
export function parseTasksFileV3(text: string | null): TasksParseResult {
  if (text === null) return invalid('missing')

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return invalid('invalid-json')
  }

  if (!isPlainObject(raw)) return invalid('invalid-shape')
  const version = raw['version']
  if (version !== TASKS_FILE_VERSION) return invalid('unsupported-version')

  const rawTasks = raw['tasks']
  const rawProjects = raw['projects']
  const rawHabits = raw['habits']
  const rawCheckins = raw['habitCheckins']
  if (
    !Array.isArray(rawTasks) ||
    !Array.isArray(rawProjects) ||
    !Array.isArray(rawHabits) ||
    !Array.isArray(rawCheckins)
  ) {
    return invalid('invalid-shape')
  }

  const migration = parseMigrationReceipt(raw['migration'])
  if (migration === undefined) return invalid('invalid-shape')

  // projects
  const projects: Project[] = []
  const projectIds = new Set<string>()
  const projectNames = new Set<string>()
  for (const item of rawProjects) {
    const project = parseProject(item)
    if (project === null || projectIds.has(project.id)) return invalid('invalid-shape')
    const nameKey = project.name.toLowerCase()
    if (projectNames.has(nameKey)) return invalid('invalid-shape')
    projectIds.add(project.id)
    projectNames.add(nameKey)
    projects.push(project)
  }

  // tasks
  const tasks: Task[] = []
  const taskIds = new Set<string>()
  for (const item of rawTasks) {
    const task = parseTask(item)
    if (task === null || taskIds.has(task.id)) return invalid('invalid-shape')
    if (task.projectId !== null && !projectIds.has(task.projectId)) {
      return invalid('invalid-shape')
    }
    taskIds.add(task.id)
    tasks.push(task)
  }

  // habits（名称同层级不区分大小写唯一）
  const habits: Habit[] = []
  const habitIds = new Set<string>()
  const habitNames = new Set<string>()
  for (const item of rawHabits) {
    const habit = parseHabit(item)
    if (habit === null || habitIds.has(habit.id)) return invalid('invalid-shape')
    const nameKey = habit.name.toLowerCase()
    if (habitNames.has(nameKey)) return invalid('invalid-shape')
    habitIds.add(habit.id)
    habitNames.add(nameKey)
    habits.push(habit)
  }
  const habitsById = new Map(habits.map((habit) => [habit.id, habit]))

  // habitCheckins（cycleKey 唯一）
  const habitCheckins: HabitCheckin[] = []
  const checkinIds = new Set<string>()
  const cycleKeys = new Set<string>()
  for (const item of rawCheckins) {
    const record = parseHabitCheckin(item, habitsById)
    if (record === null || checkinIds.has(record.id) || cycleKeys.has(record.cycleKey)) {
      return invalid('invalid-shape')
    }
    checkinIds.add(record.id)
    cycleKeys.add(record.cycleKey)
    habitCheckins.push(record)
  }

  return {
    data: { version: 3, tasks, projects, habits, habitCheckins, migration },
    ok: true,
    reason: null,
  }
}

// ---------------------------------------------------------------------------
// 拷贝与序列化辅助
// ---------------------------------------------------------------------------

function copyTask(task: Task): Task {
  return { ...task, reminderState: { ...task.reminderState } }
}

function copyProject(project: Project): Project {
  return { ...project }
}

function copyHabit(habit: Habit): Habit {
  return {
    ...habit,
    scheduleRevisions: habit.scheduleRevisions.map((item) => ({
      ...item,
      schedule: { ...item.schedule },
    })),
    currentCycle: { ...habit.currentCycle, schedule: { ...habit.currentCycle.schedule } },
    pendingSchedule:
      habit.pendingSchedule === null
        ? null
        : { ...habit.pendingSchedule, schedule: { ...habit.pendingSchedule.schedule } },
  }
}

function copyHabitCheckin(record: HabitCheckin): HabitCheckin {
  return { ...record, cycle: { ...record.cycle, schedule: { ...record.cycle.schedule } } }
}

/** 不透明历史游标：base64url(JSON{startAt,id}) */
function encodeCursor(record: HabitCheckin): string {
  return Buffer.from(
    JSON.stringify({ startAt: record.cycle.startAt, id: record.id }),
    'utf8',
  ).toString('base64url')
}

function decodeCursor(cursor: string): { startAt: Timestamp; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!isPlainObject(parsed)) return null
    const startAt = parsed['startAt']
    const id = parsed['id']
    if (!isTimestamp(startAt) || typeof id !== 'string' || id.length === 0) return null
    return { startAt, id }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 存储实现
// ---------------------------------------------------------------------------

function assertStoreShapeSupported(input: TasksListInput): void {
  if (input.view !== undefined && !isTaskViewValue(input.view)) {
    throw new Error('任务视图不合法')
  }
}

export function createTaskStore(options: TaskStoreOptions): TaskStore {
  const { filePath } = options
  const clock = options.now ?? Date.now
  const nextId = options.id ?? randomUUID
  const settingsFilePath = options.settingsFilePath ?? join(dirname(filePath), 'settings.json')
  const backupRoot = options.backupRoot ?? join(dirname(filePath), 'backups')
  const appVersion = options.appVersion ?? 'unknown'

  let tasks: Task[] = []
  let projects: Project[] = []
  let habits: Habit[] = []
  let habitCheckins: HabitCheckin[] = []
  let migration: MigrationReceipt | null = null
  let loadError: Error | null = null
  const deleted = new Map<string, { task: Task; expiresAt: Timestamp }>()

  const assertReadable = (): void => {
    if (loadError !== null) throw loadError
  }

  const writePayload = (payload: TasksFileV3): void => {
    mkdirSync(dirname(filePath), { recursive: true })
    const tmpPath = `${filePath}.tmp`
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmpPath, filePath)
  }

  const load = (): void => {
    let text: string | null
    try {
      text = readFileSync(filePath, 'utf8')
    } catch (error) {
      if (isPlainObject(error) && error['code'] === 'ENOENT') {
        text = null
      } else {
        loadError = new Error(
          '无法读取任务文件，已停止任务读写以保护原数据，请检查文件权限后重启',
          { cause: error },
        )
        return
      }
    }

    // 新安装：内存空 v3，不主动写盘
    if (text === null) return

    const version = readTasksFileVersion(text)

    // v2 → v3：先备份再转换，成功才替换；失败保护原文件（不重置）
    if (version === 2) {
      try {
        const result = migrateTasksV2ToV3({
          filePath,
          settingsFilePath,
          backupRoot,
          appVersion,
          now: clock,
        })
        console.info(
          `[tasks] 已从 v2 迁移到 v3（备份 ${result.backupId}，丢弃旧打卡 ${String(result.droppedLegacyCheckins)} 条）`,
        )
      } catch (error) {
        loadError = new Error(
          '任务文件迁移失败，已停止任务读写并保护原文件；请检查迁移备份后重试或联系维护者',
          { cause: error },
        )
        return
      }
      try {
        text = readFileSync(filePath, 'utf8')
      } catch (error) {
        loadError = new Error('迁移后无法读取任务文件，已停止任务读写以保护数据', {
          cause: error,
        })
        return
      }
    }

    const parsed = parseTasksFileV3(text)
    if (!parsed.ok || parsed.data === null) {
      // 未知版本/损坏/不完整 v3：绝不沿用旧“重置为空”路径
      loadError = new Error(
        '任务文件版本不受支持或结构损坏，已停止任务读写以保护原文件；请检查迁移备份或使用兼容版本',
        { cause: new Error(String(parsed.reason)) },
      )
      return
    }
    tasks = parsed.data.tasks
    projects = parsed.data.projects
    habits = parsed.data.habits
    habitCheckins = parsed.data.habitCheckins
    migration = parsed.data.migration
  }

  const commit = (next: {
    tasks?: Task[]
    projects?: Project[]
    habits?: Habit[]
    habitCheckins?: HabitCheckin[]
    migration?: MigrationReceipt | null
  }): void => {
    assertReadable()
    const payload: TasksFileV3 = {
      version: TASKS_FILE_VERSION,
      tasks: next.tasks ?? tasks,
      projects: next.projects ?? projects,
      habits: next.habits ?? habits,
      habitCheckins: next.habitCheckins ?? habitCheckins,
      migration: next.migration === undefined ? migration : next.migration,
    }
    try {
      writePayload(payload)
    } catch (error) {
      throw new Error('任务保存失败，本次修改未保存；请检查文件夹写入权限或磁盘空间后重试', {
        cause: error,
      })
    }
    tasks = payload.tasks
    projects = payload.projects
    habits = payload.habits
    habitCheckins = payload.habitCheckins
    migration = payload.migration
  }

  const pruneDeleted = (now: Timestamp): void => {
    for (const [id, entry] of deleted) {
      if (now >= entry.expiresAt) deleted.delete(id)
    }
  }

  const findTask = (id: string): Task => {
    assertReadable()
    const task = tasks.find((item) => item.id === id)
    if (task === undefined) throw new Error('任务不存在')
    return task
  }

  const findProject = (id: string): Project => {
    assertReadable()
    const project = projects.find((item) => item.id === id)
    if (project === undefined) throw new Error('项目不存在')
    return project
  }

  const findHabit = (id: string): Habit => {
    assertReadable()
    const habit = habits.find((item) => item.id === id)
    if (habit === undefined) throw new Error('HABIT_NOT_FOUND: 习惯不存在')
    return habit
  }

  /** 项目名查重：去空白、不区分大小写；excludeId 用于改名时排除自身 */
  const hasProjectName = (name: string, excludeId?: string): boolean => {
    const key = name.toLowerCase()
    return projects.some((item) => item.id !== excludeId && item.name.toLowerCase() === key)
  }

  /** 习惯名查重：归一化后不区分大小写；excludeId 用于改名时排除自身 */
  const hasHabitName = (name: string, excludeId?: string): boolean => {
    const key = name.toLowerCase()
    return habits.some((item) => item.id !== excludeId && item.name.toLowerCase() === key)
  }

  const replaceTask = (next: Task): void => {
    commit({ tasks: tasks.map((item) => (item.id === next.id ? next : item)) })
  }

  /** 把所有习惯推进到 now 所在周期（不写盘）；无变化返回原数组引用 */
  const advanceAllHabits = (now: Timestamp): Habit[] => {
    let changed = false
    const next = habits.map((habit) => {
      const advanced = advanceHabit(habit, now)
      if (advanced !== habit) changed = true
      return advanced
    })
    return changed ? next : habits
  }

  const buildHabitSnapshot = (habit: Habit): HabitSnapshot => {
    const currentCheckin =
      habitCheckins.find(
        (record) => record.habitId === habit.id && record.cycleKey === habit.currentCycle.key,
      ) ?? null
    return {
      habit: copyHabit(habit),
      currentCheckin: currentCheckin === null ? null : copyHabitCheckin(currentCheckin),
    }
  }

  load()

  return {
    getSnapshot(input: TasksListInput, now: Timestamp): TasksSnapshot {
      assertReadable()
      assertStoreShapeSupported(input)
      // 项目 scope 必须先确认项目存在，避免把“项目不存在”静默当成空列表
      if (input.scope === 'project') {
        if (
          input.projectId === undefined ||
          !projects.some((item) => item.id === input.projectId)
        ) {
          throw new Error('项目不存在')
        }
      }
      const selection = selectTaskList(tasks, input, now)
      const snapshot: TasksSnapshot = {
        tasks: selection.tasks.map(copyTask),
        stats: computeTaskStats(tasks, now),
      }
      if (selection.viewCounts !== undefined) snapshot.viewCounts = selection.viewCounts
      return snapshot
    },

    getTasks(): readonly Task[] {
      assertReadable()
      return tasks.map(copyTask)
    },

    create(input: TaskCreateInput, now: Timestamp): Task {
      assertReadable()
      // 项目任务：先校验项目存在；category 与 projectId 的 XOR 由 shared createTask 拒绝
      const projectId = input.projectId ?? null
      if (projectId !== null && !projects.some((item) => item.id === projectId)) {
        throw new Error('项目不存在')
      }
      const task = createTask(input, now, nextId())
      pruneDeleted(clock())
      if (tasks.some((item) => item.id === task.id) || deleted.has(task.id)) {
        throw new Error('任务 ID 冲突，请重试')
      }
      commit({ tasks: [...tasks, task] })
      return copyTask(task)
    },

    update(input: TaskUpdateInput, now: Timestamp): Task {
      const current = findTask(input.id)
      // 项目任务 category 恒为 null（XOR），不允许通过 patch 改成三分类
      if (current.category === null && input.patch.category !== undefined) {
        throw new Error('项目任务不支持修改分类')
      }
      const next = applyTaskPatch(current, input.patch, now)
      replaceTask(next)
      return copyTask(next)
    },

    setDone(input: TaskToggleInput, now: Timestamp): Task {
      const current = findTask(input.id)
      const done = input.done ?? current.status !== 'done'
      const next = setTaskDone(current, done, now)
      if (next === current) return copyTask(current)
      replaceTask(next)
      return copyTask(next)
    },

    setArchived(id: string, archived: boolean, now: Timestamp): Task {
      const current = findTask(id)
      const next = applyTaskArchived(current, archived, now)
      if (next === current) return copyTask(current)
      replaceTask(next)
      return copyTask(next)
    },

    remove(id: string): void {
      const original = findTask(id)
      const remaining = tasks.filter((task) => task.id !== id)
      commit({ tasks: remaining })
      const now = clock()
      pruneDeleted(now)
      deleted.set(id, { task: copyTask(original), expiresAt: now + TASK_DELETE_UNDO_MS })
    },

    restore(id: string, now: Timestamp): Task {
      assertReadable()
      pruneDeleted(now)
      const entry = deleted.get(id)
      if (entry === undefined) throw new Error('无法撤销：删除已超过 30 秒或任务已恢复')
      if (tasks.some((task) => task.id === id)) throw new Error('任务已存在，无法重复恢复')
      // 项目任务所属项目已删除时不能产生悬空引用（docs/35 §2.2）
      if (
        entry.task.projectId !== null &&
        !projects.some((project) => project.id === entry.task.projectId)
      ) {
        throw new Error('PROJECT_NOT_FOUND: 任务所属项目已删除，无法恢复')
      }
      commit({ tasks: [...tasks, copyTask(entry.task)] })
      deleted.delete(id)
      return copyTask(entry.task)
    },

    getStats(now: Timestamp): TaskStats {
      assertReadable()
      return computeTaskStats(tasks, now)
    },

    consumeReminder(input: { id: string; phase: TaskReminderPhase; at: Timestamp }): Task {
      const current = findTask(input.id)
      if (current.status !== 'todo' || current.archivedAt !== null || current.dueAt === null) {
        throw new Error('TASK_NOT_ACTIVE: 任务当前不可提醒')
      }
      const state = { ...current.reminderState, dueAt: current.dueAt }
      // 单阶段幂等：已消费则不写盘
      if (input.phase === 'soon' && state.soonConsumedAt !== null) return copyTask(current)
      if (input.phase === 'due' && state.dueConsumedAt !== null) return copyTask(current)
      const next: Task = {
        ...current,
        remindedAt: input.at,
        reminderState: markReminderConsumed(state, input.phase, input.at),
      }
      replaceTask(next)
      return copyTask(next)
    },

    // 项目（0.3.1b，契约 1.8）：活动/完成/搁置任务均算占用
    getProjects(): readonly Project[] {
      assertReadable()
      return projects.map(copyProject)
    },

    createProject(input: ProjectCreateInput, now: Timestamp): Project {
      assertReadable()
      const name = normalizeProjectName(input.name)
      if (name === null) throw new Error('项目名称不能为空')
      if (hasProjectName(name)) throw new Error('项目名称已存在')
      const project: Project = {
        id: nextId(),
        name,
        note: normalizeProjectNote(input.note),
        createdAt: now,
        updatedAt: now,
      }
      if (projects.some((item) => item.id === project.id)) {
        throw new Error('项目 ID 冲突，请重试')
      }
      commit({ projects: [...projects, project] })
      return copyProject(project)
    },

    updateProject(input: ProjectUpdateInput, now: Timestamp): Project {
      const current = findProject(input.id)
      let name = current.name
      if (input.patch.name !== undefined) {
        const normalized = normalizeProjectName(input.patch.name)
        if (normalized === null) throw new Error('项目名称不能为空')
        if (hasProjectName(normalized, current.id)) throw new Error('项目名称已存在')
        name = normalized
      }
      const note =
        input.patch.note !== undefined ? normalizeProjectNote(input.patch.note) : current.note
      const next: Project = { ...current, name, note, updatedAt: now }
      commit({
        projects: projects.map((item) => (item.id === next.id ? next : item)),
      })
      return copyProject(next)
    },

    removeProject(id: string): void {
      const project = findProject(id)
      if (tasks.some((task) => task.projectId === project.id)) {
        throw new Error('项目下仍有任务，无法删除')
      }
      commit({ projects: projects.filter((item) => item.id !== project.id) })
    },

    // 独立打卡（0.4.0，IPC 2.0）：list/update/checkin 前先推进周期，与写操作同一次原子提交
    listHabits(now: Timestamp): HabitSnapshot[] {
      assertReadable()
      const next = advanceAllHabits(now)
      if (next !== habits) commit({ habits: next })
      return habits.map((habit) => buildHabitSnapshot(habit))
    },

    createHabit(input: HabitCreateInput, now: Timestamp): HabitSnapshot {
      assertReadable()
      const name = normalizeHabitName(input.name)
      if (name === null) throw new Error('习惯名称不能为空')
      if (!isHabitSchedule(input.schedule)) throw new Error('习惯周期不合法')
      if (hasHabitName(name)) throw new Error('习惯名称已存在')
      const id = nextId()
      if (habits.some((item) => item.id === id)) throw new Error('习惯 ID 冲突，请重试')
      const { revision, cycle } = buildInitialHabitCycle(id, input.schedule, now)
      const habit: Habit = {
        id,
        name,
        note: normalizeHabitNote(input.note),
        createdAt: now,
        updatedAt: now,
        scheduleRevisions: [revision],
        currentCycle: cycle,
        pendingSchedule: null,
      }
      commit({ habits: [...habits, habit] })
      return buildHabitSnapshot(habit)
    },

    updateHabit(input: HabitUpdateInput, now: Timestamp): HabitSnapshot {
      assertReadable()
      // 先推进周期，再与 update 一起原子提交（推进失败不写盘）
      const advanced = advanceAllHabits(now)
      const current = advanced.find((item) => item.id === input.id)
      if (current === undefined) throw new Error('HABIT_NOT_FOUND: 习惯不存在')

      let name = current.name
      if (input.patch.name !== undefined) {
        const normalized = normalizeHabitName(input.patch.name)
        if (normalized === null) throw new Error('习惯名称不能为空')
        const duplicate = advanced.some(
          (item) => item.id !== current.id && item.name.toLowerCase() === normalized.toLowerCase(),
        )
        if (duplicate) throw new Error('习惯名称已存在')
        name = normalized
      }
      const note =
        input.patch.note !== undefined ? normalizeHabitNote(input.patch.note) : current.note

      let pending = current.pendingSchedule
      let revisions = current.scheduleRevisions
      let cycle = current.currentCycle
      if (input.patch.schedule !== undefined) {
        if (!isHabitSchedule(input.patch.schedule)) throw new Error('习惯周期不合法')
        // 与当前周期规则相同 → 取消 pending；否则排到 currentCycle.endAt 生效
        pending = planScheduleChange(current, input.patch.schedule, now)
        if (
          pending === null &&
          isSameSchedule(current.currentCycle.schedule, input.patch.schedule)
        ) {
          revisions = current.scheduleRevisions
          cycle = current.currentCycle
        }
      }

      const nextHabit: Habit = {
        ...current,
        name,
        note,
        updatedAt: now,
        scheduleRevisions: revisions,
        currentCycle: cycle,
        pendingSchedule: pending,
      }
      const nextHabits = advanced.map((item) => (item.id === nextHabit.id ? nextHabit : item))
      commit({ habits: nextHabits })
      return buildHabitSnapshot(nextHabit)
    },

    deleteHabit(id: string): void {
      assertReadable()
      const habit = findHabit(id)
      if (habitCheckins.some((record) => record.habitId === habit.id)) {
        throw new Error('HABIT_HAS_HISTORY: 习惯已有打卡记录，不能删除')
      }
      commit({ habits: habits.filter((item) => item.id !== habit.id) })
    },

    checkinHabit(input: HabitCheckinInput, now: Timestamp): HabitCheckinResult {
      assertReadable()
      const advanced = advanceAllHabits(now)
      const habit = advanced.find((item) => item.id === input.habitId)
      if (habit === undefined) throw new Error('HABIT_NOT_FOUND: 习惯不存在')

      // 已有记录：幂等返回 isNew=false（即使该周期刚跨成历史）
      const existing = habitCheckins.find(
        (record) => record.habitId === habit.id && record.cycleKey === input.cycleKey,
      )
      if (existing !== undefined) {
        if (advanced !== habits) commit({ habits: advanced })
        return {
          record: copyHabitCheckin(existing),
          habit: buildHabitSnapshot(habit),
          isNew: false,
        }
      }

      // 旧 key 且无记录 → CYCLE_CHANGED，不补卡
      if (input.cycleKey !== habit.currentCycle.key) {
        throw new Error('CYCLE_CHANGED: 打卡周期已变化，请刷新后重试')
      }
      // 时钟回拨到习惯创建前：不开放历史打卡
      if (now < habit.createdAt) {
        throw new Error('CLOCK_BEFORE_CURRENT_CYCLE: 系统时间早于习惯创建时间，暂不可打卡')
      }

      const record: HabitCheckin = {
        id: nextId(),
        habitId: habit.id,
        cycleKey: habit.currentCycle.key,
        cycle: {
          ...habit.currentCycle,
          schedule: { ...habit.currentCycle.schedule },
        },
        checkedAt: now,
        note: normalizeHabitCheckinNote(input.note),
      }
      commit({ habits: advanced, habitCheckins: [...habitCheckins, record] })
      return { record: copyHabitCheckin(record), habit: buildHabitSnapshot(habit), isNew: true }
    },

    listHabitHistory(input: HabitHistoryInput): HabitHistoryPage {
      assertReadable()
      const habit = findHabit(input.habitId)
      const limit = Math.min(
        HABIT_HISTORY_MAX_LIMIT,
        Math.max(1, input.limit ?? HABIT_HISTORY_DEFAULT_LIMIT),
      )

      const sorted = habitCheckins
        .filter((record) => record.habitId === habit.id)
        .sort((a, b) => {
          if (a.cycle.startAt !== b.cycle.startAt) return b.cycle.startAt - a.cycle.startAt
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
        })

      let offset = 0
      if (input.cursor !== undefined) {
        const cursor = decodeCursor(input.cursor)
        if (cursor === null) throw new Error('历史游标无效')
        const index = sorted.findIndex(
          (record) => record.cycle.startAt === cursor.startAt && record.id === cursor.id,
        )
        if (index < 0) throw new Error('历史游标无效')
        offset = index + 1
      }

      const page = sorted.slice(offset, offset + limit)
      const last = page[page.length - 1]
      const nextCursor =
        last !== undefined && offset + page.length < sorted.length ? encodeCursor(last) : null

      return {
        records: page.map(copyHabitCheckin),
        nextCursor,
      }
    },

    // 每次变更都已同步提交，无待写状态；退出不重写文件或掩盖先前加载错误。
    flush(): void {},
  }
}
