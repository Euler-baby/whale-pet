/**
 * HUD 状态机 + 普通提醒队列 · Agent-Main（0.4.0，契约 2.0；基线 0.3.2 C-03/C-04）
 *
 * 口径（docs/35 §4、docs/37 N-05/N-08/N-11）：
 * - HUD 常驻卡片：按 settings.hudScope 选候选（仅紧急 / 紧急+今日到期），最多 3 条 + 总数；
 *   候选只含活动任务（todo 且未搁置），已完成/搁置任务不进入 HUD
 * - 冲突规则：HUD 活跃时普通提醒排队 + 角标（上限 5、TTL 10 分钟、仅内存态，重启清空）
 * - 队列项冻结为 `{taskId, dueAt, phase, text, enqueuedAt}`；同 taskId 最多一项，
 *   到期阶段（due）替换尚未投递的临近阶段（soon），避免同任务重复摘要
 * - 入队前先由调用方注入的 `consumeReminder` 提交消费；成功才进入内存队列，
 *   失败不留下“已排队但没落盘”的项
 * - 任务完成/搁置/删除/修改 dueAt 后：队列按当前任务过滤、已显示的汇总气泡按剩余项重建，
 *   无剩余则撤下（不保留“正在催办”的旧文案）
 * - HUD 空闲后只发 1 条汇总气泡（最多列 3 条标题，其余“等 N 条”），成功才清队；
 *   免打扰区间内禁止普通汇总（过期项照常淘汰）
 * - 只在状态变化时推送 `tasks-urgent`；推送异常吞掉并记录（下轮 refresh 重试）
 * - 纯状态机：不 import Electron、不直接读文件；时间/数据/发送能力全部由 main 注入
 */
import { isDndActive } from '@shared/rules'
import {
  HUD_QUEUE_MAX,
  HUD_QUEUE_TTL_MS,
  selectHudTasks,
  TASK_DND_END,
  TASK_DND_START,
} from '@shared/tasks'
import type { TaskReminderPhase } from '@shared/tasks'
import type { PetEvent, Project, Settings, Task, Timestamp, UrgentTasksState } from '@shared/types'

/** 汇总气泡最多列出的任务标题数 */
const SUMMARY_TITLE_LIMIT = 3
/** 汇总气泡单条标题最大长度（避免长标题撑爆气泡） */
const SUMMARY_TITLE_MAX = 12
/** 汇总气泡默认展示时长（与 main 发送气泡的 durationMs 对齐；用于判断已显示汇总是否还在） */
const DEFAULT_BUBBLE_DURATION_MS = 8000

/** 免打扰固定区间（MVP 固定 23:00–07:00，不可配，docs/23 §6） */
const DND_SETTINGS = { enabled: true, start: TASK_DND_START, end: TASK_DND_END } as const

/** 两阶段提醒：临近截止 / 已到期（与 shared 契约同义） */
export type ReminderPhase = TaskReminderPhase

/** 内存排队项：入队前已消费对应阶段（持久化在 task.reminderState） */
export interface QueuedReminder {
  taskId: string
  /** 入队时的 dueAt；任务改截止时间后该项失效 */
  dueAt: Timestamp
  phase: ReminderPhase
  /** 已生成的提醒文案（任务被删除时作为标题兜底） */
  text: string
  enqueuedAt: Timestamp
}

/**
 * 任务编辑后是否必须作废该任务的排队提醒（并清掉已显示汇总中的该项）。
 *
 * 只清会改变提醒资格/阶段的变化：
 * - `dueAt` 变化：旧阶段作废（store 同时重置 reminderState），队列项必须丢弃
 * - 状态/搁置变化或任务不再活动：完成/搁置任务不再提醒（update 正常不改这些，防御性保留）
 *
 * 仅标题/备注/重要性/提醒提前量变化（含任务覆盖与“跟随默认”）时返回 false：
 * 已入队项与已消费阶段保留，避免“编辑一下备注就不再提醒”；HUD 展示由 syncTasks 重算。
 */
export function shouldInvalidateQueuedBeforeUpdate(before: Task, after: Task): boolean {
  if (before.dueAt !== after.dueAt) return true
  if (before.status !== after.status) return true
  if (before.archivedAt !== after.archivedAt) return true
  return after.status !== 'todo' || after.archivedAt !== null
}

export interface TaskHudDeps {
  /** 当前全部任务快照（main 注入 `() => tasks.getTasks()`） */
  getTasks(): readonly Task[]
  /** 当前全部项目（用于 HUD 项目名映射；main 注入 `() => tasks.getProjects()`） */
  getProjects(): readonly Project[]
  /** 当前设置（每 tick 读取 hudScope；main 注入 `() => settings.get()`） */
  getSettings(): Settings
  /** 推送 `pet:event.tasks-urgent`（仅状态变化时调用；main 注入广播函数） */
  sendEvent(event: PetEvent): void
  /** 显示应用内气泡并返回 bubbleId（HUD 空闲后的汇总）；null = 本轮失败可重试 */
  sendBubble(text: string): string | null
  /** 撤下已显示的气泡（汇总内容失效时重建/撤除） */
  dismissBubble(bubbleId: string): void
  /** 提交两阶段提醒消费（main 注入 `tasks.consumeReminder`）；失败应 throw */
  consumeReminder(input: { id: string; phase: ReminderPhase; at: Timestamp }): void
  /** 汇总气泡展示时长（毫秒）；默认 8000，与 main 发送气泡的 durationMs 一致 */
  bubbleDurationMs?: number
  /** 时钟（保留注入位；当前所有方法显式接收 now，便于单测固定时间） */
  now?(): number
}

export interface TaskHud {
  /** 当前 HUD 状态（最多 3 条 + 总数 + 队列角标） */
  getState(now: Timestamp): UrgentTasksState
  /** 刷新：prune 过期队列项 → 按当前任务过滤 → 重建/撤下已显示汇总 → 空闲汇总 → 变化才推送 */
  refresh(now: Timestamp): void
  /**
   * 普通提醒分流：HUD 活跃 → 先消费再入队并刷新（同 taskId 一项、due 替换 soon）；
   * HUD 空闲 → 返回 'send' 交给调用方弹泡并自行消费。
   * 消费失败会 throw（调用方按失败处理，不留下内存排队项）。
   */
  offerNormalReminder(
    input: { taskId: string; dueAt: Timestamp; phase: ReminderPhase; text: string },
    now: Timestamp,
  ): 'queued' | 'send'
  /** 显式清除指定任务的排队项；若已显示汇总包含这些任务则撤下并按剩余项重建 */
  dropQueued(taskIds: readonly string[]): void
  /** 任务写操作提交后调用（完成/搁置/恢复/删除/改 dueAt）：过滤失效队列并刷新 */
  syncTasks(now: Timestamp): void
}

/** 当前已显示的汇总气泡（发送成功后队列清空，但仍需按任务变化重建） */
interface ActiveSummary {
  bubbleId: string
  items: QueuedReminder[]
  shownAt: Timestamp
}

export function createTaskHud(deps: TaskHudDeps): TaskHud {
  let queue: QueuedReminder[] = []
  /** 上次成功推送的状态键；null = 尚未推送过 */
  let lastSentKey: string | null = null
  let activeSummary: ActiveSummary | null = null
  const bubbleDurationMs = deps.bubbleDurationMs ?? DEFAULT_BUBBLE_DURATION_MS

  const findTask = (taskId: string): Task | undefined =>
    deps.getTasks().find((task) => task.id === taskId)

  /** 排队项/汇总项是否仍有效：任务存在、活动（todo 且未搁置）、dueAt 未变 */
  const isItemValid = (item: QueuedReminder): boolean => {
    const task = findTask(item.taskId)
    return (
      task !== undefined &&
      task.status === 'todo' &&
      task.archivedAt === null &&
      task.dueAt === item.dueAt
    )
  }

  const pruneQueue = (now: Timestamp): void => {
    queue = queue.filter((item) => now - item.enqueuedAt < HUD_QUEUE_TTL_MS)
  }

  const filterQueue = (): void => {
    queue = queue.filter((item) => isItemValid(item))
  }

  const getState = (now: Timestamp): UrgentTasksState => {
    const settings = deps.getSettings()
    const selected = selectHudTasks(deps.getTasks(), deps.getProjects(), settings.hudScope, now)
    return {
      tasks: selected.tasks,
      total: selected.total,
      queued: queue.filter((item) => isItemValid(item)).length,
    }
  }

  const stateKey = (state: UrgentTasksState): string =>
    `${state.tasks.map((task) => task.id).join(',')}|${String(state.total)}|${String(state.queued)}`

  const emitState = (state: UrgentTasksState): void => {
    const key = stateKey(state)
    if (key === lastSentKey) return
    try {
      deps.sendEvent({ type: 'tasks-urgent', urgentTasks: state })
    } catch (error) {
      // 推送失败不更新 lastSentKey：下一轮 refresh 会重试
      console.error('[task-hud] HUD 状态推送失败（不影响主流程）:', error)
      return
    }
    lastSentKey = key
  }

  const dismissSilently = (bubbleId: string): void => {
    try {
      deps.dismissBubble(bubbleId)
    } catch (error) {
      console.error('[task-hud] 摘要气泡撤下失败（不影响主流程）:', error)
    }
  }

  /** 汇总文案：最多列 3 条标题，其余“等 N 条”（如“还有 5 条任务提醒：A、B、C 等 2 条”） */
  const summaryTextFor = (items: readonly QueuedReminder[]): string => {
    const titles = items.slice(0, SUMMARY_TITLE_LIMIT).map((item) => {
      const raw = findTask(item.taskId)?.title ?? item.text
      return raw.length > SUMMARY_TITLE_MAX ? `${raw.slice(0, SUMMARY_TITLE_MAX)}…` : raw
    })
    const rest = items.length - titles.length
    const head = `还有 ${String(items.length)} 条任务提醒：${titles.join('、')}`
    return rest > 0 ? `${head} 等 ${String(rest)} 条` : head
  }

  const sendSummary = (items: readonly QueuedReminder[]): string | null => {
    try {
      return deps.sendBubble(summaryTextFor(items))
    } catch (error) {
      console.error('[task-hud] 汇总气泡发送失败（保留队列稍后重试）:', error)
      return null
    }
  }

  /**
   * 已显示汇总按当前任务重算：
   * - 气泡应已自然消失（超过展示时长）→ 直接释放记录
   * - 有任务失效 → 撤下旧气泡；仍有剩余项则重建汇总，全部失效则不再显示
   * - 重建失败时把剩余项放回队列（保留原 enqueuedAt），等下次 HUD 空闲再汇总
   */
  const reconcileSummary = (now: Timestamp): void => {
    if (activeSummary === null) return
    if (now - activeSummary.shownAt >= bubbleDurationMs) {
      activeSummary = null
      return
    }
    const remaining = activeSummary.items.filter((item) => isItemValid(item))
    if (remaining.length === activeSummary.items.length) return

    dismissSilently(activeSummary.bubbleId)
    activeSummary = null
    if (remaining.length === 0) return
    const bubbleId = sendSummary(remaining)
    if (bubbleId !== null) {
      activeSummary = { bubbleId, items: remaining, shownAt: now }
      return
    }
    queue = [...queue, ...remaining]
  }

  /** HUD 空闲且队列非空（且不在免打扰）→ 发 1 条汇总；成功才清队 */
  const maybeSendSummary = (now: Timestamp): void => {
    if (queue.length === 0) return
    if (getState(now).tasks.length > 0) return
    // 免打扰内禁止普通汇总；过期项照常淘汰，不保证次日可见
    if (isDndActive(now, DND_SETTINGS)) return
    const items = [...queue]
    const bubbleId = sendSummary(items)
    if (bubbleId === null) return
    queue = []
    activeSummary = { bubbleId, items, shownAt: now }
  }

  const refresh = (now: Timestamp): void => {
    pruneQueue(now)
    filterQueue()
    reconcileSummary(now)
    maybeSendSummary(now)
    emitState(getState(now))
  }

  const offerNormalReminder = (
    input: { taskId: string; dueAt: Timestamp; phase: ReminderPhase; text: string },
    now: Timestamp,
  ): 'queued' | 'send' => {
    pruneQueue(now)
    filterQueue()
    if (getState(now).tasks.length === 0) return 'send'

    const existing = queue.find((item) => item.taskId === input.taskId)
    if (existing !== undefined) {
      // 同任务已有一项：due 替换尚未投递的 soon（避免重复摘要），已 due 则幂等
      if (existing.phase === 'due' || input.phase === 'soon') return 'queued'
      deps.consumeReminder({ id: input.taskId, phase: 'due', at: now })
      existing.phase = 'due'
      existing.dueAt = input.dueAt
      existing.text = input.text
      refresh(now)
      return 'queued'
    }

    // 先提交消费，成功才进入内存队列（失败 throw，由调用方按失败重试）
    deps.consumeReminder({ id: input.taskId, phase: input.phase, at: now })
    queue.push({
      taskId: input.taskId,
      dueAt: input.dueAt,
      phase: input.phase,
      text: input.text,
      enqueuedAt: now,
    })
    // 超限丢最旧（数组前部即最旧；已消费状态保留，不补发）
    if (queue.length > HUD_QUEUE_MAX) queue = queue.slice(queue.length - HUD_QUEUE_MAX)
    refresh(now)
    return 'queued'
  }

  const dropQueued = (taskIds: readonly string[]): void => {
    if (taskIds.length === 0) return
    const dropped = new Set(taskIds)
    queue = queue.filter((item) => !dropped.has(item.taskId))
    if (activeSummary === null) return
    const remaining = activeSummary.items.filter((item) => !dropped.has(item.taskId))
    if (remaining.length === activeSummary.items.length) return
    dismissSilently(activeSummary.bubbleId)
    activeSummary = null
    if (remaining.length > 0) queue = [...queue, ...remaining]
  }

  return {
    getState,
    refresh,
    offerNormalReminder,
    dropQueued,
    syncTasks: refresh,
  }
}
