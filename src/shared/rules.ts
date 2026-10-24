/**
 * 纯函数规则库（shared，main/renderer 共用；无副作用、无 IO）
 *
 * 口径唯一事实源：PLAN.md §5/§6。
 * 这些函数是契约的一部分：修改行为必须同步单测（tests/unit/rules.test.ts）并由 Lead 评审。
 */
import type {
  BubbleLevel,
  DayKey,
  DndSettings,
  LearningSettings,
  MakeupLedger,
  Timestamp,
} from './types'

// ---------------------------------------------------------------------------
// 常量（PLAN §5/§6）
// ---------------------------------------------------------------------------

/** 业务日固定 04:00（MVP 不可配，改动走 ADR） */
export const BUSINESS_DAY_START_HOUR = 4
export const BUSINESS_DAY_SHIFT_MS = BUSINESS_DAY_START_HOUR * 60 * 60 * 1000
export const MS_PER_DAY = 24 * 60 * 60 * 1000

/** 计划硬上限 3 项（UNIQUE(day_key, slot) 兜底） */
export const MAX_PLAN_SLOTS = 3
export const PLAN_TITLE_MAX = 40
export const PLAN_EST_MINUTES_MIN = 5
export const PLAN_EST_MINUTES_MAX = 180
export const CHECKIN_NOTE_MAX = 140

/** 每日亲密度上限（04:00 重置） */
export const DAILY_INTIMACY_LIMIT = 60

/** A11 补卡券：每周一 04:00 发 1，上限 3，仅可补 D−1/D−2 */
export const MAKEUP_TICKET_MAX = 3
export const MAKEUP_WINDOW_DAYS = 2

/** 数据：备份保留 7 份；event_log 保留 180 天；不建日/周汇总表 */
export const BACKUP_KEEP = 7
export const MIGRATION_BACKUP_KEEP = 3
export const EVENT_RETENTION_DAYS = 180

/** 系统时间改动 >5min 视为异常：只重算，不补发（PLAN §5） */
export const CLOCK_ANOMALY_THRESHOLD_MS = 5 * 60 * 1000

/** A3 休眠补偿：唤醒后静默 60s；迟到容忍 10min；10min–24h 合并 1 条；>24h skipped */
export const WAKE_SILENCE_MS = 60_000
export const GRACE_MS = 10 * 60 * 1000
export const LATE_MERGE_MAX_MS = 24 * 60 * 60 * 1000
/** tick 发现 now-lastTick > 90s 视为唤醒兜底（PLAN §5 / 02 §4.2） */
export const TICK_GAP_MS = 90_000

/** 气泡停留：L1 3s 无音 / L2 8s 有音 / L3 直到确认（60s 降级 L2） */
export const BUBBLE_DURATION_MS: Readonly<Record<BubbleLevel, number | null>> = {
  1: 3_000,
  2: 8_000,
  3: null,
}
export const L3_DOWNGRADE_MS = 60_000

/** 等级阈值（累计亲密度）；Lv1..Lv10（03 §3） */
export const INTIMACY_LEVEL_THRESHOLDS: readonly number[] = [
  0, 100, 300, 700, 1500, 3000, 6000, 12000, 24000, 48000,
]

/** 称号阈值（real_days，补卡不计）；03 §3 */
export const TITLE_THRESHOLDS: readonly { days: number; title: string }[] = [
  { days: 0, title: '初遇' },
  { days: 7, title: '七日鲸友' },
  { days: 30, title: '月度同行者' },
  { days: 100, title: '百日守鲸人' },
  { days: 365, title: '鲸落星河' },
]

// ---------------------------------------------------------------------------
// 业务日 day_key
// ---------------------------------------------------------------------------

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 用本地时区把 Date 格式化为 day_key（不应用业务日偏移） */
export function formatDayKey(date: Date): DayKey {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export interface ParsedDayKey {
  year: number
  month: number
  day: number
}

/** 严格解析 `YYYY-MM-DD`；非法日期（含 2026-02-30）返回 null */
export function parseDayKey(dayKey: DayKey): ParsedDayKey | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const probe = new Date(year, month - 1, day)
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
    return null
  }
  return { year, month, day }
}

function requireParsed(dayKey: DayKey): ParsedDayKey {
  const parsed = parseDayKey(dayKey)
  if (!parsed) throw new Error(`非法 day_key: ${dayKey}`)
  return parsed
}

/** `day_key = (本地时间 − 4h) 的日期`（PLAN §5） */
export function dayKeyOf(now: Timestamp): DayKey {
  return formatDayKey(new Date(now - BUSINESS_DAY_SHIFT_MS))
}

/** 业务日开始时刻（本地 04:00） */
export function dayKeyStart(dayKey: DayKey): Timestamp {
  const { year, month, day } = requireParsed(dayKey)
  return new Date(year, month - 1, day, BUSINESS_DAY_START_HOUR, 0, 0, 0).getTime()
}

/** 业务日结束时刻 = 次日 04:00（左闭右开） */
export function dayKeyEnd(dayKey: DayKey): Timestamp {
  return dayKeyStart(addDays(dayKey, 1))
}

/** 业务日加减天数（按日历日，不受 04:00 偏移影响） */
export function addDays(dayKey: DayKey, delta: number): DayKey {
  const { year, month, day } = requireParsed(dayKey)
  return formatDayKey(new Date(year, month - 1, day + delta))
}

/** `to − from` 的日历天数（用 UTC 归一化，避免 DST 影响） */
export function daysBetween(from: DayKey, to: DayKey): number {
  const a = requireParsed(from)
  const b = requireParsed(to)
  const fromUtc = Date.UTC(a.year, a.month - 1, a.day)
  const toUtc = Date.UTC(b.year, b.month - 1, b.day)
  return Math.round((toUtc - fromUtc) / MS_PER_DAY)
}

/** day_key 是否晚于「现在」所在业务日（用于拒绝未来日期打卡/计划） */
export function isFutureDayKey(dayKey: DayKey, now: Timestamp): boolean {
  return daysBetween(dayKeyOf(now), dayKey) > 0
}

// ---------------------------------------------------------------------------
// 成长：等级 / 称号 / 每日上限
// ---------------------------------------------------------------------------

/** 等级由累计亲密度派生（Lv1–Lv10），不存 exp */
export function intimacyToLevel(intimacy: number): number {
  const value = Math.max(0, intimacy)
  let level = 1
  for (let index = 0; index < INTIMACY_LEVEL_THRESHOLDS.length; index += 1) {
    const threshold = INTIMACY_LEVEL_THRESHOLDS[index] ?? 0
    if (value >= threshold) level = index + 1
  }
  return level
}

/** 某等级所需的最低累计亲密度（Lv1..Lv10；越界 1..10 钳制） */
export function intimacyForLevel(level: number): number {
  const clamped = Math.min(Math.max(Math.trunc(level), 1), INTIMACY_LEVEL_THRESHOLDS.length)
  return INTIMACY_LEVEL_THRESHOLDS[clamped - 1] ?? 0
}

/** 称号由真实打卡天数推导（缓存到 pet_state.title） */
export function titleForRealDays(realDays: number): string {
  const days = Math.max(0, realDays)
  let title = TITLE_THRESHOLDS[0]?.title ?? '初遇'
  for (const item of TITLE_THRESHOLDS) {
    if (days >= item.days) title = item.title
  }
  return title
}

/** 当日还可获得的亲密度（每日上限 60，04:00 重置；超出只反馈不入账） */
export function clampDailyIntimacyGain(gained: number, usedToday: number): number {
  if (gained <= 0) return 0
  const remaining = Math.max(0, DAILY_INTIMACY_LIMIT - Math.max(0, usedToday))
  return Math.min(gained, remaining)
}

// ---------------------------------------------------------------------------
// 免打扰（DND）与时间解析
// ---------------------------------------------------------------------------

/** `HH:mm` → 当日秒数；非法返回 null */
export function parseHhMmSeconds(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  if (!match) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60
}

/** 校验 `HH:mm` */
export function isValidHhMm(value: string): boolean {
  return parseHhMmSeconds(value) !== null
}

function secondsOfDay(ts: Timestamp): number {
  const date = new Date(ts)
  return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds()
}

function localAtSeconds(ts: Timestamp, dayOffset: number, seconds: number): Timestamp {
  const date = new Date(ts)
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + dayOffset,
    Math.floor(seconds / 3600),
    Math.floor((seconds % 3600) / 60),
    seconds % 60,
    0,
  ).getTime()
}

/**
 * 免打扰是否生效。
 * 支持跨零点（如 23:00–07:00）；`start === end` 视为不生效（0 长度）。
 */
export function isDndActive(now: Timestamp, dnd: DndSettings): boolean {
  if (!dnd.enabled) return false
  const start = parseHhMmSeconds(dnd.start)
  const end = parseHhMmSeconds(dnd.end)
  if (start === null || end === null || start === end) return false
  const current = secondsOfDay(now)
  return start < end ? current >= start && current < end : current >= start || current < end
}

/** 本次免打扰结束时刻；未生效返回 null（用于 renderer 展示「静音至 …」） */
export function dndUntil(now: Timestamp, dnd: DndSettings): Timestamp | null {
  if (!isDndActive(now, dnd)) return null
  const start = parseHhMmSeconds(dnd.start)
  const end = parseHhMmSeconds(dnd.end)
  if (start === null || end === null) return null
  const current = secondsOfDay(now)
  if (start < end) return localAtSeconds(now, 0, end)
  // 跨零点：00:00–end 属于前一天的窗口，结束在今天；start–24:00 结束在明天
  return current >= start ? localAtSeconds(now, 1, end) : localAtSeconds(now, 0, end)
}

// ---------------------------------------------------------------------------
// A11 补卡券账本（自然周 = 周一 04:00 起算）
// ---------------------------------------------------------------------------

/** 自然周键：该业务日所在周的周一日期（04:00 偏移已应用） */
export function makeupWeekKey(now: Timestamp): DayKey {
  const businessDate = new Date(now - BUSINESS_DAY_SHIFT_MS)
  const isoWeekday = (businessDate.getDay() + 6) % 7 // 周一=0
  const monday = new Date(
    businessDate.getFullYear(),
    businessDate.getMonth(),
    businessDate.getDate() - isoWeekday,
  )
  return formatDayKey(monday)
}

/** 可用补卡券 = granted − used（0..MAKEUP_TICKET_MAX） */
export function makeupAvailable(ledger: MakeupLedger): number {
  const available = Math.trunc(ledger.granted) - Math.trunc(ledger.used)
  return Math.min(Math.max(available, 0), MAKEUP_TICKET_MAX)
}

/** 补卡是否仍在允许窗口（D−1 / D−2） */
export function isMakeupWindowDay(targetDayKey: DayKey, now: Timestamp): boolean {
  const delta = daysBetween(targetDayKey, dayKeyOf(now))
  return delta >= 1 && delta <= MAKEUP_WINDOW_DAYS
}

// ---------------------------------------------------------------------------
// 默认设置（P2 学习闭环 seed；v1 使用 shared/settings 的 v1 默认值）
// ---------------------------------------------------------------------------

/** P2 默认设置（每次返回全新对象，避免共享可变状态） */
export function createDefaultSettings(): LearningSettings {
  return {
    onboarded: false,
    autostart: false,
    dnd: { enabled: true, start: '23:00', end: '07:00' },
    notify: { enabled: true, volume: 60, soundEnabled: true, toastEnabled: true },
    plan: { enabled: true, morning: '08:30', review: '21:30' },
    pomodoro: {
      enabled: false,
      focusMin: 25,
      breakMin: 5,
      longBreakMin: 15,
      roundsBeforeLongBreak: 4,
    },
    makeup: { weekKey: '1970-01-01', granted: 0, used: 0 },
  }
}
