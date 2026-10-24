/**
 * 多屏 / DPI 窗口位置（DIP）· Agent-Main
 *
 * 口径：PLAN §6「多屏持久化不依赖 display.id」、02-arch §2.2/§9。
 *
 * 设计说明：screen API 由 main 启动时注入（`setScreenApi(screen)`），本文件不在模块顶层
 * import electron 运行时；纯几何函数（clamp / 交集 / rel）因此可以在 Node 单测里用假
 * ScreenApi 覆盖（PLAN §7.3「DPI 钳制」）。M0 的持久化用 userData 下 JSON，M2 换成 DB 的
 * `pet_state.window_json` 时只需换掉 `PlacementStorage` 实现。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Display, Rectangle } from 'electron'

import type { Rect, WindowPlacement } from '@shared/types'

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** display.ts 需要的最小 screen 能力（便于注入假实现做单测） */
export interface ScreenApi {
  getAllDisplays(): Display[]
  getPrimaryDisplay(): Display
  getDisplayMatching(rect: Rectangle): Display
  /** 0.4.2：拖拽可覆盖任务栏，用目标窗口中心找最近屏幕再按 display.bounds 钳制 */
  getDisplayNearestPoint(point: Point): Display
}

/** 默认落点与屏幕边缘的留白（DIP） */
const DEFAULT_MARGIN_DIP = 24

/** 恢复位置时至少需要的可视交集边长（DIP）；小于它视为「屏幕已不存在」→ 默认位置 */
export const MIN_VISIBLE_DIP = 48

let screenApi: ScreenApi | null = null

/** main 启动时注入 Electron `screen`（index.ts 在 whenReady 之后调用） */
export function setScreenApi(api: ScreenApi): void {
  screenApi = api
}

function requireScreenApi(): ScreenApi {
  if (screenApi === null) {
    throw new Error('display.ts 尚未初始化：请先在 main 启动时调用 setScreenApi(screen)')
  }
  return screenApi
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 两个矩形的交集面积（无交集为 0；坐标均为 DIP） */
export function intersectionArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (width <= 0 || height <= 0) return 0
  return width * height
}

/** 矩形是否合法（有限数字、宽高非负） */
export function isRect(value: unknown): value is Rect {
  if (typeof value !== 'object' || value === null) return false
  const rect = value as Partial<Record<keyof Rect, unknown>>
  return [rect.x, rect.y, rect.width, rect.height].every(
    (item) => typeof item === 'number' && Number.isFinite(item),
  )
}

/** WindowPlacement 运行时校验（读 JSON / 接 DB 时防止脏数据把窗口扔到屏幕外） */
export function isWindowPlacement(value: unknown): value is WindowPlacement {
  if (typeof value !== 'object' || value === null) return false
  const placement = value as Partial<Record<keyof WindowPlacement, unknown>>
  if (!isRect(placement.bounds) || !isRect(placement.workArea)) return false
  if (typeof placement.rel !== 'object' || placement.rel === null) return false
  const rel = placement.rel as Partial<Record<keyof WindowPlacement['rel'], unknown>>
  if (typeof rel.x !== 'number' || !Number.isFinite(rel.x)) return false
  if (typeof rel.y !== 'number' || !Number.isFinite(rel.y)) return false
  return (
    typeof placement.scale === 'number' && Number.isFinite(placement.scale) && placement.scale > 0
  )
}

/** 把窗口坐标钳制到给定矩形内（纯函数，坐标 DIP；宽高不足时贴左上） */
export function clampToBounds(size: Size, saved: Point, workArea: Rect): Point {
  const maxX = workArea.x + Math.max(0, workArea.width - size.width)
  const maxY = workArea.y + Math.max(0, workArea.height - size.height)
  return {
    x: clampNumber(Math.round(saved.x), workArea.x, maxX),
    y: clampNumber(Math.round(saved.y), workArea.y, maxY),
  }
}

/**
 * 把窗口坐标钳制到 **display.bounds**（整个屏幕，含任务栏区域）。
 *
 * 0.4.2：用户确认桌宠可拖到屏幕最底部覆盖任务栏，但至少整窗可见；
 * 因此移动/恢复用 display.bounds 而不是排除任务栏的 workArea。
 */
export function clampToDisplayBounds(size: Size, saved: Point, displayBounds: Rect): Point {
  return clampToBounds(size, saved, displayBounds)
}

/** 把窗口坐标钳制到「目标点所在屏幕」的 workArea（默认落点/旧调用使用） */
export function clampToWorkArea(size: Size, saved: Point): Point {
  const workArea = requireScreenApi().getDisplayMatching({
    x: saved.x,
    y: saved.y,
    width: 1,
    height: 1,
  }).workArea
  return clampToBounds(size, saved, workArea)
}

/**
 * 把窗口坐标钳制到「窗口中心最近屏幕」的 display.bounds（拖拽使用）。
 * 窗口中心落在哪块屏幕，就整窗保留在那块屏幕内（含任务栏区域），不会跨屏只露一半。
 */
export function clampToDisplayArea(size: Size, saved: Point): Point {
  const center: Point = {
    x: saved.x + size.width / 2,
    y: saved.y + size.height / 2,
  }
  const displayBounds = requireScreenApi().getDisplayNearestPoint(center).bounds
  return clampToDisplayBounds(size, saved, displayBounds)
}

/** 窗口在 workArea 内的相对位置（0–1），分辨率/缩放变化后按比例还原 */
export function relativeWithin(bounds: Rect, workArea: Rect): Point {
  const x = workArea.width > 0 ? (bounds.x - workArea.x) / workArea.width : 0
  const y = workArea.height > 0 ? (bounds.y - workArea.y) / workArea.height : 0
  return { x: clampNumber(x, 0, 1), y: clampNumber(y, 0, 1) }
}

/**
 * 由窗口 bounds 生成持久化快照（不存 display.id，PLAN §6）。
 *
 * 0.4.2：`workArea` 字段（结构未变，兼容旧 JSON）改存 **display.bounds**（含任务栏），
 * `rel` 也相对它计算；这样拖到屏幕最底部/覆盖任务栏的位置可以原样恢复，
 * 不会被 workArea 拉回任务栏上方。旧记录仍能读取（按新口径近似还原）。
 */
export function createWindowPlacement(bounds: Rect): WindowPlacement {
  const display = requireScreenApi().getDisplayMatching(bounds)
  const displayBounds = display.bounds
  return {
    bounds: { ...bounds },
    workArea: { ...displayBounds },
    rel: relativeWithin(bounds, displayBounds),
    scale: display.scaleFactor,
  }
}

/** 默认落点：主屏 workArea 右下角（留白 24 DIP，避开任务栏） */
export function defaultWindowPosition(size: Size): Point {
  const workArea = requireScreenApi().getPrimaryDisplay().workArea
  return {
    x: workArea.x + workArea.width - size.width - DEFAULT_MARGIN_DIP,
    y: workArea.y + workArea.height - size.height - DEFAULT_MARGIN_DIP,
  }
}

function findBestDisplay(displays: readonly Display[], savedArea: Rect): Display | null {
  let best: Display | null = null
  let bestArea = 0
  for (const display of displays) {
    // 0.4.2：与 display.bounds 匹配（保存快照现在也基于 bounds，且含任务栏位置）
    const area = intersectionArea(savedArea, display.bounds)
    if (area > bestArea) {
      bestArea = area
      best = display
    }
  }
  // 交集太小 = 原屏幕已拔掉/布局变化，交给默认位置，避免窗口只露一条边
  const minimumArea = Math.min(
    savedArea.width * savedArea.height,
    MIN_VISIBLE_DIP * MIN_VISIBLE_DIP,
  )
  return bestArea >= minimumArea ? best : null
}

/**
 * 恢复窗口位置：用保存的区域与当前各屏 display.bounds 做矩形交集匹配，
 * 再按 rel 还原并钳制到 display.bounds（允许落在任务栏上方/屏幕底部，整窗可见）。
 * 返回 null 表示无法恢复（调用方使用 `defaultWindowPosition`）。
 */
export function restoreWindowPosition(size: Size, placement: WindowPlacement): Point | null {
  if (!isWindowPlacement(placement)) return null
  const displays = requireScreenApi().getAllDisplays()
  const matched = findBestDisplay(displays, placement.workArea)
  if (matched === null) return null
  const displayBounds = matched.bounds
  const wanted: Point = {
    x: displayBounds.x + placement.rel.x * displayBounds.width,
    y: displayBounds.y + placement.rel.y * displayBounds.height,
  }
  return clampToDisplayBounds(size, wanted, displayBounds)
}

// ---------------------------------------------------------------------------
// 持久化（M0：userData JSON；M2 换 DB，接口不变）
// ---------------------------------------------------------------------------

export interface PlacementStorage {
  read(): WindowPlacement | null
  write(placement: WindowPlacement): void
}

/** 读取并校验；损坏/缺失都回落 null（不抛，避免脏数据阻塞启动） */
export function loadWindowPlacement(storage: PlacementStorage): WindowPlacement | null {
  try {
    const value = storage.read()
    return isWindowPlacement(value) ? value : null
  } catch (error) {
    console.warn('[display] 读取窗口位置失败，使用默认位置', error)
    return null
  }
}

export function saveWindowPlacement(storage: PlacementStorage, placement: WindowPlacement): void {
  try {
    storage.write(placement)
  } catch (error) {
    console.warn('[display] 保存窗口位置失败（M0 允许，M2 接 DB 后由事务保证）', error)
  }
}

/** JSON 文件的 PlacementStorage（M0 临时实现；接口留给 M2 换 DB） */
export function createJsonPlacementStorage(filePath: string): PlacementStorage {
  return {
    read(): WindowPlacement | null {
      try {
        const raw = readFileSync(filePath, 'utf8')
        const parsed: unknown = JSON.parse(raw)
        return isWindowPlacement(parsed) ? parsed : null
      } catch {
        // 文件不存在或 JSON 损坏：M0 用默认位置即可
        return null
      }
    },
    write(placement: WindowPlacement): void {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, `${JSON.stringify(placement, null, 2)}\n`, 'utf8')
    },
  }
}
