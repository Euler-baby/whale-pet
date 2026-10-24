/**
 * v1 窗口布局与命中区域（DIP，内容区坐标）· Lead 维护
 *
 * 判定口径（docs/05 §2.1）：
 * - **内容区**（content）固定 320×400 DIP，是精灵/气泡/命中矩形的坐标系；
 * - 外框（outer bounds）允许因 DWM/边框出现 ≤1 DIP 差异，最终目标通过
 *   `useContentSize + hasShadow:false + thickFrame:false` 收敛到 0；
 * - 物理像素 = round(DIP × scale)，不作为尺寸验收标准。
 *
 * 布局与 `src/renderer/src/styles/global.css` 对应：
 * - `.app { padding-top: 4px; flex-direction: column; align-items: center }`
 * - `.pet-area { width/height: 240 }` → x=(320−240)/2=40, y=4
 * - `.bubble-area { width 300, height 140 }` → x=10, y=4+240=244
 */
export const PET_WINDOW_SIZE = { width: 320, height: 400 } as const

export interface PetRect {
  x: number
  y: number
  width: number
  height: number
}

/** 相对内容区左上角的命中矩形（DIP） */
export const PET_HIT_RECTS = {
  sprite: { x: 40, y: 4, width: 240, height: 240 },
  /** 气泡可见时生效；点击关闭气泡，8s 后自动消失 */
  bubble: { x: 10, y: 244, width: 300, height: 140 },
} as const satisfies Record<'sprite' | 'bubble', PetRect>

/** 点是否在矩形内（margin 为四边扩展量，用于滞回） */
export function pointInRect(px: number, py: number, rect: PetRect, margin = 0): boolean {
  return (
    px >= rect.x - margin &&
    px <= rect.x + rect.width + margin &&
    py >= rect.y - margin &&
    py <= rect.y + rect.height + margin
  )
}
