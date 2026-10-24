/**
 * src/shared/rules.ts 契约行为单测（Agent-QA）
 *
 * 只测契约行为（PLAN §5/§6 + docs/03-product.md），不复制实现：
 * - day_key 04:00 边界、日历加减/跨月跨年、未来日期
 * - 等级 / 称号阈值边界、每日亲密度上限
 * - DND 跨零点 / start===end / 非法 HH:mm
 * - A11 补卡券账本（周一 04:00 切周、D± 窗口）
 * - 常量与默认 seed 契约
 */
import { describe, expect, it } from 'vitest'

import {
  BACKUP_KEEP,
  BUSINESS_DAY_START_HOUR,
  CHECKIN_NOTE_MAX,
  CLOCK_ANOMALY_THRESHOLD_MS,
  DAILY_INTIMACY_LIMIT,
  EVENT_RETENTION_DAYS,
  GRACE_MS,
  INTIMACY_LEVEL_THRESHOLDS,
  LATE_MERGE_MAX_MS,
  MAKEUP_TICKET_MAX,
  MAKEUP_WINDOW_DAYS,
  MAX_PLAN_SLOTS,
  PLAN_EST_MINUTES_MAX,
  PLAN_EST_MINUTES_MIN,
  PLAN_TITLE_MAX,
  TICK_GAP_MS,
  WAKE_SILENCE_MS,
  addDays,
  clampDailyIntimacyGain,
  createDefaultSettings,
  dayKeyEnd,
  dayKeyOf,
  dayKeyStart,
  daysBetween,
  dndUntil,
  formatDayKey,
  intimacyForLevel,
  intimacyToLevel,
  isDndActive,
  isFutureDayKey,
  isMakeupWindowDay,
  makeupAvailable,
  makeupWeekKey,
  parseDayKey,
  parseHhMmSeconds,
  titleForRealDays,
} from '@shared/rules'

/** 本地时间构造（避免测试依赖机器时区）；月份 0 起 */
function localTime(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): number {
  return new Date(year, month - 1, day, hour, minute, second, ms).getTime()
}

describe('常量契约（PLAN §5/§6）', () => {
  it('业务日固定 04:00、计划 3 槽位、备份 7 份、事件 180 天', () => {
    expect(BUSINESS_DAY_START_HOUR).toBe(4)
    expect(MAX_PLAN_SLOTS).toBe(3)
    expect(BACKUP_KEEP).toBe(7)
    expect(EVENT_RETENTION_DAYS).toBe(180)
    expect(DAILY_INTIMACY_LIMIT).toBe(60)
    expect(MAKEUP_TICKET_MAX).toBe(3)
    expect(MAKEUP_WINDOW_DAYS).toBe(2)
    expect(PLAN_TITLE_MAX).toBe(40)
    expect(PLAN_EST_MINUTES_MIN).toBe(5)
    expect(PLAN_EST_MINUTES_MAX).toBe(180)
    expect(CHECKIN_NOTE_MAX).toBe(140)
    expect(CLOCK_ANOMALY_THRESHOLD_MS).toBe(5 * 60 * 1000)
  })

  it('休眠补偿常量分离：WAKE_SILENCE 60s / GRACE 10min / 合并上限 24h / tick 兜底 90s', () => {
    expect(WAKE_SILENCE_MS).toBe(60_000)
    expect(GRACE_MS).toBe(10 * 60 * 1000)
    expect(LATE_MERGE_MAX_MS).toBe(24 * 60 * 60 * 1000)
    expect(TICK_GAP_MS).toBe(90_000)
    expect(WAKE_SILENCE_MS).toBeLessThan(GRACE_MS)
    expect(GRACE_MS).toBeLessThan(LATE_MERGE_MAX_MS)
  })

  it('等级阈值 10 档、单调递增且从 0 开始', () => {
    expect(INTIMACY_LEVEL_THRESHOLDS).toHaveLength(10)
    expect(INTIMACY_LEVEL_THRESHOLDS[0]).toBe(0)
    for (let index = 1; index < INTIMACY_LEVEL_THRESHOLDS.length; index += 1) {
      const previous = INTIMACY_LEVEL_THRESHOLDS[index - 1] ?? 0
      const current = INTIMACY_LEVEL_THRESHOLDS[index] ?? 0
      expect(current).toBeGreaterThan(previous)
    }
  })
})

describe('day_key：业务日 04:00 边界（PLAN §5）', () => {
  it('03:59 属前一业务日、04:00 属新业务日、02:00 属前一业务日', () => {
    expect(dayKeyOf(localTime(2026, 10, 19, 3, 59))).toBe('2026-10-18')
    expect(dayKeyOf(localTime(2026, 10, 19, 4, 0))).toBe('2026-10-19')
    expect(dayKeyOf(localTime(2026, 10, 19, 2, 0))).toBe('2026-10-18')
  })

  it('23:59 仍属当日业务日', () => {
    expect(dayKeyOf(localTime(2026, 10, 19, 23, 59))).toBe('2026-10-19')
    expect(dayKeyOf(localTime(2026, 10, 20, 3, 59, 59, 999))).toBe('2026-10-19')
  })

  it('dayKeyStart/End 是左闭右开的 04:00 边界', () => {
    expect(dayKeyStart('2026-10-19')).toBe(localTime(2026, 10, 19, 4, 0))
    expect(dayKeyEnd('2026-10-19')).toBe(localTime(2026, 10, 20, 4, 0))
    const start = dayKeyStart('2026-10-19')
    expect(dayKeyOf(start)).toBe('2026-10-19')
    expect(dayKeyOf(start - 1)).toBe('2026-10-18')
  })

  it('formatDayKey/parseDayKey 严格校验合法日历日', () => {
    expect(formatDayKey(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(parseDayKey('2026-02-28')).toEqual({ year: 2026, month: 2, day: 28 })
    expect(parseDayKey('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 })
    expect(parseDayKey('2026-02-29')).toBeNull()
    expect(parseDayKey('2026-02-30')).toBeNull()
    expect(parseDayKey('2026-13-01')).toBeNull()
    expect(parseDayKey('2026-1-01')).toBeNull()
    expect(parseDayKey('2026/01/01')).toBeNull()
  })

  it('addDays 跨月、跨年、闰年', () => {
    expect(addDays('2026-10-19', 1)).toBe('2026-10-20')
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2024-02-29', 1)).toBe('2024-03-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2026-10-19', 0)).toBe('2026-10-19')
  })

  it('daysBetween 按日历日计算，不受 DST/时区偏移影响', () => {
    expect(daysBetween('2026-10-01', '2026-10-19')).toBe(18)
    expect(daysBetween('2026-10-19', '2026-10-01')).toBe(-18)
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1)
    expect(daysBetween('2026-10-19', '2026-10-19')).toBe(0)
  })

  it('isFutureDayKey 拒绝未来业务日、接受今天与过去', () => {
    const now = localTime(2026, 10, 19, 10, 0)
    expect(isFutureDayKey('2026-10-20', now)).toBe(true)
    expect(isFutureDayKey('2026-10-19', now)).toBe(false)
    expect(isFutureDayKey('2026-10-18', now)).toBe(false)
    // 03:59 时「今天」还是前一业务日
    const beforeBoundary = localTime(2026, 10, 19, 3, 59)
    expect(isFutureDayKey('2026-10-19', beforeBoundary)).toBe(true)
  })
})

describe('成长：等级 / 称号 / 每日上限', () => {
  it('intimacyToLevel 10 档阈值边界（含负值与超上限）', () => {
    expect(intimacyToLevel(-100)).toBe(1)
    expect(intimacyToLevel(0)).toBe(1)
    expect(intimacyToLevel(99)).toBe(1)
    expect(intimacyToLevel(100)).toBe(2)
    expect(intimacyToLevel(299)).toBe(2)
    expect(intimacyToLevel(300)).toBe(3)
    expect(intimacyToLevel(700)).toBe(4)
    expect(intimacyToLevel(1500)).toBe(5)
    expect(intimacyToLevel(3000)).toBe(6)
    expect(intimacyToLevel(6000)).toBe(7)
    expect(intimacyToLevel(12000)).toBe(8)
    expect(intimacyToLevel(24000)).toBe(9)
    expect(intimacyToLevel(48000)).toBe(10)
    expect(intimacyToLevel(1_000_000)).toBe(10)
  })

  it('intimacyForLevel 是 intimacyToLevel 的逆边界并钳制 1..10', () => {
    expect(intimacyForLevel(0)).toBe(0)
    expect(intimacyForLevel(1)).toBe(0)
    expect(intimacyForLevel(2)).toBe(100)
    expect(intimacyForLevel(10)).toBe(48000)
    expect(intimacyForLevel(99)).toBe(48000)
    for (let level = 1; level <= 10; level += 1) {
      expect(intimacyToLevel(intimacyForLevel(level))).toBe(level)
    }
  })

  it('titleForRealDays 阈值边界：0/7/30/100/365', () => {
    expect(titleForRealDays(-1)).toBe('初遇')
    expect(titleForRealDays(0)).toBe('初遇')
    expect(titleForRealDays(6)).toBe('初遇')
    expect(titleForRealDays(7)).toBe('七日鲸友')
    expect(titleForRealDays(29)).toBe('七日鲸友')
    expect(titleForRealDays(30)).toBe('月度同行者')
    expect(titleForRealDays(99)).toBe('月度同行者')
    expect(titleForRealDays(100)).toBe('百日守鲸人')
    expect(titleForRealDays(364)).toBe('百日守鲸人')
    expect(titleForRealDays(365)).toBe('鲸落星河')
    expect(titleForRealDays(10_000)).toBe('鲸落星河')
  })

  it('clampDailyIntimacyGain 单业务日上限 60（04:00 重置由调用方保证）', () => {
    expect(clampDailyIntimacyGain(10, 0)).toBe(10)
    expect(clampDailyIntimacyGain(100, 50)).toBe(10)
    expect(clampDailyIntimacyGain(60, 0)).toBe(60)
    expect(clampDailyIntimacyGain(10, 60)).toBe(0)
    expect(clampDailyIntimacyGain(10, 100)).toBe(0)
    expect(clampDailyIntimacyGain(0, 0)).toBe(0)
    expect(clampDailyIntimacyGain(-5, 0)).toBe(0)
    expect(clampDailyIntimacyGain(10, -10)).toBe(10)
  })
})

describe('免打扰（DND，PLAN §5：默认 23:00–07:00 跨零点）', () => {
  const dnd = { enabled: true, start: '23:00', end: '07:00' }

  it('跨零点区间：23:00–07:00', () => {
    expect(isDndActive(localTime(2026, 10, 19, 22, 59), dnd)).toBe(false)
    expect(isDndActive(localTime(2026, 10, 19, 23, 0), dnd)).toBe(true)
    expect(isDndActive(localTime(2026, 10, 19, 23, 30), dnd)).toBe(true)
    expect(isDndActive(localTime(2026, 10, 20, 0, 0), dnd)).toBe(true)
    expect(isDndActive(localTime(2026, 10, 20, 6, 59), dnd)).toBe(true)
    expect(isDndActive(localTime(2026, 10, 20, 7, 0), dnd)).toBe(false)
  })

  it('非跨零点区间与 enabled=false', () => {
    const daytime = { enabled: true, start: '09:00', end: '17:00' }
    expect(isDndActive(localTime(2026, 10, 19, 8, 59), daytime)).toBe(false)
    expect(isDndActive(localTime(2026, 10, 19, 9, 0), daytime)).toBe(true)
    expect(isDndActive(localTime(2026, 10, 19, 17, 0), daytime)).toBe(false)
    expect(isDndActive(localTime(2026, 10, 19, 23, 0), { ...dnd, enabled: false })).toBe(false)
  })

  it('start === end 视为不生效', () => {
    const zero = { enabled: true, start: '23:00', end: '23:00' }
    expect(isDndActive(localTime(2026, 10, 19, 23, 30), zero)).toBe(false)
    expect(isDndActive(localTime(2026, 10, 19, 12, 0), zero)).toBe(false)
  })

  it('非法 HH:mm 返回 false / null，不抛异常', () => {
    const invalid = { enabled: true, start: '24:00', end: '07:00' }
    expect(isDndActive(localTime(2026, 10, 19, 23, 30), invalid)).toBe(false)
    expect(dndUntil(localTime(2026, 10, 19, 23, 30), invalid)).toBeNull()
  })

  it('dndUntil 返回本次结束时刻（跨零点进到次日 07:00）', () => {
    expect(dndUntil(localTime(2026, 10, 19, 23, 30), dnd)).toBe(localTime(2026, 10, 20, 7, 0))
    expect(dndUntil(localTime(2026, 10, 20, 6, 30), dnd)).toBe(localTime(2026, 10, 20, 7, 0))
    expect(dndUntil(localTime(2026, 10, 20, 7, 0), dnd)).toBeNull()
  })

  it('parseHhMmSeconds 解析与非法值', () => {
    expect(parseHhMmSeconds('00:00')).toBe(0)
    expect(parseHhMmSeconds('07:05')).toBe(7 * 3600 + 5 * 60)
    expect(parseHhMmSeconds('23:59')).toBe(23 * 3600 + 59 * 60)
    expect(parseHhMmSeconds('24:00')).toBeNull()
    expect(parseHhMmSeconds('9:00')).toBeNull()
    expect(parseHhMmSeconds('09:60')).toBeNull()
    expect(parseHhMmSeconds('-1:00')).toBeNull()
    expect(parseHhMmSeconds('ab:cd')).toBeNull()
    expect(parseHhMmSeconds('')).toBeNull()
  })
})

describe('A11 补卡券账本：自然周（周一 04:00 切周）', () => {
  it('周日 23:00 与周一 04:00 分属不同周；周一 03:59 仍属上一周', () => {
    // 2026-10-19 是周一
    const sundayNight = localTime(2026, 10, 18, 23, 0)
    const mondayBeforeBoundary = localTime(2026, 10, 19, 3, 59)
    const mondayBoundary = localTime(2026, 10, 19, 4, 0)
    expect(makeupWeekKey(sundayNight)).toBe('2026-10-12')
    expect(makeupWeekKey(mondayBeforeBoundary)).toBe('2026-10-12')
    expect(makeupWeekKey(mondayBoundary)).toBe('2026-10-19')
    // 同周内任意时刻周键不变
    expect(makeupWeekKey(localTime(2026, 10, 25, 23, 59))).toBe('2026-10-19')
  })

  it('makeupAvailable = clamp(granted − used, 0, 3)', () => {
    expect(makeupAvailable({ weekKey: '2026-10-19', granted: 0, used: 0 })).toBe(0)
    expect(makeupAvailable({ weekKey: '2026-10-19', granted: 1, used: 0 })).toBe(1)
    expect(makeupAvailable({ weekKey: '2026-10-19', granted: 3, used: 2 })).toBe(1)
    expect(makeupAvailable({ weekKey: '2026-10-19', granted: 5, used: 0 })).toBe(3)
    expect(makeupAvailable({ weekKey: '2026-10-19', granted: 1, used: 5 })).toBe(0)
    expect(makeupAvailable({ weekKey: '2026-10-19', granted: -1, used: 0 })).toBe(0)
  })

  it('isMakeupWindowDay 只允许 D−1/D−2，拒绝当天与未来', () => {
    const now = localTime(2026, 10, 19, 10, 0)
    expect(isMakeupWindowDay('2026-10-18', now)).toBe(true)
    expect(isMakeupWindowDay('2026-10-17', now)).toBe(true)
    expect(isMakeupWindowDay('2026-10-16', now)).toBe(false)
    expect(isMakeupWindowDay('2026-10-19', now)).toBe(false)
    expect(isMakeupWindowDay('2026-10-20', now)).toBe(false)
    // 04:00 前「今天」仍是前一业务日
    const beforeBoundary = localTime(2026, 10, 19, 3, 59)
    expect(isMakeupWindowDay('2026-10-17', beforeBoundary)).toBe(true)
    expect(isMakeupWindowDay('2026-10-18', beforeBoundary)).toBe(false)
  })
})

describe('默认设置 seed（A11/A12/A15）', () => {
  it('DND 23:00–07:00、计划 08:30/21:30、番茄默认关、引导未完成', () => {
    const settings = createDefaultSettings()
    expect(settings.dnd).toEqual({ enabled: true, start: '23:00', end: '07:00' })
    expect(settings.plan).toEqual({ enabled: true, morning: '08:30', review: '21:30' })
    expect(settings.pomodoro.enabled).toBe(false)
    expect(settings.pomodoro.focusMin).toBe(25)
    expect(settings.onboarded).toBe(false)
    expect(settings.autostart).toBe(false)
    expect(makeupAvailable(settings.makeup)).toBe(0)
  })

  it('每次返回全新对象（避免 main/renderer 共享可变状态）', () => {
    const first = createDefaultSettings()
    const second = createDefaultSettings()
    expect(first).not.toBe(second)
    first.dnd.start = '00:00'
    expect(second.dnd.start).toBe('23:00')
  })
})
