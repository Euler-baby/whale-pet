/**
 * tasks.json v2 → v3 迁移（备份、校验、转换）· Agent-Data（0.4.0）
 *
 * 口径：docs/35-0.4.0-data-ipc-spec.md §5。
 * - 只接收有效 v2；先做**原字节备份**（tasks.v2.json + settings.json + manifest.json 最后写）
 * - 备份目录 `userData/backups/pre-v3-<UTC时间>-<随机ID>/`，独占创建、绝不覆盖
 * - 备份失败/校验失败/空间不足 → 停止迁移，原 tasks/settings 不动
 * - 转换：任务/项目逐字段保留；新增 archivedAt/reminderLeadMinOverride/reminderState；
 *   旧 checkins 只在 v2 备份保留，v3 不含该字段；migration.droppedLegacyCheckins=原数量
 * - 唯一提交点：同目录临时文件 → 原子 rename 替换 tasks.json；settings 不改写
 * - 失败不重置、不清空；已替换后复读校验失败进入保护错误态
 *
 * 纯转换函数（`parseTasksFileV2` / `convertV2ToV3`）导出给单测；IO 编排 `migrateTasksV2ToV3`。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { parseDayKey } from '@shared/rules'
import { isTaskCategory, isTaskImportance, migrateReminderState } from '@shared/tasks'
import type {
  CheckinRecord,
  Habit,
  HabitCheckin,
  Project,
  Task,
  TaskCategory,
  TaskImportance,
  TaskStatus,
  Timestamp,
} from '@shared/types'

/** v3 迁移回执（docs/35 §1.1；类型仅数据层使用，不进入 IPC） */
export interface MigrationReceipt {
  fromVersion: 2
  backupId: string
  tasksSha256: string
  settingsSha256: string | null
  migratedAt: Timestamp
  droppedLegacyCheckins: number
}

/** tasks.json v3 完整落盘形状 */
export interface TasksFileV3 {
  version: 3
  tasks: Task[]
  projects: Project[]
  habits: Habit[]
  habitCheckins: HabitCheckin[]
  migration: MigrationReceipt | null
}

/** v2 备份 manifest（manifest 最后写） */
export interface BackupManifest {
  backupId: string
  createdAt: Timestamp
  sourceAppVersion: string
  files: {
    tasks: { present: boolean; sizeBytes: number; sha256: string }
    settings: { present: boolean; sizeBytes: number | null; sha256: string | null }
  }
  complete: true
}

export type V2ParseReason = 'invalid-json' | 'invalid-shape' | 'unsupported-version' | null

export interface TasksFileV2ParseResult {
  tasks: Task[]
  projects: Project[]
  /** 旧整体打卡记录数量（内容只在 v2 备份保留，v3 不写） */
  checkinCount: number
  ok: boolean
  reason: V2ParseReason
}

export interface CreateV2BackupOptions {
  /** 原 tasks.json 原始字节 */
  tasksBytes: Buffer
  /** 原 settings.json 原始字节；不存在为 null */
  settingsBytes: Buffer | null
  /** 备份根目录（默认 `userData/backups`） */
  backupRoot: string
  /** manifest.sourceAppVersion（当前运行版本） */
  appVersion: string
  now?: () => number
}

export interface CreatedBackup {
  backupId: string
  dir: string
  tasksSha256: string
  settingsSha256: string | null
}

export interface MigrateTasksV2Options {
  /** tasks.json 路径 */
  filePath: string
  /** settings.json 路径（只读备份，不改写） */
  settingsFilePath: string
  /** 备份根目录 */
  backupRoot: string
  /** manifest.sourceAppVersion */
  appVersion: string
  now?: () => number
}

export interface MigrateTasksV2Result {
  backupId: string
  droppedLegacyCheckins: number
  migratedAt: Timestamp
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return true
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

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'todo' || value === 'done'
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** UTC 时间戳（无冒号，可用于目录名）：YYYYMMDD-HHmmss */
function utcStamp(ms: Timestamp): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${String(date.getUTCFullYear())}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  )
}

/** 读取 tasks 文件 version（null = 不存在/无 version/坏 JSON） */
export function readTasksFileVersion(text: string | null): number | null {
  if (text === null) return null
  try {
    const raw: unknown = JSON.parse(text)
    if (!isPlainObject(raw)) return null
    const version = raw['version']
    return typeof version === 'number' && Number.isFinite(version) ? version : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// v2 解析与转换（纯函数）
// ---------------------------------------------------------------------------

interface V2Task {
  id: string
  title: string
  category: TaskCategory | null
  projectId: string | null
  importance: TaskImportance
  status: TaskStatus
  dueAt: Timestamp | null
  remindedAt: Timestamp | null
  note: string | null
  createdAt: Timestamp
  updatedAt: Timestamp
  completedAt: Timestamp | null
  todayPinnedDayKey: string | null
}

function parseV2Task(value: unknown): V2Task | null {
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
  } = value

  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof title !== 'string' || title.trim().length === 0) return null

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

  let todayPinnedValue: string | null = null
  if (todayPinnedDayKey !== null) {
    if (typeof todayPinnedDayKey !== 'string' || parseDayKey(todayPinnedDayKey) === null) {
      return null
    }
    todayPinnedValue = todayPinnedDayKey
  }

  if (!isTaskImportance(importance)) return null
  if (!isTaskStatus(status)) return null
  if (!isTimestampOrNull(dueAt) || !isTimestampOrNull(remindedAt)) return null
  if (!isTimestampOrNull(completedAt)) return null
  if (!isTimestamp(createdAt) || !isTimestamp(updatedAt)) return null
  if (!isNoteOrNull(note)) return null

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
  }
}

function parseV2Project(value: unknown): Project | null {
  if (!isPlainObject(value)) return null
  const { id, name, note, createdAt, updatedAt } = value
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof name !== 'string' || name.trim().length === 0) return null
  if (!isNoteOrNull(note)) return null
  if (!isTimestamp(createdAt) || !isTimestamp(updatedAt)) return null
  return { id, name, note, createdAt, updatedAt }
}

function parseV2Checkin(value: unknown): CheckinRecord | null {
  if (!isPlainObject(value)) return null
  const { dayKey, checkedAt, doneCount, totalCount, note } = value
  if (typeof dayKey !== 'string' || parseDayKey(dayKey) === null) return null
  if (!isTimestamp(checkedAt)) return null
  if (!isCount(doneCount) || !isCount(totalCount)) return null
  if (doneCount > totalCount) return null
  if (!isNoteOrNull(note)) return null
  return { dayKey, checkedAt, doneCount, totalCount, note }
}

/**
 * 纯函数：解析 v2 文件文本。任一记录非法 → 整体失败（保护原文件，不悄悄修复）。
 * 旧记录沿用 v2 可接受值域，不按新录入长度限制截断。
 */
export function parseTasksFileV2(text: string): TasksFileV2ParseResult {
  const invalid = (reason: Exclude<V2ParseReason, null>): TasksFileV2ParseResult => ({
    tasks: [],
    projects: [],
    checkinCount: 0,
    ok: false,
    reason,
  })

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return invalid('invalid-json')
  }
  if (!isPlainObject(raw)) return invalid('invalid-shape')
  const version = raw['version']
  if (version !== 2) return invalid('unsupported-version')

  const rawTasks = raw['tasks']
  const rawCheckins = raw['checkins']
  const rawProjects = raw['projects']
  if (!Array.isArray(rawTasks) || !Array.isArray(rawCheckins) || !Array.isArray(rawProjects)) {
    return invalid('invalid-shape')
  }

  const projects: Project[] = []
  const projectIds = new Set<string>()
  const projectNames = new Set<string>()
  for (const item of rawProjects) {
    const project = parseV2Project(item)
    if (project === null || projectIds.has(project.id)) return invalid('invalid-shape')
    const nameKey = project.name.trim().toLowerCase()
    if (projectNames.has(nameKey)) return invalid('invalid-shape')
    projectIds.add(project.id)
    projectNames.add(nameKey)
    projects.push({ ...project, name: project.name.trim() })
  }

  const tasks: Task[] = []
  const taskIds = new Set<string>()
  for (const item of rawTasks) {
    const parsed = parseV2Task(item)
    if (parsed === null || taskIds.has(parsed.id)) return invalid('invalid-shape')
    if (parsed.projectId !== null && !projectIds.has(parsed.projectId)) {
      return invalid('invalid-shape')
    }
    taskIds.add(parsed.id)
    tasks.push({
      ...parsed,
      todayPinnedDayKey: parsed.todayPinnedDayKey,
      archivedAt: null,
      reminderLeadMinOverride: null,
      reminderState: migrateReminderState(parsed.dueAt, parsed.remindedAt),
    })
  }

  const checkinIds = new Set<string>()
  for (const item of rawCheckins) {
    const record = parseV2Checkin(item)
    if (record === null || checkinIds.has(record.dayKey)) return invalid('invalid-shape')
    checkinIds.add(record.dayKey)
  }

  return { tasks, projects, checkinCount: rawCheckins.length, ok: true, reason: null }
}

/** 纯函数：由已校验 v2 内容构造 v3 文件对象（旧 checkins 不写入） */
export function buildTasksFileV3(
  parsed: Pick<TasksFileV2ParseResult, 'tasks' | 'projects'>,
  receipt: MigrationReceipt,
): TasksFileV3 {
  return {
    version: 3,
    tasks: parsed.tasks,
    projects: parsed.projects,
    habits: [],
    habitCheckins: [],
    migration: receipt,
  }
}

// ---------------------------------------------------------------------------
// 备份
// ---------------------------------------------------------------------------

/**
 * 创建 v2 原字节备份：独占目录；写 tasks.v2.json / settings.json（如存在）并读回核验哈希；
 * manifest.json 最后写入（complete:true）。失败 throw，原文件不动。
 */
export function createV2Backup(options: CreateV2BackupOptions): CreatedBackup {
  const clock = options.now ?? Date.now
  const createdAt = clock()
  const tasksSha256 = sha256Hex(options.tasksBytes)
  const settingsSha256 = options.settingsBytes === null ? null : sha256Hex(options.settingsBytes)

  mkdirSync(options.backupRoot, { recursive: true })
  const backupId = `pre-v3-${utcStamp(createdAt)}-${randomUUID().slice(0, 8)}`
  const dir = join(options.backupRoot, backupId)
  // 独占创建：已存在直接失败，绝不覆盖旧备份
  mkdirSync(dir)

  const manifest: BackupManifest = {
    backupId,
    createdAt,
    sourceAppVersion: options.appVersion,
    files: {
      tasks: {
        present: true,
        sizeBytes: options.tasksBytes.byteLength,
        sha256: tasksSha256,
      },
      settings: {
        present: options.settingsBytes !== null,
        sizeBytes: options.settingsBytes === null ? null : options.settingsBytes.byteLength,
        sha256: settingsSha256,
      },
    },
    complete: true,
  }

  try {
    const tasksPath = join(dir, 'tasks.v2.json')
    writeFileSync(tasksPath, options.tasksBytes)
    if (sha256Hex(readFileSync(tasksPath)) !== tasksSha256) {
      throw new Error('备份 tasks 读回哈希不一致')
    }

    if (options.settingsBytes !== null) {
      const settingsPath = join(dir, 'settings.json')
      writeFileSync(settingsPath, options.settingsBytes)
      if (sha256Hex(readFileSync(settingsPath)) !== settingsSha256) {
        throw new Error('备份 settings 读回哈希不一致')
      }
    }

    // manifest 最后写；写完读回校验
    const manifestPath = join(dir, 'manifest.json')
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    const readBack = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
    if (!isPlainObject(readBack) || readBack['complete'] !== true) {
      throw new Error('备份 manifest 读回校验失败')
    }
  } catch (error) {
    throw new Error(
      '迁移备份失败，已停止迁移并保留原任务/设置文件；请检查磁盘空间与文件夹权限后重试',
      { cause: error },
    )
  }

  return { backupId, dir, tasksSha256, settingsSha256 }
}

// ---------------------------------------------------------------------------
// 迁移编排（唯一提交点）
// ---------------------------------------------------------------------------

function readFileIfExists(filePath: string): Buffer | null {
  if (!existsSync(filePath)) return null
  return readFileSync(filePath)
}

/**
 * v2 → v3 迁移：备份 → 转换 → 临时文件 → 校验 → 原子替换 → 复读确认。
 * 成功返回备份信息；任一步失败 throw，原 tasks/settings 保持可恢复。
 */
export function migrateTasksV2ToV3(options: MigrateTasksV2Options): MigrateTasksV2Result {
  const clock = options.now ?? Date.now
  const migratedAt = clock()

  let tasksBytes: Buffer
  try {
    tasksBytes = readFileSync(options.filePath)
  } catch (error) {
    throw new Error('无法读取旧任务文件，已停止迁移并保护原文件', { cause: error })
  }
  const tasksText = tasksBytes.toString('utf8')
  const parsed = parseTasksFileV2(tasksText)
  if (!parsed.ok) {
    throw new Error(
      `旧任务文件无法迁移（${String(parsed.reason)}），已保护原文件；请先备份并修复或联系维护者`,
    )
  }

  // settings 只读备份：读权限错误不能当作不存在（docs/35 §5.2）
  let settingsBytes: Buffer | null
  try {
    settingsBytes = readFileIfExists(options.settingsFilePath)
  } catch (error) {
    throw new Error('无法读取设置文件以完成迁移备份，已停止迁移并保护原文件', { cause: error })
  }

  const backup = createV2Backup({
    tasksBytes,
    settingsBytes,
    backupRoot: options.backupRoot,
    appVersion: options.appVersion,
    now: () => migratedAt,
  })

  const receipt: MigrationReceipt = {
    fromVersion: 2,
    backupId: backup.backupId,
    tasksSha256: backup.tasksSha256,
    settingsSha256: backup.settingsSha256,
    migratedAt,
    droppedLegacyCheckins: parsed.checkinCount,
  }
  const v3 = buildTasksFileV3(parsed, receipt)
  const v3Text = `${JSON.stringify(v3, null, 2)}\n`

  // 同目录唯一临时文件 → 写入 → flush/读回校验
  const tmpPath = join(dirname(options.filePath), `tasks.v3.${randomUUID()}.tmp`)
  try {
    writeFileSync(tmpPath, v3Text, 'utf8')
    const readBack = readFileSync(tmpPath, 'utf8')
    if (readBack !== v3Text) throw new Error('v3 临时文件读回内容不一致')
  } catch (error) {
    throw new Error('v3 临时文件写入/校验失败，已保留原 v2 文件与备份', { cause: error })
  }

  // 提交前再次核对原 tasks/settings 未被外部修改
  try {
    const tasksNow = sha256Hex(readFileSync(options.filePath))
    if (tasksNow !== backup.tasksSha256) {
      throw new Error('原任务文件在迁移过程中被外部修改')
    }
    if (settingsBytes !== null) {
      const settingsNow = sha256Hex(readFileSync(options.settingsFilePath))
      if (settingsNow !== backup.settingsSha256) {
        throw new Error('原设置文件在迁移过程中被外部修改')
      }
    }
  } catch (error) {
    throw new Error('迁移中止：原文件在备份后被修改，已保留原文件与备份', { cause: error })
  }

  try {
    // 唯一提交点：同卷原子替换
    renameSync(tmpPath, options.filePath)
  } catch (error) {
    throw new Error('v3 原子替换失败，已保留原 v2 文件与迁移备份，可重试', { cause: error })
  }

  // 替换后复读确认；失败进入保护错误态（不宣称原文件仍在、不自动覆盖）
  try {
    const finalText = readFileSync(options.filePath, 'utf8')
    const finalRaw: unknown = JSON.parse(finalText)
    if (!isPlainObject(finalRaw) || finalRaw['version'] !== 3) {
      throw new Error('v3 文件复读版本不符')
    }
    const tasks = finalRaw['tasks']
    if (!Array.isArray(tasks) || tasks.length !== parsed.tasks.length) {
      throw new Error('v3 文件复读任务数量不符')
    }
  } catch (error) {
    throw new Error(
      `迁移已替换任务文件但复读校验失败，进入保护状态；请用备份 ${backup.backupId} 恢复（应用不会自动覆盖）`,
      { cause: error },
    )
  }

  return {
    backupId: backup.backupId,
    droppedLegacyCheckins: parsed.checkinCount,
    migratedAt,
  }
}
