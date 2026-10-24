/**
 * 台词库与选句算法（PLAN §5 互动 / 03 §7 角色状态机与台词库）
 *
 * - 唯一真源：assets/dialog/lines.zh.json（P0 只有 zh，en 进 P1）
 * - 纯函数、无 DOM/时间依赖，便于 Agent-QA 直接单测（02 §7.3）
 * - 选句顺序：按 state 过滤 → 按 slot 过滤 → 排除最近 2 条 → 按 weight 加权随机 → 兜底 `{state}.01`
 */
import type { SpriteState } from '@shared/types'

import rawLines from '../../../../assets/dialog/lines.zh.json'

/** 时段划分（03 §7）：morning 05–11 / day 11–18 / evening 18–23 / late 23–05 */
export const DIALOG_SLOTS = ['any', 'morning', 'day', 'evening', 'late'] as const
export type DialogSlot = (typeof DIALOG_SLOTS)[number]

/** v1 三状态（focus/remind/celebrate 台词保留在 JSON 中，normalizeLines 会按类型安全过滤掉） */
const SPRITE_STATES = ['idle', 'happy', 'sleepy'] as const

export interface DialogLine {
  /** 全局唯一，形如 `idle.01`；文案可改，id 不改（03 §7） */
  id: string
  state: SpriteState
  slot: DialogSlot
  /** 中文台词：≤24 字、单行、无占位符 */
  zh: string
  /** 1–10，越大越常出现 */
  weight: number
  tags?: string[]
}

/** 台词 JSON 的原始行（未校验，normalizeLines 负责补默认值与丢弃非法行） */
interface RawDialogLine {
  id: string
  state: string
  slot?: string
  zh: string
  weight?: number
  tags?: string[]
}

const MAX_LINE_LENGTH = 24
const DEFAULT_WEIGHT = 1
const RECENT_LIMIT = 2

function isSpriteState(value: string): value is SpriteState {
  return (SPRITE_STATES as readonly string[]).includes(value)
}

function isDialogSlot(value: string): value is DialogSlot {
  return (DIALOG_SLOTS as readonly string[]).includes(value)
}

function clampWeight(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_WEIGHT
  return Math.min(10, Math.max(1, Math.round(value)))
}

/**
 * 校验并补默认值：slot 缺省 any、weight 缺省 1；非法行直接丢弃。
 * 构建期还会由 Agent-QA 的校验脚本再检查一遍（02 §7.3），这里兜运行期安全。
 */
export function normalizeLines(raw: readonly RawDialogLine[]): DialogLine[] {
  const lines: DialogLine[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item.id !== 'string' || item.id.length === 0) continue
    if (typeof item.state !== 'string' || !isSpriteState(item.state)) continue
    if (typeof item.zh !== 'string' || item.zh.length === 0) continue
    if (item.zh.length > MAX_LINE_LENGTH) continue
    if (seen.has(item.id)) continue
    const line: DialogLine = {
      id: item.id,
      state: item.state,
      slot: item.slot !== undefined && isDialogSlot(item.slot) ? item.slot : 'any',
      zh: item.zh,
      weight: clampWeight(item.weight),
    }
    if (item.tags !== undefined && item.tags.length > 0) {
      line.tags = item.tags
    }
    lines.push(line)
    seen.add(line.id)
  }
  return lines
}

/** 模块加载时归一化一次；之后选句只读常量，不再分配 */
export const DIALOG_LINES: readonly DialogLine[] = normalizeLines(rawLines)

/** 当前小时 → 时段（03 §7；23:00–05:00 为 late） */
export function slotForHour(hour: number): DialogSlot {
  if (hour >= 5 && hour < 11) return 'morning'
  if (hour >= 11 && hour < 18) return 'day'
  if (hour >= 18 && hour < 23) return 'evening'
  return 'late'
}

function weightedPick(lines: readonly DialogLine[], rng: () => number): DialogLine | undefined {
  const total = lines.reduce((sum, line) => sum + line.weight, 0)
  if (total <= 0) return lines[0]
  let ticket = rng() * total
  for (const line of lines) {
    ticket -= line.weight
    if (ticket < 0) return line
  }
  return lines[lines.length - 1]
}

function fallbackLine(state: SpriteState): DialogLine {
  return { id: `${state}.fallback`, state, slot: 'any', zh: '我在这里陪着你。', weight: 1 }
}

/**
 * 选一句台词。
 *
 * @param state 目标精灵状态
 * @param slot 当前时段（`any` 表示不按时段过滤）
 * @param excludeRecentIds 最近展示过的 id（新的在前，默认排除最近 2 条）
 * @param rng 随机源（单测注入固定值；默认 Math.random）
 */
export function pickLine(
  state: SpriteState,
  slot: DialogSlot,
  excludeRecentIds: readonly string[] = [],
  rng: () => number = Math.random,
): DialogLine {
  const stateLines = DIALOG_LINES.filter((line) => line.state === state)
  const slotLines =
    slot === 'any'
      ? stateLines
      : stateLines.filter((line) => line.slot === 'any' || line.slot === slot)
  const recent = new Set(excludeRecentIds.slice(0, RECENT_LIMIT))
  const freshLines = slotLines.filter((line) => !recent.has(line.id))
  const pool = freshLines.length > 0 ? freshLines : slotLines.length > 0 ? slotLines : stateLines

  if (pool.length === 0) {
    const primary = stateLines.find((line) => line.id === `${state}.01`)
    return primary ?? stateLines[0] ?? fallbackLine(state)
  }

  const picked = weightedPick(pool, rng)
  const primary = stateLines.find((line) => line.id === `${state}.01`)
  return picked ?? primary ?? fallbackLine(state)
}
