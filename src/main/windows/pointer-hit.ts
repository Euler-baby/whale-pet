/**
 * 指针命中 → 穿透切换（main 进程轮询）· Agent-Main
 *
 * 为什么用轮询而不是 renderer 的 forward mousemove：
 * - `setIgnoreMouseEvents(true,{forward:true})` 在旧版本 Windows 上不稳定（Electron #51521/#49982，
 *   44.9.0 预期已修但未在本机实测）；
 * - 轮询 `screen.getCursorScreenPoint()` 与命中矩形都不依赖窗口是否收到鼠标事件，
 *   在“窗口不可点（ignore=true）”时同样有效，是 v1 的确定性方案。
 *
 * 规则（docs/05 §2.1/§6）：
 * - 命中精灵矩形 / 气泡实际矩形（renderer 通过 IPC 上报，v1.2）→ ignore=false；
 * - 其余透明区域 → ignore=true（点击落到桌面）；
 * - 固定 +2 DIP 滞回带：进入/离开都用同一外扩矩形，静止在带内不会翻转；
 * - 拖拽期间（moveBy 活动后 300ms）强制 ignore=false，防止拖动中丢失 mouseup；
 * - `WHALE_PET_HIT_TRACE=1` 时逐 tick 输出 JSON 跟踪（宿主定位 99/100 采样差异用）。
 */
import { screen } from 'electron'
import type { BrowserWindow } from 'electron'

import { PET_HIT_RECTS, pointInRect } from '@shared/pet-layout'
import type { PetRect } from '@shared/pet-layout'

/** 轮询间隔：30Hz；只在窗口可见时运行 */
const POLL_INTERVAL_MS = 33
/** 进入命中区的外扩（DIP）；离开按精确区域，形成 2 DIP 滞回带 */
const HYSTERESIS_DIP = 2
/** moveBy 后保持可点击的宽限期，覆盖一次拖拽的 mouseup */
const DRAG_GRACE_MS = 300
/** 逐 tick 跟踪（仅诊断；默认关闭，避免日志噪声/性能影响） */
const TRACE = process.env['WHALE_PET_HIT_TRACE'] === '1'

let timer: ReturnType<typeof setInterval> | null = null
/** 气泡实际矩形（内容区 DIP）；null = 不可见 */
let bubbleRegion: PetRect | null = null
/** 兼容 1.1 的可见性通道：无矩形时用固定区域兜底 */
let legacyBubbleVisible = false
let draggingUntil = 0
let lastIgnore: boolean | null = null

function setIgnore(win: BrowserWindow, setter: (ignore: boolean) => void, ignore: boolean): void {
  if (win.isDestroyed()) return
  if (lastIgnore === ignore) return
  lastIgnore = ignore
  setter(ignore)
}

function poll(win: BrowserWindow, setter: (ignore: boolean) => void): void {
  if (win.isDestroyed() || !win.isVisible()) return

  // 拖拽中：保持可点击，避免窗口移动期间 ignore 切换导致丢事件
  if (Date.now() < draggingUntil) {
    setIgnore(win, setter, false)
    return
  }

  const cursor = screen.getCursorScreenPoint()
  const content = win.getContentBounds()
  const px = cursor.x - content.x
  const py = cursor.y - content.y

  // 单一外扩阈值（rect+2 DIP）：静态停在带内也只命中一次且保持，不会随状态来回翻转。
  // （docs/14：曾按 lastIgnore 切换 2/0，导致鼠标静止在 (39,120) 时逐 tick 交替。）
  const margin = HYSTERESIS_DIP
  const spriteHit = pointInRect(px, py, PET_HIT_RECTS.sprite, margin)
  const bubbleRect = bubbleRegion ?? (legacyBubbleVisible ? PET_HIT_RECTS.bubble : null)
  const bubbleHit = bubbleRect !== null && pointInRect(px, py, bubbleRect, margin)
  const ignore = !(spriteHit || bubbleHit)

  if (TRACE) {
    console.log(
      JSON.stringify({
        trace: 'hit',
        t: Date.now(),
        cursor,
        content,
        px,
        py,
        margin,
        spriteHit,
        bubbleHit,
        bubbleRegion,
        ignore,
      }),
    )
  }

  setIgnore(win, setter, ignore)
}

/** 创建/恢复轮询；重复调用会先停掉旧的（避免 dev 热重载叠加） */
export function startPointerHitTest(win: BrowserWindow, setter: (ignore: boolean) => void): void {
  stopPointerHitTest()
  lastIgnore = null
  timer = setInterval(() => poll(win, setter), POLL_INTERVAL_MS)
  timer.unref?.()
  poll(win, setter)
}

export function stopPointerHitTest(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  lastIgnore = null
}

/** 拖拽活动：通知轮询在宽限期内保持可点击（由 window:move-by 调用） */
export function noteDragActivity(): void {
  draggingUntil = Date.now() + DRAG_GRACE_MS
}

/**
 * 气泡实际矩形（v1.2）。renderer 用 getBoundingClientRect 上报；null = 隐藏。
 * 精确矩形避免“气泡可见时整块 300×140 吃掉透明区点击”。
 */
export function setBubbleRegion(rect: PetRect | null): void {
  bubbleRegion = rect
  if (rect !== null) legacyBubbleVisible = false
}

/** 兼容 1.1 的可见性通道（无矩形时用固定区域；新 renderer 不再调用） */
export function setBubbleVisible(visible: boolean): void {
  legacyBubbleVisible = visible
  if (visible) bubbleRegion = null
}
