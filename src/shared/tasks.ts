/**
 * 任务清单 · 纯函数与常量（shared，main/renderer 共用；无 IO、无副作用）
 *
 * 口径：docs/35-0.4.0-data-ipc-spec.md（0.4.0 / tasks.json v3 / IPC 2.0）。
 * - 业务日沿用 rules.ts 的 04:00 口径（dayKeyOf / dayKeyStart / dayKeyEnd）
 * - 所有时间戳 epoch ms；标题/备注在进入存储前做归一化
 * - 0.4：删除旧整体打卡（checkins/streak 字段），新增搁置 archivedAt、任务级提醒提前量、
 *   两阶段提醒消费状态 reminderState、状态视图 view/viewCounts
 * - 修改行为必须同步 tests/unit/tasks.test.ts
 */
import { addDays, dayKeyEnd, dayKeyOf, dayKeyStart } from './rules'
import type {
  HabitCheckinInput,
  HabitCheckinResult,
  HabitCreateInput,
  HabitHistoryInput,
  HabitHistoryPage,
  HabitSnapshot,
  HabitUpdateInput,
  Project,
  ProjectCreateInput,
  ProjectUpdateInput,
  Settings,
  Task,
  TaskCategory,
  TaskCategorySelection,
  TaskCountdownLevel,
  TaskCreateInput,
  TaskImportance,
  TaskPatch,
  TaskReminderState,
  TaskScope,
  TaskStats,
  TaskToggleInput,
  TaskUpdateInput,
  TaskView,
  TaskViewCounts,
  TasksListInput,
  TasksSnapshot,
  Timestamp,
} from './types'

// ---------------------------------------------------------------------------
// 常量与中文标签
// ---------------------------------------------------------------------------

export const TASK_TITLE_MAX = 80
export const TASK_NOTE_MAX = 500
/** 旧整体打卡备注上限（仅迁移模块内部使用，0.4 界面不再暴露） */
export const CHECKIN_NOTE_MAX = 140
/** 项目名上限（去空白后 1–40 字；同层级不区分大小写去重，docs/25 §2.2） */
export const PROJECT_NAME_MAX = 40
/** 项目备注上限 */
export const PROJECT_NOTE_MAX = 200

/** 到期提醒提前量默认值：15 分钟（任务未覆盖且全局未自定义时） */
export const TASK_REMINDER_LEAD_MS = 15 * 60 * 1000
/** 任务级/全局自定义提醒提前量允许范围（分钟，整数） */
export const REMINDER_LEAD_MIN_MIN = 1
export const REMINDER_LEAD_MIN_MAX = 1440

/** HUD 常驻卡片最多展示条数（0.3.2，契约 1.9） */
export const HUD_MAX_SHOWN = 3
/** HUD 活跃时普通提醒队列上限（超出丢最旧） */
export const HUD_QUEUE_MAX = 5
/** 队列项 TTL：从入队时刻起 10 分钟（过期即丢弃，不补发） */
export const HUD_QUEUE_TTL_MS = 10 * 60 * 1000
/** 免打扰固定区间（MVP 固定 23:00–07:00，不可配，docs/25 §7.1） */
export const TASK_DND_START = '23:00'
export const TASK_DND_END = '07:00'

/** 0.3.1a：固定三分类；项目任务 category=null（0.3.1b 启用） */
export const TASK_CATEGORIES: readonly TaskCategory[] = ['life', 'sport', 'study']
/** 重要性从高到低：紧急 / 重要 / 普通 / 次要 */
export const TASK_IMPORTANCES: readonly TaskImportance[] = ['urgent', 'high', 'normal', 'low']
/** 状态视图（0.4）：活动 / 已完成 / 搁置 */
export const TASK_VIEWS: readonly TaskView[] = ['active', 'completed', 'archived']

export const TASK_CATEGORY_LABELS: Readonly<Record<TaskCategory, string>> = {
  life: '生活',
  sport: '运动',
  study: '学习',
}

export const TASK_IMPORTANCE_LABELS: Readonly<Record<TaskImportance, string>> = {
  urgent: '紧急',
  high: '重要',
  normal: '普通',
  low: '次要',
}

/** 重要性排序权重：数字越小越靠前（紧急置顶，docs/25 §5.2） */
export const TASK_IMPORTANCE_WEIGHT: Readonly<Record<TaskImportance, number>> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
}

/** 优先级颜色（UI 共用；只做标注，不做数值系统） */
export const TASK_IMPORTANCE_COLORS: Readonly<Record<TaskImportance, string>> = {
  urgent: '#e5484d',
  high: '#f76b15',
  normal: '#4d6bfe',
  low: '#8b93a7',
}

/** 倒计时分级颜色（A-04 UI 共用；docs/25 §5.1：>1 天灰、<1 天黄、<1 小时橙、过期红） */
export const TASK_COUNTDOWN_COLORS: Readonly<Record<TaskCountdownLevel, string>> = {
  none: '#8b93a7',
  far: '#8b93a7',
  soon: '#d4a72c',
  imminent: '#f76b15',
  overdue: '#e5484d',
}

// ---------------------------------------------------------------------------
// 校验与归一化
// ---------------------------------------------------------------------------

export function isTaskCategory(value: unknown): value is TaskCategory {
  return typeof value === 'string' && (TASK_CATEGORIES as readonly string[]).includes(value)
}

export function isTaskImportance(value: unknown): value is TaskImportance {
  return typeof value === 'string' && (TASK_IMPORTANCES as readonly string[]).includes(value)
}

export function isTaskView(value: unknown): value is TaskView {
  return typeof value === 'string' && (TASK_VIEWS as readonly string[]).includes(value)
}

/** 任务级/全局自定义提醒提前量：1–1440 的整数分钟 */
export function isValidReminderLeadMin(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= REMINDER_LEAD_MIN_MIN &&
    value <= REMINDER_LEAD_MIN_MAX
  )
}

function collapseSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** 标题归一化：合并空白、去首尾、截断；空标题返回 null（调用方应拒绝写入） */
export function normalizeTitle(raw: string): string | null {
  const value = collapseSpaces(raw)
  if (value.length === 0) return null
  return value.slice(0, TASK_TITLE_MAX)
}

/** 备注归一化：空白 → null；超长截断 */
export function normalizeNote(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null
  const value = raw.trim()
  return value.length === 0 ? null : value.slice(0, TASK_NOTE_MAX)
}

/** 项目名归一化：合并空白、去首尾、截断；空名返回 null（调用方应拒绝写入） */
export function normalizeProjectName(raw: string): string | null {
  const value = collapseSpaces(raw)
  if (value.length === 0) return null
  return value.slice(0, PROJECT_NAME_MAX)
}

/** 项目备注归一化：空白 → null；超长截断 */
export function normalizeProjectNote(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null
  const value = raw.trim()
  return value.length === 0 ? null : value.slice(0, PROJECT_NOTE_MAX)
}

// ---------------------------------------------------------------------------
// 提醒提前量与两阶段消费状态
// ---------------------------------------------------------------------------

/** 有效提醒提前量（分钟）：任务级覆盖 > 全局自定义 > 旧预设默认 */
export function effectiveReminderLeadMinutes(
  task: Pick<Task, 'reminderLeadMinOverride'>,
  settings: Pick<Settings, 'reminderLeadMin' | 'customReminderLeadMin'>,
): number {
  if (task.reminderLeadMinOverride !== null) return task.reminderLeadMinOverride
  if (settings.customReminderLeadMin !== null) return settings.customReminderLeadMin
  return settings.reminderLeadMin
}

/** 空消费状态（dueAt 必须与任务一致） */
export function createReminderState(dueAt: Timestamp | null): TaskReminderState {
  return { dueAt, soonConsumedAt: null, dueConsumedAt: null }
}

/**
 * 旧 remindedAt → 两阶段消费状态（迁移用）：
 * - 无 due 或 remindedAt=null → 两阶段都未消费
 * - remindedAt < dueAt → 仅 soon 已消费
 * - remindedAt >= dueAt → 两阶段都已消费
 */
export function migrateReminderState(
  dueAt: Timestamp | null,
  remindedAt: Timestamp | null,
): TaskReminderState {
  const state = createReminderState(dueAt)
  if (dueAt === null || remindedAt === null) return state
  if (remindedAt < dueAt) return { ...state, soonConsumedAt: remindedAt }
  return { ...state, soonConsumedAt: remindedAt, dueConsumedAt: remindedAt }
}

/** 消费一个提醒阶段（幂等；due 消费时若 soon 仍空则一并补记，防回拨补发） */
export function markReminderConsumed(
  state: TaskReminderState,
  phase: TaskReminderPhase,
  at: Timestamp,
): TaskReminderState {
  if (phase === 'soon') {
    if (state.soonConsumedAt !== null) return state
    return { ...state, soonConsumedAt: at }
  }
  return {
    ...state,
    soonConsumedAt: state.soonConsumedAt ?? at,
    dueConsumedAt: state.dueConsumedAt ?? at,
  }
}

export type TaskReminderPhase = 'soon' | 'due'
/** 兼容旧命名 */
export type TaskReminderKind = TaskReminderPhase

/**
 * 是否需要提醒（0.4 两阶段独立消费）：
 * - 无截止 / done / 搁置 → 不调度
 * - now >= dueAt：due 未消费则返回 'due'（不追补旧 soon）
 * - now >= dueAt - leadMs：soon 未消费则返回 'soon'
 */
export function dueReminderFor(
  task: Task,
  now: Timestamp,
  leadMs: number = TASK_REMINDER_LEAD_MS,
): TaskReminderPhase | null {
  if (task.status !== 'todo' || task.archivedAt !== null || task.dueAt === null) return null
  const dueAt = task.dueAt
  const state = task.reminderState
  // 防御：状态 dueAt 与任务不一致时视为没有消费标记（store 保证一致）
  const sameDueAt = state.dueAt === dueAt
  const soonConsumed = sameDueAt ? state.soonConsumedAt : null
  const dueConsumed = sameDueAt ? state.dueConsumedAt : null
  if (now >= dueAt) {
    if (dueConsumed !== null) return null
    return 'due'
  }
  if (now >= dueAt - leadMs) {
    if (soonConsumed !== null) return null
    return 'soon'
  }
  return null
}

// ---------------------------------------------------------------------------
// 工厂与变更（纯函数，返回新对象）
// ---------------------------------------------------------------------------

/**
 * 创建任务（0.4：新增 archivedAt/reminderLeadMinOverride/reminderState）。
 * XOR（docs/25 §2.3）：带 projectId 时 category 必须缺省/null（否则抛错），结果为 category=null；
 * 不带 projectId 时 category 缺省为生活，projectId=null。
 */
export function createTask(input: TaskCreateInput, now: Timestamp, id: string): Task {
  const title = normalizeTitle(input.title)
  if (title === null) throw new Error('任务标题不能为空')
  const projectId = input.projectId ?? null
  if (projectId !== null && input.category != null) {
    throw new Error('项目任务不能设置分类')
  }
  const reminderLeadMinOverride = input.reminderLeadMinOverride ?? null
  if (reminderLeadMinOverride !== null && !isValidReminderLeadMin(reminderLeadMinOverride)) {
    throw new Error('提醒提前量必须是 1–1440 的整数分钟')
  }
  const dueAt = input.dueAt ?? null
  return {
    id,
    title,
    category: projectId === null ? (input.category ?? 'life') : null,
    projectId,
    importance: input.importance ?? 'normal',
    status: 'todo',
    dueAt,
    remindedAt: null,
    note: normalizeNote(input.note),
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    todayPinnedDayKey: null,
    archivedAt: null,
    reminderLeadMinOverride,
    reminderState: createReminderState(dueAt),
  }
}

/**
 * 应用 patch；改 dueAt 时清空 remindedAt 并重置两阶段消费状态，
 * 确保新截止重新提醒（docs/35 §4）。
 */
export function applyTaskPatch(task: Task, patch: TaskPatch, now: Timestamp): Task {
  const next: Task = { ...task, updatedAt: now }
  if (patch.title !== undefined) {
    const title = normalizeTitle(patch.title)
    if (title === null) throw new Error('任务标题不能为空')
    next.title = title
  }
  if (patch.category !== undefined) next.category = patch.category
  if (patch.importance !== undefined) next.importance = patch.importance
  if (patch.dueAt !== undefined) {
    if (patch.dueAt !== task.dueAt) {
      next.remindedAt = null
      next.reminderState = createReminderState(patch.dueAt)
    }
    next.dueAt = patch.dueAt
  }
  if (patch.note !== undefined) next.note = normalizeNote(patch.note)
  if (patch.reminderLeadMinOverride !== undefined) {
    const override = patch.reminderLeadMinOverride
    if (override !== null && !isValidReminderLeadMin(override)) {
      throw new Error('提醒提前量必须是 1–1440 的整数分钟')
    }
    next.reminderLeadMinOverride = override
  }
  return next
}

/**
 * 勾选/取消完成：
 * - 完成：done + completedAt；同时清 archivedAt（完成意图优先，T-11）
 * - 取消完成：todo、completedAt=null、remindedAt=null，并重置 reminderState；不自动搁置
 */
export function setTaskDone(task: Task, done: boolean, now: Timestamp): Task {
  if ((task.status === 'done') === done) return task
  if (done) {
    return {
      ...task,
      status: 'done',
      completedAt: now,
      archivedAt: null,
      updatedAt: now,
    }
  }
  return {
    ...task,
    status: 'todo',
    completedAt: null,
    remindedAt: null,
    reminderState: createReminderState(task.dueAt),
    updatedAt: now,
  }
}

/**
 * 搁置/恢复（docs/35 §2.2）：
 * - 仅 todo 可搁置；done 抛 TASK_NOT_ACTIVE（Main 转成稳定错误码）
 * - 重复同值幂等（不改 archivedAt 原时间）
 * - 恢复只清 archivedAt，不改 dueAt/归属/提醒消费
 */
export function applyTaskArchived(task: Task, archived: boolean, now: Timestamp): Task {
  if (archived) {
    if (task.status !== 'todo') throw new Error('TASK_NOT_ACTIVE: 已完成任务不能搁置')
    if (task.archivedAt !== null) return task
    return { ...task, archivedAt: now, updatedAt: now }
  }
  if (task.archivedAt === null) return task
  return { ...task, archivedAt: null, updatedAt: now }
}

// ---------------------------------------------------------------------------
// 查询与视图
// ---------------------------------------------------------------------------

function inBusinessDay(timestamp: Timestamp, now: Timestamp): boolean {
  const key = dayKeyOf(now)
  return timestamp >= dayKeyStart(key) && timestamp < dayKeyEnd(key)
}

export function isTaskOverdue(task: Task, now: Timestamp): boolean {
  return task.status === 'todo' && task.dueAt !== null && task.dueAt < now
}

export function isDoneToday(task: Task, now: Timestamp): boolean {
  return task.status === 'done' && task.completedAt !== null && inBusinessDay(task.completedAt, now)
}

/**
 * 「今日」谓词（docs/35 §2.1，严格沿用 0.3 口径；搁置仍按原 status/due 判断）：
 * - done：completedAt 落在本业务日
 * - 非项目 todo：无截止，或 dueAt < 本业务日结束
 * - 项目 todo：urgent，或有截止且 dueAt < 本业务日结束
 */
export function isTaskInTodayView(task: Task, now: Timestamp): boolean {
  if (task.status === 'done') return isDoneToday(task, now)
  if (isCategoryTask(task)) {
    if (task.dueAt === null) return true
    return task.dueAt < dayKeyEnd(dayKeyOf(now))
  }
  if (task.importance === 'urgent') return true
  if (task.dueAt === null) return false
  return task.dueAt < dayKeyEnd(dayKeyOf(now))
}

/** 是否三分类任务（生活/运动/学习）；项目任务 category=null（docs/25 §2.3） */
export function isCategoryTask(task: Task): task is Task & { category: TaskCategory } {
  return task.category !== null
}

/** 到期桶（活动排序用）：已过期 0 → 有截止 1 → 无截止 2 */
function dueBucket(task: Task, now: Timestamp): number {
  if (task.dueAt === null) return 2
  return task.dueAt < now ? 0 : 1
}

/** id 字典序（稳定 tiebreak） */
function compareId(a: Task, b: Task): number {
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/**
 * 活动排序口径（沿用 0.3，docs/35 §2.2）：
 * - 未完成在前；已完成按 completedAt 倒序（兼容旧调用）
 * - 活动任务：urgent 置顶 → 到期桶（已过期 0 → 有截止 1 → 无截止 2）→ 同桶 dueAt 升序
 *   → 重要性权重 → createdAt 升序 → id 字典序
 */
export function sortTasks(tasks: readonly Task[], now: Timestamp): Task[] {
  return [...tasks].sort((a, b) => {
    const aDone = a.status === 'done' ? 1 : 0
    const bDone = b.status === 'done' ? 1 : 0
    if (aDone !== bDone) return aDone - bDone
    if (aDone === 1) {
      const completedDelta = (b.completedAt ?? 0) - (a.completedAt ?? 0)
      if (completedDelta !== 0) return completedDelta
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
      return compareId(a, b)
    }

    // 紧急置顶：先于到期桶判断（紧急的未来/无截止任务也排在最前）
    const aUrgent = a.importance === 'urgent'
    const bUrgent = b.importance === 'urgent'
    if (aUrgent !== bUrgent) return aUrgent ? -1 : 1

    const bucketA = dueBucket(a, now)
    const bucketB = dueBucket(b, now)
    if (bucketA !== bucketB) return bucketA - bucketB
    if (bucketA !== 2) {
      const dueA = a.dueAt ?? 0
      const dueB = b.dueAt ?? 0
      if (dueA !== dueB) return dueA - dueB
    }

    const importanceDelta =
      TASK_IMPORTANCE_WEIGHT[a.importance] - TASK_IMPORTANCE_WEIGHT[b.importance]
    if (importanceDelta !== 0) return importanceDelta
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    return compareId(a, b)
  })
}

/** 任务是否属于指定状态视图 */
export function matchesTaskView(task: Task, view: TaskView): boolean {
  if (view === 'completed') return task.status === 'done'
  if (view === 'archived') return task.status === 'todo' && task.archivedAt !== null
  return task.status === 'todo' && task.archivedAt === null
}

/** 按视图排序：活动沿用 sortTasks；已完成 completedAt 倒序；搁置 archivedAt 倒序 */
export function sortTasksForView(tasks: readonly Task[], view: TaskView, now: Timestamp): Task[] {
  if (view === 'active') return sortTasks(tasks, now)
  return [...tasks].sort((a, b) => {
    if (view === 'completed') {
      const delta = (b.completedAt ?? 0) - (a.completedAt ?? 0)
      if (delta !== 0) return delta
    } else {
      const delta = (b.archivedAt ?? 0) - (a.archivedAt ?? 0)
      if (delta !== 0) return delta
    }
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    return compareId(a, b)
  })
}

/** 状态计数：在 scope + 分类过滤后、应用 view 前计算；逾期只计活动（未搁置 todo） */
export function computeViewCounts(tasks: readonly Task[], now: Timestamp): TaskViewCounts {
  let active = 0
  let completed = 0
  let archived = 0
  let overdue = 0
  for (const task of tasks) {
    if (task.status === 'done') {
      completed += 1
    } else if (task.archivedAt !== null) {
      archived += 1
    } else {
      active += 1
      if (task.dueAt !== null && task.dueAt < now) overdue += 1
    }
  }
  return { active, completed, archived, overdue }
}

function filterTaskCategory(
  tasks: readonly Task[],
  category: TaskCategorySelection | undefined,
): readonly Task[] {
  if (category === undefined || category === null) return tasks
  if (category === 'project') return tasks.filter((task) => task.projectId !== null)
  return tasks.filter((task) => task.category === category)
}

/**
 * 清单选择：筛选顺序 = scope 今日谓词 → 项目/分类 → viewScope（仅项目）→ view → 排序。
 * view 缺省时按旧调用兼容（不加状态过滤、活动排序）。
 */
export function selectTaskList(
  tasks: readonly Task[],
  input: TasksListInput,
  now: Timestamp,
): { tasks: Task[]; viewCounts?: TaskViewCounts } {
  const scoped = tasks.filter((task) => {
    if (input.scope === 'today') return isTaskInTodayView(task, now)
    if (input.scope === 'project') return task.projectId === input.projectId
    return true
  })
  const withViewScope =
    input.scope === 'project' && input.viewScope === 'today'
      ? scoped.filter((task) => isTaskInTodayView(task, now))
      : scoped
  const categorized = filterTaskCategory(withViewScope, input.category)

  if (input.view === undefined) {
    return { tasks: sortTasks(categorized, now) }
  }
  const viewCounts = computeViewCounts(categorized, now)
  const viewed = categorized.filter((task) => matchesTaskView(task, input.view as TaskView))
  return { tasks: sortTasksForView(viewed, input.view, now), viewCounts }
}

// ---------------------------------------------------------------------------
// HUD 紧急任务选择（0.3.2，契约 1.9；main 计算、renderer 只读展示）
// ---------------------------------------------------------------------------

/**
 * HUD 候选（仅未完成、未搁置）：
 * - scope='urgent'：importance==='urgent'
 * - scope='urgent-due'：紧急，或今天到期/已过期（dueAt < 今天业务日结束，含已过期）
 */
export function isHudCandidate(
  task: Task,
  scope: 'urgent' | 'urgent-due',
  now: Timestamp,
): boolean {
  if (task.status !== 'todo' || task.archivedAt !== null) return false
  if (task.importance === 'urgent') return true
  if (scope === 'urgent') return false
  if (task.dueAt === null) return false
  return task.dueAt < dayKeyEnd(dayKeyOf(now))
}

/**
 * HUD 任务选择：映射项目名，按 dueAt 升序（null 最后）→ 重要性权重 → createdAt → id 排序，
 * 最多展示 maxShown 条；total 为符合范围的全部候选数（供计数/角标）。
 */
export function selectHudTasks(
  tasks: readonly Task[],
  projects: readonly Project[],
  scope: 'urgent' | 'urgent-due',
  now: Timestamp,
  maxShown: number = HUD_MAX_SHOWN,
): { tasks: import('./types').HudTask[]; total: number } {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]))
  const candidates = tasks.filter((task) => isHudCandidate(task, scope, now))
  const sorted = [...candidates].sort((a, b) => {
    const dueA = a.dueAt ?? Infinity
    const dueB = b.dueAt ?? Infinity
    if (dueA !== dueB) return dueA < dueB ? -1 : 1
    const importanceDelta =
      TASK_IMPORTANCE_WEIGHT[a.importance] - TASK_IMPORTANCE_WEIGHT[b.importance]
    if (importanceDelta !== 0) return importanceDelta
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    return compareId(a, b)
  })
  const shown = sorted.slice(0, Math.max(0, maxShown))
  return {
    tasks: shown.map((task) => ({
      id: task.id,
      title: task.title,
      dueAt: task.dueAt,
      importance: task.importance,
      category: task.category,
      projectName: task.projectId === null ? null : (projectNames.get(task.projectId) ?? null),
    })),
    total: candidates.length,
  }
}

// ---------------------------------------------------------------------------
// 任务统计（0.4：只保留五个字段，不读取 Habit）
// ---------------------------------------------------------------------------

export function computeTaskStats(tasks: readonly Task[], now: Timestamp): TaskStats {
  const todayKey = dayKeyOf(now)
  // 0.4.2：今日完成分子/分母只统计未搁置任务（搁置不占分母；恢复后重新计入）
  const todayTasks = tasks.filter(
    (task) => task.archivedAt === null && isTaskInTodayView(task, now),
  )
  return {
    todayKey,
    todayTotal: todayTasks.length,
    todayDone: todayTasks.filter((task) => task.status === 'done').length,
    // 全局 todo 且过期，包含搁置（兼容旧全局口径，docs/35 §2.3；0.4.2 不改变）
    overdue: tasks.filter((task) => isTaskOverdue(task, now)).length,
    // 全局 todo，包含搁置
    totalTodo: tasks.filter((task) => task.status === 'todo').length,
  }
}

// ---------------------------------------------------------------------------
// 到期提醒文案
// ---------------------------------------------------------------------------

const REMINDER_TITLE_MAX = 18

/** 气泡文案（≤ 60 字，避免长标题撑爆气泡） */
export function reminderText(task: Task, kind: TaskReminderPhase, now: Timestamp): string {
  const title =
    task.title.length > REMINDER_TITLE_MAX
      ? `${task.title.slice(0, REMINDER_TITLE_MAX)}…`
      : task.title
  if (kind === 'due') return `「${title}」已到期`
  const minutes = Math.max(1, Math.ceil(((task.dueAt ?? now) - now) / 60_000))
  return `「${title}」还有 ${minutes} 分钟`
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** UI 文案：今天 18:00 / 明天 09:00 / 10-22 09:00 / 已过期 */
export function formatDueAt(dueAt: Timestamp | null, now: Timestamp): string {
  if (dueAt === null) return '无时间'
  const due = new Date(dueAt)
  const time = `${pad2(due.getHours())}:${pad2(due.getMinutes())}`
  const nowKey = dayKeyOf(now)
  const dueKey = dayKeyOf(dueAt)
  const dueDate = `${String(due.getMonth() + 1)}-${pad2(due.getDate())}`
  if (dueAt < now) {
    if (dueKey === nowKey) return `今天 ${time} 已过期`
    if (dueKey === addDays(nowKey, -1)) return `昨天 ${time} 已过期`
    return `${dueDate} ${time} 已过期`
  }
  if (dueKey === nowKey) return `今天 ${time}`
  if (dueKey === addDays(nowKey, 1)) return `明天 ${time}`
  if (dueKey === addDays(nowKey, 2)) return `后天 ${time}`
  if (due.getFullYear() === new Date(now).getFullYear()) return `${dueDate} ${time}`
  return `${String(due.getFullYear())}-${dueDate} ${time}`
}

// ---------------------------------------------------------------------------
// 倒计时分级与文案（A-04 UI 共用；docs/25 §5.1/§5.2）
// ---------------------------------------------------------------------------

const COUNTDOWN_MINUTE_MS = 60_000
const COUNTDOWN_HOUR_MS = 60 * COUNTDOWN_MINUTE_MS
const COUNTDOWN_DAY_MS = 24 * COUNTDOWN_HOUR_MS

/**
 * 倒计时分级：null → none；已过期 → overdue；剩余 <1h → imminent；<24h → soon；否则 far。
 * 边界：dueAt === now 视为 imminent；恰好 1h = soon；恰好 24h = far。
 */
export function countdownLevel(dueAt: Timestamp | null, now: Timestamp): TaskCountdownLevel {
  if (dueAt === null) return 'none'
  if (dueAt < now) return 'overdue'
  const remaining = dueAt - now
  if (remaining < COUNTDOWN_HOUR_MS) return 'imminent'
  if (remaining < COUNTDOWN_DAY_MS) return 'soon'
  return 'far'
}

/**
 * 幅度文案：<1 分钟“不到 1 分钟”；<1 小时 N 分钟（向上取整）；
 * <24 小时 N 小时（向下取整）；否则 N 天（向下取整）。
 */
function formatCountdownMagnitude(ms: number): string {
  if (ms < COUNTDOWN_MINUTE_MS) return '不到 1 分钟'
  if (ms < COUNTDOWN_HOUR_MS) return `${String(Math.ceil(ms / COUNTDOWN_MINUTE_MS))} 分钟`
  if (ms < COUNTDOWN_DAY_MS) return `${String(Math.floor(ms / COUNTDOWN_HOUR_MS))} 小时`
  return `${String(Math.floor(ms / COUNTDOWN_DAY_MS))} 天`
}

/** 倒计时文案：null→“无截止”；过期→“已过期 N”；未过期→“还剩 N” */
export function formatCountdown(dueAt: Timestamp | null, now: Timestamp): string {
  if (dueAt === null) return '无截止'
  if (dueAt < now) return `已过期 ${formatCountdownMagnitude(now - dueAt)}`
  return `还剩 ${formatCountdownMagnitude(dueAt - now)}`
}

// ---------------------------------------------------------------------------
// 存储接口（main 实现；renderer 只经 IPC，不直接使用）
// ---------------------------------------------------------------------------

export interface TaskStore {
  /** 清单查询：scope/projectId/view/category/viewScope；返回 viewCounts 规则见 docs/35 §2.3 */
  getSnapshot(input: TasksListInput, now: Timestamp): TasksSnapshot
  getTasks(): readonly Task[]
  create(input: TaskCreateInput, now: Timestamp): Task
  update(input: TaskUpdateInput, now: Timestamp): Task
  setDone(input: TaskToggleInput, now: Timestamp): Task
  /** 搁置/恢复；done 任务搁置抛 TASK_NOT_ACTIVE，重复同值幂等 */
  setArchived(id: string, archived: boolean, now: Timestamp): Task
  remove(id: string): void
  restore(id: string, now: Timestamp): Task
  getStats(now: Timestamp): TaskStats
  /** 提醒阶段消费（幂等）：写 reminderState 两阶段标记与 remindedAt；失败 throw 不进内存 */
  consumeReminder(input: { id: string; phase: TaskReminderPhase; at: Timestamp }): void
  // 项目（0.3.1b，契约 1.8）
  getProjects(): readonly Project[]
  createProject(input: ProjectCreateInput, now: Timestamp): Project
  updateProject(input: ProjectUpdateInput, now: Timestamp): Project
  /** 仅允许删除空项目；活动/完成/搁置任务均算占用 */
  removeProject(id: string): void
  // 独立打卡（0.4.0，IPC 2.0）：可推进周期并原子持久化
  listHabits(now: Timestamp): HabitSnapshot[]
  createHabit(input: HabitCreateInput, now: Timestamp): HabitSnapshot
  updateHabit(input: HabitUpdateInput, now: Timestamp): HabitSnapshot
  deleteHabit(id: string): void
  checkinHabit(input: HabitCheckinInput, now: Timestamp): HabitCheckinResult
  listHabitHistory(input: HabitHistoryInput): HabitHistoryPage
  flush(): void
}

export type { Task, TaskCategory, TaskImportance, TaskScope, TaskStats }
