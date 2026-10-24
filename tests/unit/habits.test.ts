/**
 * 独立打卡纯规则单测 · Agent-Data（0.4.0 / docs/35 §3、docs/37 H-01～H-12）
 *
 * 全部使用固定本地时钟；不依赖真实时间，也不做跨时区适配承诺。
 */
import { describe, expect, it } from 'vitest'

import {
  advanceHabit,
  buildInitialHabitCycle,
  cycleContaining,
  cycleEndFrom,
  findRevision,
  HABIT_CHECKIN_NOTE_MAX,
  HABIT_NAME_MAX,
  HABIT_NOTE_MAX,
  isCycleSnapshotConsistent,
  isHabitSchedule,
  isIsoWeekday,
  isPendingConsistent,
  isSameSchedule,
  makeCycleKey,
  normalizeHabitCheckinNote,
  normalizeHabitName,
  normalizeHabitNote,
  planScheduleChange,
} from '@shared/habits'
import type { Habit, HabitSchedule } from '@shared/types'

/** 本地时间构造：2026-10-21 04:00 等 */
function at(
  year: number,
  month: number,
  day: number,
  hour = 4,
  minute = 0,
  second = 0,
  ms = 0,
): number {
  return new Date(year, month - 1, day, hour, minute, second, ms).getTime()
}

const DAILY: HabitSchedule = { frequency: 'daily', deadlineWeekday: null }
function weekly(weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7): HabitSchedule {
  return { frequency: 'weekly', deadlineWeekday: weekday }
}

/** 用给定 schedule/now 构造一个「刚创建」的习惯（revision 1） */
function makeHabit(schedule: HabitSchedule, now: number, id = 'habit-1'): Habit {
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

describe('归一化与校验', () => {
  it('习惯名合并空白、截断 80；空名 null', () => {
    expect(normalizeHabitName('  背   单词 ')).toBe('背 单词')
    expect(normalizeHabitName('   ')).toBeNull()
    expect(normalizeHabitName('x'.repeat(200))).toHaveLength(HABIT_NAME_MAX)
  })

  it('备注/打卡备注 trim、空 → null、截断', () => {
    expect(normalizeHabitNote('  备注  ')).toBe('备注')
    expect(normalizeHabitNote('   ')).toBeNull()
    expect(normalizeHabitNote(null)).toBeNull()
    expect(normalizeHabitNote('x'.repeat(300))).toHaveLength(HABIT_NOTE_MAX)
    expect(normalizeHabitCheckinNote('x'.repeat(300))).toHaveLength(HABIT_CHECKIN_NOTE_MAX)
  })

  it('schedule 校验：daily 必须 weekday=null，weekly 必须 1..7', () => {
    expect(isHabitSchedule(DAILY)).toBe(true)
    expect(isHabitSchedule(weekly(7))).toBe(true)
    expect(isHabitSchedule({ frequency: 'daily', deadlineWeekday: 1 })).toBe(false)
    expect(isHabitSchedule({ frequency: 'weekly', deadlineWeekday: null })).toBe(false)
    expect(isHabitSchedule({ frequency: 'weekly', deadlineWeekday: 8 })).toBe(false)
    expect(isHabitSchedule(null)).toBe(false)
    expect(isIsoWeekday(1)).toBe(true)
    expect(isIsoWeekday(0)).toBe(false)
    expect(isIsoWeekday(7.5)).toBe(false)
  })

  it('isSameSchedule', () => {
    expect(isSameSchedule(DAILY, DAILY)).toBe(true)
    expect(isSameSchedule(weekly(7), weekly(7))).toBe(true)
    expect(isSameSchedule(weekly(7), weekly(1))).toBe(false)
    expect(isSameSchedule(DAILY, weekly(7))).toBe(false)
  })
})

describe('每日周期（本地 04:00）', () => {
  it('03:59 属于前一周期；04:00 属于新周期', () => {
    const before = cycleContaining(DAILY, at(2026, 10, 24, 3, 59, 59, 999))
    expect(before.startAt).toBe(at(2026, 10, 23))
    expect(before.endAt).toBe(at(2026, 10, 24))

    const boundary = cycleContaining(DAILY, at(2026, 10, 24, 4, 0, 0, 0))
    expect(boundary.startAt).toBe(at(2026, 10, 24))
    expect(boundary.endAt).toBe(at(2026, 10, 25))

    const after = cycleContaining(DAILY, at(2026, 10, 24, 4, 0, 0, 1))
    expect(after.startAt).toBe(at(2026, 10, 24))
  })

  it('跨月/跨年/闰日边界按本地日历解释', () => {
    const monthEnd = cycleContaining(DAILY, at(2026, 11, 1, 2, 0))
    expect(monthEnd.startAt).toBe(at(2026, 10, 31))
    expect(monthEnd.endAt).toBe(at(2026, 11, 1))

    const yearEnd = cycleContaining(DAILY, at(2027, 1, 1, 1, 0))
    expect(yearEnd.startAt).toBe(at(2026, 12, 31))
    expect(yearEnd.endAt).toBe(at(2027, 1, 1))

    const leap = cycleContaining(DAILY, at(2028, 2, 29, 3, 59))
    expect(leap.startAt).toBe(at(2028, 2, 28))
    expect(leap.endAt).toBe(at(2028, 2, 29))
    const leapNext = cycleContaining(DAILY, at(2028, 2, 29, 4, 0))
    expect(leapNext.startAt).toBe(at(2028, 2, 29))
    expect(leapNext.endAt).toBe(at(2028, 3, 1))
  })
})

describe('每周周期（指定星期当天 04:00 截止）', () => {
  it('周日截止：周日 03:59 属上一周期，04:00 起属新周期', () => {
    // 2026-10-25 是周日
    const before = cycleContaining(weekly(7), at(2026, 10, 25, 3, 59, 59, 999))
    expect(before.startAt).toBe(at(2026, 10, 18))
    expect(before.endAt).toBe(at(2026, 10, 25))

    const after = cycleContaining(weekly(7), at(2026, 10, 25, 4, 0, 0, 0))
    expect(after.startAt).toBe(at(2026, 10, 25))
    expect(after.endAt).toBe(at(2026, 11, 1))
  })

  it('七种截止日都能定位包含 now 的周期', () => {
    // 以 2026-10-25（周日）10:00 为 now，逐个截止日验证 start 是该星期几的 04:00
    const now = at(2026, 10, 25, 10, 0)
    const expectedStart: Record<number, number> = {
      1: at(2026, 10, 19),
      2: at(2026, 10, 20),
      3: at(2026, 10, 21),
      4: at(2026, 10, 22),
      5: at(2026, 10, 23),
      6: at(2026, 10, 24),
      7: at(2026, 10, 25),
    }
    for (const weekday of [1, 2, 3, 4, 5, 6, 7] as const) {
      const range = cycleContaining(weekly(weekday), now)
      const expected = expectedStart[weekday]
      expect(expected).toBeDefined()
      expect(range.startAt).toBe(expected)
      expect(range.endAt).toBe((expected ?? 0) + 7 * 24 * 60 * 60 * 1000)
      expect(range.startAt <= now && now < range.endAt).toBe(true)
    }
  })

  it('跨年周：2027-01-03（周日）03:59 仍属 2026-12-27 起的周期', () => {
    const range = cycleContaining(weekly(7), at(2027, 1, 3, 3, 59))
    expect(range.startAt).toBe(at(2026, 12, 27))
    expect(range.endAt).toBe(at(2027, 1, 3))
  })

  it('cycleEndFrom：起点即目标星期 → 7 天后；否则第一个目标星期（桥接）', () => {
    // 起点周五 2026-10-30 04:00，改周日截止 → 桥接 2 天
    expect(cycleEndFrom(weekly(7), at(2026, 10, 30))).toBe(at(2026, 11, 1))
    // 起点即周日 → 完整一周
    expect(cycleEndFrom(weekly(7), at(2026, 11, 1))).toBe(at(2026, 11, 8))
    expect(cycleEndFrom(DAILY, at(2026, 10, 21))).toBe(at(2026, 10, 22))
  })
})

describe('周期 key 与初始周期', () => {
  it('key = habitId:revision:startAt，且初始 revision=1', () => {
    const now = at(2026, 10, 21, 10)
    const { revision, cycle } = buildInitialHabitCycle('habit-1', DAILY, now)
    expect(revision.revision).toBe(1)
    expect(revision.effectiveAt).toBe(cycle.startAt)
    expect(cycle.key).toBe('habit-1:1:' + String(cycle.startAt))
    expect(makeCycleKey('habit-1', 1, cycle.startAt)).toBe(cycle.key)
    // 起点可早于创建时间（自然周期）
    expect(cycle.startAt).toBe(at(2026, 10, 21))
    expect(now).toBeGreaterThan(cycle.startAt)
  })
})

describe('推进周期（advanceHabit）', () => {
  it('未越界返回原对象（不写盘）', () => {
    const habit = makeHabit(DAILY, at(2026, 10, 21, 10))
    expect(advanceHabit(habit, at(2026, 10, 21, 23))).toBe(habit)
  })

  it('临界点推进：04:00 整点进入下一周期', () => {
    const habit = makeHabit(DAILY, at(2026, 10, 21, 10))
    const advanced = advanceHabit(habit, at(2026, 10, 22, 4, 0))
    expect(advanced.currentCycle.startAt).toBe(at(2026, 10, 22))
    expect(advanced.currentCycle.endAt).toBe(at(2026, 10, 23))
    expect(advanced.currentCycle.key).toBe('habit-1:1:' + String(at(2026, 10, 22)))
    expect(advanced.scheduleRevisions).toHaveLength(1)
  })

  it('离线越过多个周期：直接定位 now 所在周期，不补记', () => {
    const habit = makeHabit(DAILY, at(2026, 10, 21, 10))
    const advanced = advanceHabit(habit, at(2026, 10, 25, 12))
    expect(advanced.currentCycle.startAt).toBe(at(2026, 10, 25))
    expect(advanced.currentCycle.endAt).toBe(at(2026, 10, 26))
    expect(advanced.scheduleRevisions).toHaveLength(1)
  })

  it('pending 到 endAt 生效：周五改周日 → 短桥接周期（2 天）', () => {
    // 周一 2026-10-26 创建，周五截止 → 当前周期 10-23 04:00 ~ 10-30 04:00
    const habit = makeHabit(weekly(5), at(2026, 10, 26, 10))
    expect(habit.currentCycle.endAt).toBe(at(2026, 10, 30))
    const pending = planScheduleChange(habit, weekly(7), at(2026, 10, 26, 11))
    expect(pending).not.toBeNull()
    expect(pending?.effectiveAt).toBe(at(2026, 10, 30))
    const withPending: Habit = { ...habit, pendingSchedule: pending }

    // 10-30 04:01 推进：追加 revision 2，新周期 10-30 04:00 ~ 11-01 04:00（桥接）
    const advanced = advanceHabit(withPending, at(2026, 10, 30, 4, 1))
    expect(advanced.scheduleRevisions).toHaveLength(2)
    expect(advanced.currentCycle.revision).toBe(2)
    expect(advanced.currentCycle.schedule).toEqual(weekly(7))
    expect(advanced.currentCycle.startAt).toBe(at(2026, 10, 30))
    expect(advanced.currentCycle.endAt).toBe(at(2026, 11, 1))
    expect(advanced.pendingSchedule).toBeNull()
    expect(findRevision(advanced.scheduleRevisions, 2)?.effectiveAt).toBe(at(2026, 10, 30))
  })

  it('桥接后再推进为完整周周期（同 revision）', () => {
    const habit = makeHabit(weekly(5), at(2026, 10, 26, 10))
    const withPending: Habit = {
      ...habit,
      pendingSchedule: planScheduleChange(habit, weekly(7), at(2026, 10, 26, 11)),
    }
    const bridged = advanceHabit(withPending, at(2026, 10, 31, 10))
    expect(bridged.currentCycle.endAt).toBe(at(2026, 11, 1))
    const next = advanceHabit(bridged, at(2026, 11, 3, 10))
    expect(next.currentCycle.startAt).toBe(at(2026, 11, 1))
    expect(next.currentCycle.endAt).toBe(at(2026, 11, 8))
    expect(next.scheduleRevisions).toHaveLength(2)
  })

  it('离线越过 pending 生效点和后续多个周期：先应用 pending，再按新规则定位', () => {
    const habit = makeHabit(weekly(5), at(2026, 10, 26, 10))
    const withPending: Habit = {
      ...habit,
      pendingSchedule: planScheduleChange(habit, weekly(1), at(2026, 10, 26, 11)),
    }
    // 10-30 04:00 起周日... 这里改周一：桥接 10-30 ~ 11-02（周一）
    const advanced = advanceHabit(withPending, at(2026, 11, 15, 10))
    expect(advanced.currentCycle.revision).toBe(2)
    expect(advanced.currentCycle.schedule).toEqual(weekly(1))
    expect(advanced.currentCycle.startAt).toBe(at(2026, 11, 9))
    expect(advanced.currentCycle.endAt).toBe(at(2026, 11, 16))
  })

  it('时钟回拨至 currentCycle.startAt 之前 → CLOCK_BEFORE_CURRENT_CYCLE', () => {
    const habit = makeHabit(DAILY, at(2026, 10, 21, 10))
    expect(() => advanceHabit(habit, at(2026, 10, 21, 3, 59))).toThrow('CLOCK_BEFORE_CURRENT_CYCLE')
  })

  it('改回当前规则 → 取消 pending（planScheduleChange 返回 null）', () => {
    const habit = makeHabit(weekly(5), at(2026, 10, 26, 10))
    expect(planScheduleChange(habit, weekly(5), at(2026, 10, 26, 11))).toBeNull()
  })
})

describe('加载校验辅助', () => {
  it('isCycleSnapshotConsistent：key/schedule/effectiveAt 一致才通过', () => {
    const habit = makeHabit(DAILY, at(2026, 10, 21, 10))
    expect(isCycleSnapshotConsistent(habit.id, habit.currentCycle, habit.scheduleRevisions)).toBe(
      true,
    )

    expect(
      isCycleSnapshotConsistent(
        habit.id,
        { ...habit.currentCycle, key: 'bad-key' },
        habit.scheduleRevisions,
      ),
    ).toBe(false)

    expect(
      isCycleSnapshotConsistent(
        habit.id,
        { ...habit.currentCycle, schedule: weekly(7) },
        habit.scheduleRevisions,
      ),
    ).toBe(false)

    expect(
      isCycleSnapshotConsistent(
        habit.id,
        { ...habit.currentCycle, startAt: 0 },
        habit.scheduleRevisions,
      ),
    ).toBe(false)
  })

  it('isCycleSnapshotConsistent：允许 startAt 晚于 revision.effectiveAt（跨周期重启），禁止更早', () => {
    const habit = makeHabit(DAILY, at(2026, 10, 21, 10))
    // 规则不变时 advanceHabit 只推进 startAt，不追加 revision
    const advanced = advanceHabit(habit, at(2026, 10, 24, 12))
    expect(advanced.currentCycle.revision).toBe(1)
    expect(advanced.currentCycle.startAt).toBe(at(2026, 10, 24))
    expect(advanced.scheduleRevisions[0]?.effectiveAt).toBe(at(2026, 10, 21))
    expect(advanced.currentCycle.startAt).toBeGreaterThan(
      advanced.scheduleRevisions[0]?.effectiveAt ?? Number.POSITIVE_INFINITY,
    )
    // P1：推进后的当前周期必须通过加载校验（否则重启会误判损坏）
    expect(
      isCycleSnapshotConsistent(advanced.id, advanced.currentCycle, advanced.scheduleRevisions),
    ).toBe(true)

    // 反向：startAt 早于 revision.effectiveAt 非法（key 已按该 startAt 重建，仍必须拒绝）
    const earlierStart = at(2026, 10, 20)
    const earlierCycle = {
      ...habit.currentCycle,
      startAt: earlierStart,
      key: makeCycleKey(habit.id, habit.currentCycle.revision, earlierStart),
    }
    expect(isCycleSnapshotConsistent(habit.id, earlierCycle, habit.scheduleRevisions)).toBe(false)
  })

  it('isPendingConsistent：pending.effectiveAt 必须等于当前周期 endAt', () => {
    const habit = makeHabit(DAILY, at(2026, 10, 21, 10))
    expect(isPendingConsistent(null, habit.currentCycle)).toBe(true)
    expect(
      isPendingConsistent(
        {
          schedule: DAILY,
          requestedAt: at(2026, 10, 21, 9),
          effectiveAt: habit.currentCycle.endAt,
        },
        habit.currentCycle,
      ),
    ).toBe(true)
    expect(
      isPendingConsistent(
        {
          schedule: DAILY,
          requestedAt: at(2026, 10, 21, 9),
          effectiveAt: habit.currentCycle.endAt + 1,
        },
        habit.currentCycle,
      ),
    ).toBe(false)
  })
})
