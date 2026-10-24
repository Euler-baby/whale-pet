/**
 * 桌宠主界面（v1：窗口壳 + 3 态 + 本地台词）
 *
 * 口径（docs/05 §2）：
 * - 启动 `await window.pet.bootstrap()`：成功渲染精灵 + 一句基础态台词；失败显示错误条
 * - 点击精灵：本地选一句 happy 台词 + 3s 后回基础态（不经过 IPC，v1 无互动数值）
 * - 右键 → main 弹菜单（显示/隐藏、重置位置、退出）
 * - 拖拽/命中切换在阶段 1 接入（见 docs/05 §6）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'

import type {
  Bootstrap,
  HudScope,
  PetAction,
  PetEvent,
  SpriteState,
  UrgentTasksState,
} from '@shared/types'

import Bubble from './bubble/Bubble'
import HudCard from './hud/HudCard'
import PetSprite from './pet/PetSprite'
import { ACTION_DURATION_MS, hasNewUrgent, selectAction } from './pet/actions'
import { pickLine, slotForHour } from './pet/lines'

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; bootstrap: Bootstrap }
  | { phase: 'error'; message: string }

/** 拖拽生命周期（v1 #7）：pointerdown 记录起点，位移 >4 DIP 判拖拽 */
interface DragState {
  pointerId: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  dragging: boolean
}

/** 深夜→sleepy，其余→idle（v1 只做时段基础态，不做 30min 空闲判定） */
function baseStateForHour(hour: number): SpriteState {
  return hour >= 23 || hour < 7 ? 'sleepy' : 'idle'
}

/**
 * bootstrap 单例：StrictMode 开发模式会把 effect 跑两次，
 * 用模块级 promise 去重，避免握手两次。
 */
let bootstrapOnce: Promise<Bootstrap> | null = null

function loadBootstrap(): Promise<Bootstrap> {
  const pet = window.pet
  if (!pet) {
    return Promise.reject(new Error('window.pet 未注入（preload 尚未就绪）'))
  }
  bootstrapOnce ??= pet.bootstrap()
  return bootstrapOnce
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** HUD 空态（契约 1.9：bootstrap.urgentTasks 恒存在；这里只作渲染兜底） */
const EMPTY_URGENT_TASKS: UrgentTasksState = { tasks: [], total: 0, queued: 0 }

/** 普通台词/本地提示气泡默认 8s；任务提醒缺省兜底 12s（0.4.2，main 通过 durationMs 下发） */
const NORMAL_BUBBLE_DURATION_MS = 8_000
const REMINDER_BUBBLE_DURATION_MS = 12_000

/**
 * 气泡自动消失时长（毫秒；null = 直到用户关闭）。
 * - main 下发的正数 durationMs 优先（0.4.2 任务提醒为 12s）
 * - 契约 null 表示不自动消失
 * - 缺失/非法值按气泡类型兜底（提醒 12s、普通 8s）
 */
function resolveBubbleDuration(
  durationMs: number | null | undefined,
  isReminder: boolean,
): number | null {
  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0) {
    return Math.round(durationMs)
  }
  if (durationMs === null) return null
  return isReminder ? REMINDER_BUBBLE_DURATION_MS : NORMAL_BUBBLE_DURATION_MS
}

export default function App() {
  const [load, setLoad] = useState<LoadState>({ phase: 'loading' })
  const [spriteState, setSpriteState] = useState<SpriteState>('idle')
  const [petAction, setPetAction] = useState<PetAction | null>(null)
  const [bubbleText, setBubbleText] = useState<string | null>(null)
  const [bubbleAction, setBubbleAction] = useState<'open-tasks' | undefined>()
  /** 当前气泡自动消失时长；由 main 事件的 durationMs 决定（提醒 12s / 普通 8s） */
  const [bubbleDurationMs, setBubbleDurationMs] = useState<number | null>(NORMAL_BUBBLE_DURATION_MS)
  const [bubbleRevision, setBubbleRevision] = useState(0)
  // 0.3.2 HUD：main 计算紧急任务集合/总数/排队角标，renderer 只展示
  const [urgentTasks, setUrgentTasks] = useState<UrgentTasksState>(EMPTY_URGENT_TASKS)
  const [hudScope, setHudScope] = useState<HudScope>('urgent')
  const [now, setNow] = useState(() => Date.now())
  const hudActive = urgentTasks.tasks.length > 0
  // 交互卡片优先级：带 action 的任务提醒/汇总气泡 > HUD > 普通气泡
  // HUD 活跃时只抑制无 action 的普通气泡/问候；任务汇总（action='open-tasks'）必须显示
  const actionBubbleVisible = bubbleText !== null && bubbleAction === 'open-tasks'
  const cardKind: 'hud' | 'bubble' | null = actionBubbleVisible
    ? 'bubble'
    : hudActive
      ? 'hud'
      : bubbleText !== null
        ? 'bubble'
        : null
  const hudActiveRef = useRef(false)
  hudActiveRef.current = hudActive
  const bubbleActionRef = useRef<'open-tasks' | undefined>(undefined)
  bubbleActionRef.current = bubbleAction
  const previousHudActive = useRef(false)
  const recentLines = useRef<string[]>([])
  const happyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const actionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const actionRef = useRef<PetAction | null>(null)
  const patTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const urgentRef = useRef<UrgentTasksState>(EMPTY_URGENT_TASKS)
  const nativeVisibleRef = useRef(true)
  const dragState = useRef<DragState | null>(null)
  const suppressClick = useRef(false)

  // 启动握手：成功 → 精灵 + 一句基础态台词；失败 → 错误条（不阻塞点击精灵）
  useEffect(() => {
    let cancelled = false
    loadBootstrap()
      .then((bootstrap) => {
        if (cancelled) return
        setLoad({ phase: 'ready', bootstrap })
        const urgent = bootstrap.urgentTasks ?? EMPTY_URGENT_TASKS
        urgentRef.current = urgent
        nativeVisibleRef.current = bootstrap.windowVisible
        setUrgentTasks(urgent)
        setHudScope(bootstrap.settings.hudScope ?? 'urgent')
        const hour = new Date().getHours()
        const base = baseStateForHour(hour)
        setSpriteState(base)
        // HUD 活跃时抑制启动问候（普通气泡也在 handleEvent 里抑制）
        if (urgent.tasks.length === 0) {
          const line = pickLine(base, slotForHour(hour), recentLines.current)
          recentLines.current = [line.id, ...recentLines.current].slice(0, 2)
          setBubbleText(line.zh)
          setBubbleDurationMs(NORMAL_BUBBLE_DURATION_MS)
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoad({ phase: 'error', message: describeError(error) })
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 清理点击后的回落定时器
  useEffect(
    () => () => {
      if (happyTimer.current !== null) clearTimeout(happyTimer.current)
      if (actionTimer.current !== null) clearTimeout(actionTimer.current)
      if (patTimer.current !== null) clearTimeout(patTimer.current)
    },
    [],
  )

  // HUD 倒计时每 30s 刷新（与任务面板轮询同粒度）
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  // HUD 活跃时只清理遗留的普通气泡；任务提醒/汇总（action='open-tasks'）保留并照常显示
  useEffect(() => {
    if (!hudActive) return
    if (bubbleActionRef.current === 'open-tasks') return
    setBubbleText(null)
    setBubbleAction(undefined)
  }, [hudActive])

  // HUD 清空后恢复普通问候（若已显示任务汇总气泡则不覆盖，等它自然消失/关闭）
  useEffect(() => {
    if (previousHudActive.current && !hudActive && bubbleActionRef.current !== 'open-tasks') {
      const hour = new Date().getHours()
      const base = baseStateForHour(hour)
      const line = pickLine(base, slotForHour(hour), recentLines.current)
      recentLines.current = [line.id, ...recentLines.current].slice(0, 2)
      setBubbleText(line.zh)
      setBubbleAction(undefined)
      setBubbleDurationMs(NORMAL_BUBBLE_DURATION_MS)
      setBubbleRevision((revision) => revision + 1)
    }
    previousHudActive.current = hudActive
  }, [hudActive])

  const showHappy = useCallback(() => {
    setSpriteState('happy')
    if (happyTimer.current !== null) clearTimeout(happyTimer.current)
    happyTimer.current = setTimeout(() => {
      happyTimer.current = null
      setSpriteState(baseStateForHour(new Date().getHours()))
    }, 3000)
  }, [])

  const playAction = useCallback((incoming: PetAction) => {
    const selected = selectAction(actionRef.current, incoming)
    if (selected === null || selected === actionRef.current) return
    actionRef.current = selected
    setPetAction(selected)
    if (happyTimer.current !== null) clearTimeout(happyTimer.current)
    happyTimer.current = null
    if (actionTimer.current !== null) clearTimeout(actionTimer.current)
    actionTimer.current = setTimeout(() => {
      actionRef.current = null
      setPetAction(null)
      setSpriteState(baseStateForHour(new Date().getHours()))
      actionTimer.current = null
    }, ACTION_DURATION_MS[selected])
  }, [])

  // A quiet occasional glance while visible and truly idle.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden || !nativeVisibleRef.current || actionRef.current !== null) return
      if (baseStateForHour(new Date().getHours()) !== 'idle') return
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      if (Math.random() < 0.3) playAction('idle-look')
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [playAction])

  // 常驻跨时段或从隐藏恢复时，按当前时刻更新基础态，不打断短暂开心反馈。
  useEffect(() => {
    const refresh = (): void => {
      if (happyTimer.current === null) setSpriteState(baseStateForHour(new Date().getHours()))
    }
    const timer = setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  // 交互卡片（带 action 气泡优先，其次 HUD，最后普通气泡）实际矩形 → main 命中区域（docs/13 时序）
  useEffect(() => {
    const pet = window.pet
    if (!pet) return
    const selector = cardKind === 'hud' ? '.hud' : cardKind === 'bubble' ? '.bubble' : null
    if (selector === null) {
      void pet.setBubbleRegion(null)
      return
    }
    // 气泡按事件 durationMs 自动消失（提醒 12s / 普通 8s；null = 直到用户关闭）；
    // HUD 常驻不自动消失（排队由 main 负责）
    const dismissTimer =
      cardKind === 'bubble' && bubbleDurationMs !== null
        ? window.setTimeout(() => {
            setBubbleText(null)
            setBubbleAction(undefined)
          }, bubbleDurationMs)
        : null
    let detach = (): void => undefined
    // 等 React 提交后的下一帧再量：卡片从无到有/内容变化时节点刚更新
    const frame = requestAnimationFrame(() => {
      const element = document.querySelector<HTMLElement>(selector)
      if (element === null) {
        void pet.setBubbleRegion(null)
        return
      }
      const send = (): void => {
        const rect = element.getBoundingClientRect()
        void pet
          .setBubbleRegion({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
          .catch((error: unknown) => console.warn('[hud-region] 上报失败:', error))
      }
      send()
      // 出现/脉冲动画用 transform 缩放，ResizeObserver 不触发；animationend + 延时各补一次最终矩形
      const onAnimationEnd = (): void => send()
      element.addEventListener('animationend', onAnimationEnd)
      const settleTimers = [window.setTimeout(send, 200), window.setTimeout(send, 600)]
      const observer = new ResizeObserver(send)
      observer.observe(element)
      detach = (): void => {
        element.removeEventListener('animationend', onAnimationEnd)
        for (const timer of settleTimers) window.clearTimeout(timer)
        observer.disconnect()
      }
    })
    return () => {
      cancelAnimationFrame(frame)
      detach()
      if (dismissTimer !== null) window.clearTimeout(dismissTimer)
      void pet.setBubbleRegion(null)
    }
  }, [cardKind, urgentTasks, bubbleText, bubbleAction, bubbleDurationMs, bubbleRevision])

  // main → renderer 唯一事件通道（v1 无调度器，事件目前只可能来自后续阶段）
  const handleEvent = useCallback(
    (event: PetEvent) => {
      switch (event.type) {
        case 'bubble':
          // HUD 活跃时只抑制无 action 的普通气泡/问候；任务提醒/汇总（action='open-tasks'）照常显示
          if (hudActiveRef.current && event.bubble.action === undefined) break
          // 0.4.2：自动消失时长以 main 下发为准（任务提醒 12s），不再在 renderer 硬编码 8s
          setBubbleDurationMs(
            resolveBubbleDuration(event.bubble.durationMs, event.bubble.action === 'open-tasks'),
          )
          setBubbleText(event.bubble.text)
          setBubbleAction(event.bubble.action)
          setBubbleRevision((revision) => revision + 1)
          break
        case 'bubble-dismiss':
          // 关闭不受 HUD 影响：HUD 活跃时显示过的任务汇总气泡也要能关掉
          setBubbleText(null)
          setBubbleAction(undefined)
          break
        case 'tasks-urgent':
          if (hasNewUrgent(urgentRef.current, event.urgentTasks)) playAction('concern')
          urgentRef.current = event.urgentTasks
          setUrgentTasks(event.urgentTasks)
          // 立即刷新倒计时时刻，避免等下个 30s tick
          setNow(Date.now())
          break
        case 'pet-action':
          playAction(event.action)
          break
        case 'pet-state':
          if (event.spriteState === 'happy') showHappy()
          else {
            if (happyTimer.current !== null) clearTimeout(happyTimer.current)
            happyTimer.current = null
            setSpriteState(event.spriteState)
          }
          break
        case 'window-visibility':
          nativeVisibleRef.current = event.visible
          if (event.visible && happyTimer.current === null)
            setSpriteState(baseStateForHour(new Date().getHours()))
          break
        case 'settings':
          // 设置页改 hudScope 后 main 广播；HUD 范围由 main 重算并推送 tasks-urgent
          setHudScope(event.settings.hudScope ?? 'urgent')
          break
      }
    },
    [playAction, showHappy],
  )

  useEffect(() => {
    const pet = window.pet
    if (!pet) return
    return pet.onEvent(handleEvent)
  }, [handleEvent])

  const handleSpriteClick = useCallback(() => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    showHappy()
    // HUD 活跃时抑制普通台词气泡（摸头仍走 happy 动效）
    if (hudActiveRef.current) return
    const line = pickLine('happy', slotForHour(new Date().getHours()), recentLines.current)
    recentLines.current = [line.id, ...recentLines.current].slice(0, 2)
    setBubbleText(line.zh)
    setBubbleAction(undefined)
    setBubbleDurationMs(NORMAL_BUBBLE_DURATION_MS)
    setBubbleRevision((revision) => revision + 1)
  }, [showHappy])

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return
      // 必须捕获在按钮本身：父容器 capture 会让后续 click 落在父容器，按钮 onClick 不执行
      event.currentTarget.setPointerCapture(event.pointerId)
      dragState.current = {
        pointerId: event.pointerId,
        startX: event.screenX,
        startY: event.screenY,
        lastX: event.screenX,
        lastY: event.screenY,
        dragging: false,
      }
      const pointerId = event.pointerId
      if (patTimer.current !== null) clearTimeout(patTimer.current)
      patTimer.current = setTimeout(() => {
        if (dragState.current?.pointerId !== pointerId || dragState.current.dragging) return
        suppressClick.current = true
        playAction('pat')
      }, 450)
    },
    [playAction],
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const state = dragState.current
      if (state === null || state.pointerId !== event.pointerId) return
      const total = Math.hypot(event.screenX - state.startX, event.screenY - state.startY)
      // 4 DIP 阈值区分拖拽与点击（docs/05 §3 #7）
      if (!state.dragging && total > 4) {
        state.dragging = true
        if (patTimer.current !== null) clearTimeout(patTimer.current)
        patTimer.current = null
      }
      if (!state.dragging) return
      const dx = event.screenX - state.lastX
      const dy = event.screenY - state.lastY
      state.lastX = event.screenX
      state.lastY = event.screenY
      if (dx !== 0 || dy !== 0) {
        window.pet?.moveBy(dx, dy).catch(() => undefined)
      }
    },
    [playAction],
  )

  const endDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = dragState.current
    if (state === null || state.pointerId !== event.pointerId) return
    dragState.current = null
    if (patTimer.current !== null) clearTimeout(patTimer.current)
    patTimer.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    // 拖拽结束时浏览器仍会派发 click；这里抑制，避免拖动误触发“摸头”
    if (state.dragging) suppressClick.current = true
  }, [])

  const handleContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    window.pet?.showContextMenu().catch(() => undefined)
  }, [])

  const closeBubble = useCallback(() => {
    setBubbleText(null)
    setBubbleAction(undefined)
  }, [])
  const openTasks = useCallback(() => {
    void window.pet
      ?.openTasks()
      .then(() => {
        setBubbleText(null)
        setBubbleAction(undefined)
      })
      .catch((error: unknown) => {
        setBubbleText(`打开任务清单失败：${describeError(error)}`)
        setBubbleAction(undefined)
        setBubbleDurationMs(NORMAL_BUBBLE_DURATION_MS)
        setBubbleRevision((revision) => revision + 1)
      })
  }, [])

  /** HUD 的「打开」按钮：失败只记日志（HUD 活跃时普通气泡被抑制，不弹错误气泡） */
  const openTasksFromHud = useCallback(() => {
    void window.pet?.openTasks().catch((error: unknown) => {
      console.warn('[hud] 打开任务清单失败:', error)
    })
  }, [])

  return (
    <div className="app" onContextMenu={handleContextMenu}>
      {load.phase === 'error' ? (
        <div className="error-bar" role="alert">
          IPC 尚未就绪：{load.message}
        </div>
      ) : null}
      <div className="pet-area">
        <PetSprite
          state={spriteState}
          action={petAction}
          dimmed={load.phase === 'error'}
          onClick={handleSpriteClick}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      </div>
      <div className="bubble-area">
        {cardKind === 'hud' ? (
          <HudCard
            state={urgentTasks}
            hudScope={hudScope}
            now={now}
            onOpenTasks={openTasksFromHud}
          />
        ) : cardKind === 'bubble' && bubbleText !== null ? (
          <Bubble
            key={bubbleRevision}
            text={bubbleText}
            variant={
              bubbleAction === 'open-tasks' ? 'reminder' : load.phase === 'error' ? 'error' : 'line'
            }
            onClose={closeBubble}
            onAction={bubbleAction === 'open-tasks' ? openTasks : undefined}
          />
        ) : null}
      </div>
    </div>
  )
}
