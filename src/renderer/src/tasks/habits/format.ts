/**
 * 打卡（Habit）展示辅助（0.4；本地时间解释，不保存时区）
 *
 * - 周期边界来自 main 返回的 epoch 快照，这里只格式化为“10-24 04:00”类短文案
 * - 规则说明按 docs/34 §5：周日截止 = 周日当天 04:00 换周期，白天属于下一期
 */
import type {
  HabitCheckin,
  HabitCycleSnapshot,
  HabitPendingSchedule,
  HabitSchedule,
  IsoWeekday,
} from '@shared/types'

import { formatMinuteTime } from '../format'

export const WEEKDAY_LABELS: Readonly<Record<IsoWeekday, string>> = {
  1: '周一',
  2: '周二',
  3: '周三',
  4: '周四',
  5: '周五',
  6: '周六',
  7: '周日',
}

export const WEEKDAY_OPTIONS: readonly IsoWeekday[] = [1, 2, 3, 4, 5, 6, 7]

export function formatWeekday(weekday: IsoWeekday): string {
  return WEEKDAY_LABELS[weekday]
}

/** 规则短文案：每天 04:00 换周期 / 每周日 04:00 截止 */
export function describeSchedule(schedule: HabitSchedule): string {
  if (schedule.frequency === 'daily') return '每天 04:00 换周期'
  // WEEKDAY_LABELS 为“周日/周一”，这里只取“日/一”，避免“每周周日”重复。
  return `每周${formatWeekday(schedule.deadlineWeekday).slice(1)} 04:00 截止`
}

/** 周截止说明（docs/34 §5.3 固定措辞） */
export function weeklyExplain(weekday: IsoWeekday): string {
  const label = formatWeekday(weekday)
  return `${label}当天 04:00 换周期，${label}白天属于下一期。`
}

/** 本期：10-24 04:00 → 10-25 04:00 */
export function formatCycle(cycle: HabitCycleSnapshot): string {
  return `本期：${formatMinuteTime(cycle.startAt)} → ${formatMinuteTime(cycle.endAt)}`
}

export function formatCheckedAt(timestamp: number): string {
  return formatMinuteTime(timestamp)
}

/** 待生效规则文案（下期生效） */
export function describePending(pending: HabitPendingSchedule): string {
  return `下期改为${describeSchedule(pending.schedule)}（本期仍于 ${formatMinuteTime(
    pending.effectiveAt,
  )} 结束）`
}

export function formatHistoryRecord(record: HabitCheckin): string {
  return `周期 ${formatMinuteTime(record.cycle.startAt)} → ${formatMinuteTime(
    record.cycle.endAt,
  )} · 已打卡 ${formatCheckedAt(record.checkedAt)}`
}

/** ISO 星期（1=周一 … 7=周日），Date#getDay 是 0=周日 */
function isoWeekdayOf(date: Date): number {
  return date.getDay() === 0 ? 7 : date.getDay()
}

/**
 * 预览用：给定生效时刻（本地 04:00 快照）与新规则，计算严格晚于它的第一个新截止点。
 * 仅用于“修改规则的下期预览”，真实周期边界以 main 持久化快照为准。
 */
export function nextBoundaryAfter(fromAt: number, schedule: HabitSchedule): number {
  const base = new Date(fromAt)
  if (schedule.frequency === 'daily') {
    for (let offset = 1; offset <= 2; offset += 1) {
      const candidate = new Date(
        base.getFullYear(),
        base.getMonth(),
        base.getDate() + offset,
        4,
        0,
        0,
        0,
      ).getTime()
      if (candidate > fromAt) return candidate
    }
    return fromAt + 24 * 60 * 60 * 1000
  }
  for (let offset = 0; offset <= 8; offset += 1) {
    const candidate = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate() + offset,
      4,
      0,
      0,
      0,
    )
    if (isoWeekdayOf(candidate) === schedule.deadlineWeekday && candidate.getTime() > fromAt) {
      return candidate.getTime()
    }
  }
  return fromAt + 7 * 24 * 60 * 60 * 1000
}
