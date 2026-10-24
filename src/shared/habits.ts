/**
 * 独立打卡 · 周期纯规则（shared，main/renderer 共用；无 IO、无副作用）
 *
 * 口径：docs/35-0.4.0-data-ipc-spec.md §3（0.4.0 / IPC 2.0）。
 * - 每日：本地日历 04:00 至次日 04:00；每周：指定星期当天 04:00 至下一次同星期 04:00
 * - 不保存时区字段、不引入命名时区/DST 特殊规则；边界计算后进入 epoch 快照
 * - 周期 key = `${habitId}:${revision}:${startAt}`；revision 从 1 递增，已生效版本只追加
 * - 规则修改排到 currentCycle.endAt 生效；首次新周期可为短「桥接周期」
 * - 无 streak / 无跨时区适配
 */
import type {
  Habit,
  HabitPendingSchedule,
  HabitSchedule,
  HabitScheduleRevision,
  IsoWeekday,
  Timestamp,
} from './types'

export const HABIT_NAME_MAX = 80
export const HABIT_NOTE_MAX = 200
export const HABIT_CHECKIN_NOTE_MAX = 140
export const HABIT_HISTORY_DEFAULT_LIMIT = 50
export const HABIT_HISTORY_MAX_LIMIT = 100

/** 本机本地业务日切换时刻：04:00（Habit 无独立时区） */
const HABIT_DAY_START_HOUR = 4

// ---------------------------------------------------------------------------
// 校验与归一化
// ---------------------------------------------------------------------------

export function isIsoWeekday(value: unknown): value is IsoWeekday {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 7
}

export function isHabitSchedule(value: unknown): value is HabitSchedule {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as Record<string, unknown>
  if (raw['frequency'] === 'daily') return raw['deadlineWeekday'] === null
  if (raw['frequency'] === 'weekly') return isIsoWeekday(raw['deadlineWeekday'])
  return false
}

function collapseSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** 习惯名归一化：合并空白、去首尾、截断；空名返回 null（调用方应拒绝写入） */
export function normalizeHabitName(raw: string): string | null {
  const value = collapseSpaces(raw)
  if (value.length === 0) return null
  return value.slice(0, HABIT_NAME_MAX)
}

/** 习惯备注归一化：空白 → null；超长截断 */
export function normalizeHabitNote(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null
  const value = raw.trim()
  return value.length === 0 ? null : value.slice(0, HABIT_NOTE_MAX)
}

/** 打卡备注归一化：空白 → null；超长截断 */
export function normalizeHabitCheckinNote(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null
  const value = raw.trim()
  return value.length === 0 ? null : value.slice(0, HABIT_CHECKIN_NOTE_MAX)
}

export function isSameSchedule(a: HabitSchedule, b: HabitSchedule): boolean {
  if (a.frequency !== b.frequency) return false
  if (a.frequency === 'weekly' && b.frequency === 'weekly') {
    return a.deadlineWeekday === b.deadlineWeekday
  }
  return true
}

/** 周期 key 构造（稳定，不依赖 now） */
export function makeCycleKey(habitId: string, revision: number, startAt: Timestamp): string {
  return `${habitId}:${String(revision)}:${String(startAt)}`
}

// ---------------------------------------------------------------------------
// 本地 04:00 日历边界（epoch ms）
// ---------------------------------------------------------------------------

/** 把本地日历日偏移 delta 天后取 04:00（用日历运算，避免固定毫秒粗算） */
function localDayAt4(ms: Timestamp, dayDelta: number): Timestamp {
  const date = new Date(ms)
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + dayDelta,
    HABIT_DAY_START_HOUR,
    0,
    0,
    0,
  ).getTime()
}

/** 包含 ms 的当前业务日起点：本地日历 04:00（ms 恰好 04:00 属于新一天） */
function businessDayStart(ms: Timestamp): Timestamp {
  const candidate = localDayAt4(ms, 0)
  return ms < candidate ? localDayAt4(ms, -1) : candidate
}

/** ISO 星期：1=周一 … 7=周日 */
function isoWeekdayOf(ms: Timestamp): IsoWeekday {
  const day = new Date(ms).getDay()
  const iso = day === 0 ? 7 : day
  return iso as IsoWeekday
}

export interface HabitCycleRange {
  startAt: Timestamp
  endAt: Timestamp
}

/**
 * 以 startAt（必须已是某边界 04:00）为起点，按规则求「严格晚于起点的第一个截止点」作为 endAt。
 * - 每日：次日 04:00
 * - 每周：下一个目标星期 04:00（若起点就是目标星期，则为 7 天后）
 */
export function cycleEndFrom(schedule: HabitSchedule, startAt: Timestamp): Timestamp {
  if (schedule.frequency === 'daily') return localDayAt4(startAt, 1)
  const current = isoWeekdayOf(startAt)
  const delta = (schedule.deadlineWeekday - current + 7) % 7
  return localDayAt4(startAt, delta === 0 ? 7 : delta)
}

/** 包含 now 的完整周期（用于创建/定位当前周期） */
export function cycleContaining(schedule: HabitSchedule, now: Timestamp): HabitCycleRange {
  if (schedule.frequency === 'daily') {
    const startAt = businessDayStart(now)
    return { startAt, endAt: localDayAt4(startAt, 1) }
  }
  const refStart = businessDayStart(now)
  const refWeekday = isoWeekdayOf(refStart)
  const delta = (refWeekday - schedule.deadlineWeekday + 7) % 7
  let startAt = localDayAt4(refStart, -delta)
  if (startAt > now) startAt = localDayAt4(startAt, -7)
  return { startAt, endAt: localDayAt4(startAt, 7) }
}

// ---------------------------------------------------------------------------
// 周期快照与 revision 推进
// ---------------------------------------------------------------------------

/** 当前周期是否已越界（now 落在 startAt 之前的时钟回拨另判） */
export function isCycleExpired(habit: Habit, now: Timestamp): boolean {
  return now >= habit.currentCycle.endAt
}

/** 该 revision 是否已生效（从 scheduleRevisions 中查找） */
export function findRevision(
  revisions: readonly HabitScheduleRevision[],
  revision: number,
): HabitScheduleRevision | null {
  return revisions.find((item) => item.revision === revision) ?? null
}

/**
 * 规则修改计划（docs/35 §3.2）：
 * - 与当前周期规则相同 → 取消 pending（返回 null）
 * - 否则 pending 到 currentCycle.endAt 生效，多次修改最后一次胜出
 */
export function planScheduleChange(
  habit: Habit,
  schedule: HabitSchedule,
  now: Timestamp,
): HabitPendingSchedule | null {
  if (isSameSchedule(habit.currentCycle.schedule, schedule)) return null
  return { schedule, requestedAt: now, effectiveAt: habit.currentCycle.endAt }
}

/**
 * 纯函数：把习惯推进到 now 所在周期（list/update/checkin 前调用）。
 * - now < currentCycle.startAt → CLOCK_BEFORE_CURRENT_CYCLE（不回滚、不开历史打卡）
 * - 未越界 → 原对象返回（不写盘）
 * - 越界：先应用 pending（追加 revision），再按新规则定位；离线跨多个周期时逐周期推进，
 *   首次新周期由 cycleEndFrom 得到（可为短桥接周期），之后为完整周期
 */
export function advanceHabit(habit: Habit, now: Timestamp): Habit {
  if (now < habit.currentCycle.startAt) {
    throw new Error('CLOCK_BEFORE_CURRENT_CYCLE: 系统时间早于当前打卡周期，暂不可打卡')
  }
  if (now < habit.currentCycle.endAt) return habit

  let startAt = habit.currentCycle.startAt
  let endAt = habit.currentCycle.endAt
  let revision = habit.currentCycle.revision
  let schedule = habit.currentCycle.schedule
  let revisions = habit.scheduleRevisions
  let pending = habit.pendingSchedule
  let guard = 0

  while (now >= endAt) {
    guard += 1
    if (guard > 10_000) throw new Error('HABIT_CYCLE_CHAIN: 周期推进次数异常，请检查系统时间')
    const nextStart = endAt
    if (pending !== null && pending.effectiveAt <= nextStart) {
      revision += 1
      schedule = pending.schedule
      revisions = [...revisions, { revision, schedule, effectiveAt: nextStart }]
      pending = null
    }
    startAt = nextStart
    endAt = cycleEndFrom(schedule, startAt)
  }

  const nextCycle = {
    key: makeCycleKey(habit.id, revision, startAt),
    revision,
    schedule,
    startAt,
    endAt,
  }
  return {
    ...habit,
    scheduleRevisions: revisions,
    currentCycle: nextCycle,
    pendingSchedule: pending,
  }
}

/** 新习惯初始周期：revision=1，起点为包含 now 的自然周期（可早于 createdAt） */
export function buildInitialHabitCycle(
  habitId: string,
  schedule: HabitSchedule,
  now: Timestamp,
): { revision: HabitScheduleRevision; cycle: Habit['currentCycle'] } {
  const range = cycleContaining(schedule, now)
  return {
    revision: { revision: 1, schedule, effectiveAt: range.startAt },
    cycle: {
      key: makeCycleKey(habitId, 1, range.startAt),
      revision: 1,
      schedule,
      startAt: range.startAt,
      endAt: range.endAt,
    },
  }
}

// ---------------------------------------------------------------------------
// 加载校验辅助（v3 严格校验，docs/35 §1.1）
// ---------------------------------------------------------------------------

export function isTimestampValue(value: unknown): value is Timestamp {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 校验 currentCycle 是否与 habitId、revision 历史一致：
 * - revision > 0 且能在 scheduleRevisions 中找到
 * - schedule 与对应 revision 一致
 * - key 可按 habitId/revision/startAt 重建相等
 * - startAt < endAt
 * - **startAt >= revision.effectiveAt**（规则不变时 advanceHabit 只推进 startAt、不追加 revision，
 *   因此同一 revision 的后续周期 startAt 会晚于 effectiveAt；不允许 startAt 早于 effectiveAt）
 */
export function isCycleSnapshotConsistent(
  habitId: string,
  cycle: Habit['currentCycle'],
  revisions: readonly HabitScheduleRevision[],
): boolean {
  if (!isTimestampValue(cycle.startAt) || !isTimestampValue(cycle.endAt)) return false
  if (cycle.startAt >= cycle.endAt) return false
  if (!Number.isInteger(cycle.revision) || cycle.revision < 1) return false
  if (!isHabitSchedule(cycle.schedule)) return false
  if (cycle.key !== makeCycleKey(habitId, cycle.revision, cycle.startAt)) return false
  const revision = findRevision(revisions, cycle.revision)
  if (revision === null) return false
  if (cycle.startAt < revision.effectiveAt) return false
  return isSameSchedule(revision.schedule, cycle.schedule)
}

/** 若 pending 生效点必须等于当前周期 endAt；非法返回 false */
export function isPendingConsistent(
  pending: HabitPendingSchedule | null,
  cycle: Habit['currentCycle'],
): boolean {
  if (pending === null) return true
  if (!isTimestampValue(pending.requestedAt)) return false
  if (!isHabitSchedule(pending.schedule)) return false
  return pending.effectiveAt === cycle.endAt
}
