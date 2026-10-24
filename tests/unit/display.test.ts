/**
 * 窗口位置几何单测 · Agent-Main（0.4.2：拖拽可达屏幕底部）
 *
 * 口径：
 * - 移动/恢复使用 **display.bounds**（含任务栏区域），允许桌宠拖到屏幕最底部并覆盖任务栏，
 *   但至少整窗可见；默认落点仍用 workArea（避开任务栏）。
 * - 保存快照的 `workArea` 字段保持结构兼容，但 0.4.2 起存 display.bounds，
 *   这样“拖到底部”的位置能原样恢复（旧记录仍可读取，近似还原）。
 * - 不依赖真实 Electron screen：用注入的假 ScreenApi 覆盖多屏/负坐标/边界。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import type { Display, Rectangle } from 'electron'

import type { Rect, WindowPlacement } from '@shared/types'
import type { ScreenApi, Size } from '../../src/main/platform/display'
import {
  clampToDisplayArea,
  clampToDisplayBounds,
  clampToWorkArea,
  createWindowPlacement,
  defaultWindowPosition,
  restoreWindowPosition,
  setScreenApi,
} from '../../src/main/platform/display'

const WINDOW: Size = { width: 320, height: 400 }
const TASKBAR = 48

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height }
}

function makeDisplay(id: number, bounds: Rect, workArea: Rect = bounds, scaleFactor = 1): Display {
  return { id, bounds, workArea, scaleFactor } as unknown as Display
}

function intersectionArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (width <= 0 || height <= 0) return 0
  return width * height
}

function centerDistanceSq(point: { x: number; y: number }, display: Display): number {
  const centerX = display.bounds.x + display.bounds.width / 2
  const centerY = display.bounds.y + display.bounds.height / 2
  return (point.x - centerX) ** 2 + (point.y - centerY) ** 2
}

/** 最小假 screen：矩形匹配取交集最大，点匹配取包含点/中心最近的屏幕 */
function createFakeScreen(displays: readonly Display[], primary: Display): ScreenApi {
  return {
    getAllDisplays: () => [...displays],
    getPrimaryDisplay: () => primary,
    getDisplayMatching: (target: Rectangle) =>
      displays.reduce((best, display) =>
        intersectionArea(target, display.bounds) > intersectionArea(target, best.bounds)
          ? display
          : best,
      ),
    getDisplayNearestPoint: (point) => {
      const containing = displays.find(
        (display) =>
          point.x >= display.bounds.x &&
          point.x <= display.bounds.x + display.bounds.width &&
          point.y >= display.bounds.y &&
          point.y <= display.bounds.y + display.bounds.height,
      )
      if (containing !== undefined) return containing
      return displays.reduce((best, display) =>
        centerDistanceSq(point, display) < centerDistanceSq(point, best) ? display : best,
      )
    },
  }
}

// 主屏 1920×1080，下方 48 DIP 任务栏；二号屏在主屏左侧（负坐标）
const PRIMARY = makeDisplay(1, rect(0, 0, 1920, 1080), rect(0, 0, 1920, 1080 - TASKBAR))
const LEFT = makeDisplay(2, rect(-1280, 0, 1280, 1024), rect(-1280, 0, 1280, 1024))

beforeEach(() => {
  setScreenApi(createFakeScreen([PRIMARY, LEFT], PRIMARY))
})

describe('clampToDisplayBounds（纯函数）', () => {
  const bounds = rect(0, 0, 1920, 1080)

  it('可到达屏幕最底部与最右侧（整窗可见，含任务栏区域）', () => {
    expect(clampToDisplayBounds(WINDOW, { x: 200, y: 5000 }, bounds)).toEqual({
      x: 200,
      y: 1080 - WINDOW.height,
    })
    expect(clampToDisplayBounds(WINDOW, { x: 5000, y: 500 }, bounds)).toEqual({
      x: 1920 - WINDOW.width,
      y: 500,
    })
  })

  it('负坐标/左上越界会贴回屏幕左上角', () => {
    expect(clampToDisplayBounds(WINDOW, { x: -80, y: -120 }, bounds)).toEqual({ x: 0, y: 0 })
  })

  it('屏幕比窗口还小时贴左上（不会出现负坐标）', () => {
    const small = rect(100, 50, 200, 300)
    expect(clampToDisplayBounds(WINDOW, { x: 500, y: 500 }, small)).toEqual({ x: 100, y: 50 })
  })

  it('屏幕原点非 0 时按屏幕坐标钳制（多屏不越界）', () => {
    const leftBounds = rect(-1280, 0, 1280, 1024)
    expect(clampToDisplayBounds(WINDOW, { x: -5000, y: 5000 }, leftBounds)).toEqual({
      x: -1280,
      y: 1024 - WINDOW.height,
    })
  })
})

describe('clampToDisplayArea（拖拽使用 display.bounds）', () => {
  it('可以拖到主屏底部覆盖任务栏（y = display 底部 − 窗高），不再被 workArea 挡住', () => {
    const target = clampToDisplayArea(WINDOW, { x: 800, y: 5000 })
    expect(target).toEqual({ x: 800, y: 1080 - WINDOW.height })

    // 对照：旧 workArea 口径会被拉到任务栏上方
    const oldClamp = clampToWorkArea(WINDOW, { x: 800, y: 5000 })
    expect(oldClamp.y).toBe(1080 - TASKBAR - WINDOW.height)
    expect(target.y).toBeGreaterThan(oldClamp.y)
  })

  it('负坐标/左侧越界贴到所在屏幕左上', () => {
    expect(clampToDisplayArea(WINDOW, { x: -80, y: -120 })).toEqual({ x: 0, y: 0 })
  })

  it('多屏：窗口中心在左侧负坐标屏时钳制在该屏内，不跳到主屏', () => {
    // 目标 x=-5000 → 中心仍落在左屏附近 → 最近屏为 LEFT
    const target = clampToDisplayArea(WINDOW, { x: -5000, y: 5000 })
    expect(target).toEqual({ x: -1280, y: 1024 - WINDOW.height })
  })

  it('多屏：中心在主屏靠近边界时保持在主屏内（x≥0，不跨到左屏只露一半）', () => {
    const target = clampToDisplayArea(WINDOW, { x: -50, y: 500 })
    expect(target).toEqual({ x: 0, y: 500 })
  })
})

describe('保存/恢复位置（尽量保留底部）', () => {
  it('拖到主屏最底部后保存，恢复得到同样的底部位置', () => {
    const bottom = rect(1600, 1080 - WINDOW.height, WINDOW.width, WINDOW.height)
    const placement = createWindowPlacement(bottom)
    // 结构不变，但快照区域现在是 display.bounds（含任务栏）
    expect(placement.bounds).toEqual(bottom)
    expect(placement.workArea).toEqual(PRIMARY.bounds)
    expect(placement.rel.y).toBeCloseTo(bottom.y / PRIMARY.bounds.height)

    const restored = restoreWindowPosition(WINDOW, placement)
    expect(restored).toEqual({ x: bottom.x, y: bottom.y })
  })

  it('多屏（负坐标）底部位置也可恢复，且不越出该屏', () => {
    const bottom = rect(-1280 + 100, 1024 - WINDOW.height, WINDOW.width, WINDOW.height)
    const placement = createWindowPlacement(bottom)
    const restored = restoreWindowPosition(WINDOW, placement)
    expect(restored).toEqual({ x: bottom.x, y: bottom.y })
  })

  it('旧格式快照（workArea + rel 基于 workArea）仍可读取，且结果整窗在屏内', () => {
    const oldWorkArea = rect(0, 0, 1920, 1080 - TASKBAR)
    const oldPlacement = {
      bounds: rect(1576, 608, WINDOW.width, WINDOW.height),
      workArea: oldWorkArea,
      rel: {
        x: (1920 - WINDOW.width - 24) / 1920,
        y: (1080 - TASKBAR - WINDOW.height) / (1080 - TASKBAR),
      },
      scale: 1,
    }
    const restored = restoreWindowPosition(WINDOW, oldPlacement)
    expect(restored).not.toBeNull()
    if (restored === null) return
    expect(restored.x).toBeGreaterThanOrEqual(0)
    expect(restored.x).toBeLessThanOrEqual(1920 - WINDOW.width)
    expect(restored.y).toBeGreaterThanOrEqual(oldWorkArea.y + oldWorkArea.height - WINDOW.height)
    expect(restored.y).toBeLessThanOrEqual(1080 - WINDOW.height)
  })

  it('屏幕已不存在/快照非法时返回 null（调用方回落默认位置）', () => {
    expect(restoreWindowPosition(WINDOW, null as unknown as WindowPlacement)).toBeNull()
    const offscreen = {
      bounds: rect(9000, 9000, WINDOW.width, WINDOW.height),
      workArea: rect(9000, 9000, 1920, 1080),
      rel: { x: 0.5, y: 0.5 },
      scale: 1,
    }
    expect(restoreWindowPosition(WINDOW, offscreen)).toBeNull()
  })

  it('默认落点仍使用主屏 workArea（避开任务栏）', () => {
    expect(defaultWindowPosition(WINDOW)).toEqual({
      x: 1920 - WINDOW.width - 24,
      y: 1080 - TASKBAR - WINDOW.height - 24,
    })
  })
})
