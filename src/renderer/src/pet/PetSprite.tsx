/**
 * 精灵渲染（v1：3 态；docs/05 §2）
 *
 * - 按 spriteState 切图；图片加载失败时降级为纯 CSS 色块，保证界面不空
 * - 透明 WebP 关键帧 + 轻微 CSS 动效；减少动态效果时使用静态帧
 * - 素材：assets/sprites/whale-girl-v1/（480×480，显示为 240×240 DIP）
 */
import { useEffect, useLayoutEffect, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

import type { PetAction, SpriteState } from '@shared/types'
import { spriteFadeMs } from './actions'

import celebrateStill from '../../../../assets/sprites/whale-girl-actions-v1/celebrate.png'
import celebrateSprite from '../../../../assets/sprites/whale-girl-actions-v1/celebrate.webp'
import concernStill from '../../../../assets/sprites/whale-girl-actions-v1/concern.png'
import concernSprite from '../../../../assets/sprites/whale-girl-actions-v1/concern.webp'
import idleLookStill from '../../../../assets/sprites/whale-girl-actions-v1/idle-look.png'
import idleLookSprite from '../../../../assets/sprites/whale-girl-actions-v1/idle-look.webp'
import patStill from '../../../../assets/sprites/whale-girl-actions-v1/pat.png'
import patSprite from '../../../../assets/sprites/whale-girl-actions-v1/pat.webp'

import happyStill from '../../../../assets/sprites/whale-girl-v1/happy.png'
import happySprite from '../../../../assets/sprites/whale-girl-v1/happy.webp'
import idleStill from '../../../../assets/sprites/whale-girl-v1/idle.png'
import idleSprite from '../../../../assets/sprites/whale-girl-v1/idle.webp'
import sleepyStill from '../../../../assets/sprites/whale-girl-v1/sleepy.png'
import sleepySprite from '../../../../assets/sprites/whale-girl-v1/sleepy.webp'

/** v1 三状态 → 相同画布及脚底锚点的循环动画 */
const SPRITE_SOURCES: Record<SpriteState, string> = {
  idle: idleSprite,
  happy: happySprite,
  sleepy: sleepySprite,
}

const SPRITE_STILLS: Record<SpriteState, string> = {
  idle: idleStill,
  happy: happyStill,
  sleepy: sleepyStill,
}

const ACTION_SOURCES: Record<PetAction, string> = {
  pat: patSprite,
  celebrate: celebrateSprite,
  concern: concernSprite,
  'idle-look': idleLookSprite,
}

const ACTION_STILLS: Record<PetAction, string> = {
  pat: patStill,
  celebrate: celebrateStill,
  concern: concernStill,
  'idle-look': idleLookStill,
}

export interface PetSpriteProps {
  state: SpriteState
  action?: PetAction | null
  /** bootstrap 失败时压暗，提示 IPC 未就绪 */
  dimmed?: boolean
  onClick?: () => void
  /** 拖拽生命周期必须挂在按钮本身：pointer capture 放在父容器会劫持 click */
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerMove?: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerUp?: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerCancel?: (event: ReactPointerEvent<HTMLButtonElement>) => void
}

export default function PetSprite({
  state,
  action = null,
  dimmed = false,
  onClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: PetSpriteProps) {
  const [motionQuery] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)'))
  const [reducedMotion, setReducedMotion] = useState(() => motionQuery.matches)
  const [documentHidden, setDocumentHidden] = useState(() => document.hidden)
  const [nativeVisible, setNativeVisible] = useState(true)
  const [failedSource, setFailedSource] = useState<string | null>(null)

  useEffect(() => setFailedSource(null), [action])

  // WebP 不能用 CSS 暂停：隐藏时换静态首帧，显示后恢复；系统偏好变化同样即时换源。
  useEffect(() => {
    const onMotionChange = (): void => setReducedMotion(motionQuery.matches)
    const onVisibilityChange = (): void => setDocumentHidden(document.hidden)
    motionQuery.addEventListener('change', onMotionChange)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      motionQuery.removeEventListener('change', onMotionChange)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [motionQuery])

  // Electron 隐藏原生窗口时 Page Visibility 不一定变化，主进程的 show/hide 为补充事实源。
  useEffect(() => {
    const pet = window.pet
    if (!pet) return
    let cancelled = false
    let receivedVisibility = false
    const unsubscribe = pet.onEvent((event) => {
      if (event.type !== 'window-visibility') return
      receivedVisibility = true
      setNativeVisible(event.visible)
    })
    void pet
      .bootstrap()
      .then((bootstrap) => {
        if (!cancelled && !receivedVisibility) setNativeVisible(bootstrap.windowVisible)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const hidden = documentHidden || !nativeVisible
  const staticMode = reducedMotion || hidden
  const actionSource =
    action === null ? null : staticMode ? ACTION_STILLS[action] : ACTION_SOURCES[action]
  const baseSource = staticMode ? SPRITE_STILLS[state] : SPRITE_SOURCES[state]
  const source = actionSource !== null && failedSource !== actionSource ? actionSource : baseSource
  const [layers, setLayers] = useState<{
    current: string
    previous: string | null
    ready: boolean
    action: PetAction | null
    state: SpriteState
    fadeMs: number
  }>(() => ({ current: source, previous: null, ready: true, action, state, fadeMs: 0 }))

  useLayoutEffect(() => {
    if (source === layers.current) return
    const fadeMs = spriteFadeMs(layers.action, action, layers.state, state, staticMode)
    setLayers({
      current: source,
      previous: fadeMs > 0 ? layers.current : null,
      ready: fadeMs === 0,
      action,
      state,
      fadeMs,
    })
    // The displayed layer is captured only when the requested source changes.
  }, [source])

  useEffect(() => {
    if (layers.previous === null || !layers.ready) return
    const settle = window.setTimeout(() => {
      setLayers((value) =>
        value.current === layers.current ? { ...value, previous: null } : value,
      )
    }, layers.fadeMs)
    return () => window.clearTimeout(settle)
  }, [layers.current, layers.previous, layers.ready, layers.fadeMs])

  const className = ['pet-sprite', `pet-sprite--${state}`, dimmed ? 'pet-sprite--dimmed' : '']
    .filter((part) => part.length > 0)
    .join(' ')
  // 动画只作用于内部 body：按钮的 240×240 命中盒必须保持静止，
  // 否则 happy 动效把底边上移，边缘点击会落到父容器（docs/14）。
  return (
    <button
      type="button"
      className={className}
      data-action={action ?? ''}
      data-static={staticMode}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      aria-label="摸摸鲸鱼娘"
    >
      <span
        className="pet-sprite__body"
        data-animation-paused={staticMode || hidden}
        aria-hidden="true"
      >
        {failedSource === layers.current ? (
          <span className="pet-sprite__fallback" aria-hidden="true" />
        ) : (
          <span
            className="pet-sprite__visual"
            data-transitioning={layers.previous !== null}
            data-ready={layers.ready || staticMode}
            data-state={state}
            data-action={action ?? ''}
            data-animation-paused={staticMode}
          >
            {layers.previous !== null && !staticMode && (
              <img
                className="pet-sprite__outgoing"
                src={layers.previous}
                alt=""
                draggable={false}
              />
            )}
            <img
              key={layers.current}
              className="pet-sprite__image"
              data-ready={layers.ready || staticMode}
              src={layers.current}
              alt=""
              draggable={false}
              onLoad={() => {
                requestAnimationFrame(() =>
                  setLayers((value) =>
                    value.current === source ? { ...value, ready: true } : value,
                  ),
                )
                if (source === actionSource || actionSource === null) setFailedSource(null)
              }}
              onError={() => setFailedSource(layers.current)}
            />
          </span>
        )}
      </span>
    </button>
  )
}
