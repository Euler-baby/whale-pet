/**
 * 任务到期提醒调度 · Agent-Main（0.4.0，契约 2.0；基线 0.3.2 C-04）
 *
 * 口径（docs/35 §4、docs/37 N-01～N-12）：
 * - 30 秒 tick + 启动立即检查；每 tick 只处理一条（按 dueAt、createdAt、id 升序稳定）
 * - 有效提前量 = `task.reminderLeadMinOverride ?? settings.customReminderLeadMin ??
 *   settings.reminderLeadMin`（null 表示动态继承，不是创建时快照）
 * - 两个独立消费阶段：soon（临近截止）与 due（已到期）。消费标记持久化在
 *   `task.reminderState`；due 消费时补齐 soon，防止回拨后补发；改提前量不清消费标记
 * - 宠物窗隐藏 → 不处理也不消费，显示后按当前阶段补发
 * - 每 tick 先刷新 HUD（状态变化推送 + HUD 空闲时发汇总）
 * - 紧急任务：只更新 HUD，不弹普通气泡（消费但仍算已处理）
 * - 普通任务 23:00–07:00 免打扰：静默消费，不弹/不排队，DND 结束不重放
 * - HUD 活跃 → 先消费成功再入队；HUD 空闲 → 弹泡成功才消费
 * - 发送成功但消费落盘失败：本进程用临时锁阻止重复发送，之后每 tick 只重试落盘；
 *   dueAt 变化使锁失效（docs/35 §4 N-10 边界）
 * - 纯调度：不 import Electron、不直接读文件，时间/数据/发送能力由 main 注入
 */
import { isDndActive } from '@shared/rules'
import {
  dueReminderFor,
  effectiveReminderLeadMinutes,
  reminderText,
  TASK_DND_END,
  TASK_DND_START,
} from '@shared/tasks'
import type { Settings, Task, Timestamp } from '@shared/types'

import type { ReminderPhase, TaskHud } from './task-hud'

/** 默认轮询间隔：30 秒（自用 MVP 固定值） */
export const TASK_REMINDER_INTERVAL_MS = 30 * 1000

/** 免打扰固定区间（MVP 固定 23:00–07:00，不可配） */
const DND_SETTINGS = { enabled: true, start: TASK_DND_START, end: TASK_DND_END } as const

/** 发送成功但消费写入失败时的临时锁：只阻止重复发送，不假装已持久化 */
interface ConsumeLock {
  dueAt: Timestamp
  phase: ReminderPhase
  /** 视觉投递发生时刻；恢复写盘时沿用，不伪造新的消费时间 */
  at: Timestamp
}

export interface TaskReminderDeps {
  /** 当前全部任务快照（main 注入 `() => tasks.getTasks()`） */
  getTasks: () => readonly Task[]
  /** 提交两阶段消费（main 注入 `tasks.consumeReminder`）；失败 throw，由本调度重试/加锁 */
  consumeReminder: (input: { id: string; phase: ReminderPhase; at: Timestamp }) => void
  /** 显示应用内气泡（main 注入：写 `pet:event` 到宠物窗） */
  sendBubble: (text: string) => boolean
  /** 宠物窗是否可见（隐藏时跳过且不消费，显示后补发） */
  isPetVisible: () => boolean
  /** 每 tick 读取设置（effective lead；main 注入 `() => settings.get()`） */
  getSettings: () => Settings
  /** HUD 状态机（紧急只更新 HUD；普通提醒排队/汇总） */
  hud: TaskHud
  /** 轮询间隔；默认 30 秒 */
  intervalMs?: number
  /** 时钟；默认 Date.now */
  now?: () => number
}

export interface TaskReminder {
  /** 立即检查一次并启动轮询（重复调用幂等） */
  start(): void
  /** 停止轮询（不改变已记录的提醒状态） */
  stop(): void
  /** 执行一次检查（单测直接调用；内部异常不抛出） */
  tick(): void
}

/** 稳定顺序：dueAt 升序（null 最后）→ createdAt → id */
function compareForReminder(a: Task, b: Task): number {
  const dueA = a.dueAt ?? Infinity
  const dueB = b.dueAt ?? Infinity
  if (dueA !== dueB) return dueA < dueB ? -1 : 1
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function createTaskReminder(deps: TaskReminderDeps): TaskReminder {
  const intervalMs = deps.intervalMs ?? TASK_REMINDER_INTERVAL_MS
  const clock = deps.now ?? Date.now
  let timer: ReturnType<typeof setInterval> | null = null
  /** taskId → 临时消费锁（仅本进程内存；重启丢失，属 doc/35 §4 明示边界） */
  const locks = new Map<string, ConsumeLock>()

  const findTask = (id: string): Task | undefined => deps.getTasks().find((task) => task.id === id)

  /** 重试“气泡已发、消费落盘失败”的写入；dueAt 变化/任务消失则锁失效 */
  const retryLocks = (): void => {
    for (const [id, lock] of [...locks]) {
      const task = findTask(id)
      if (task === undefined || task.dueAt !== lock.dueAt) {
        locks.delete(id)
        continue
      }
      try {
        deps.consumeReminder({ id, phase: lock.phase, at: lock.at })
        locks.delete(id)
      } catch (error) {
        console.error('[task-reminder] 提醒消费重试写入失败（下轮再试）:', error)
      }
    }
  }

  /** 消费指定阶段；写盘失败只加临时锁（已投递不能重复弹），下轮重试落盘 */
  const consumeOrLock = (task: Task, phase: ReminderPhase, now: Timestamp): void => {
    if (task.dueAt === null) return
    try {
      deps.consumeReminder({ id: task.id, phase, at: now })
      locks.delete(task.id)
    } catch (error) {
      locks.set(task.id, { dueAt: task.dueAt, phase, at: now })
      console.error('[task-reminder] 提醒消费写入失败（本进程内不再重发，稍后重试保存）:', error)
    }
  }

  const isLocked = (task: Task, phase: ReminderPhase): boolean => {
    const lock = locks.get(task.id)
    if (lock === undefined) return false
    if (lock.dueAt !== task.dueAt) {
      locks.delete(task.id)
      return false
    }
    return lock.phase === phase
  }

  const tick = (): void => {
    try {
      // 宠物窗隐藏：不提醒也不消费，等待显示后的 tick 补发
      if (!deps.isPetVisible()) return

      const now = clock()
      // 先刷新 HUD：状态变化推送 + HUD 空闲时发普通提醒汇总
      deps.hud.refresh(now)

      // 先补写上次“已发送但未落盘”的消费，避免重复弹泡
      retryLocks()

      const settings = deps.getSettings()
      // 单个气泡无法同时展示多条；按到期先后逐 tick 排队，未展示的任务不消费
      const pending = [...deps.getTasks()].sort(compareForReminder)

      for (const task of pending) {
        const leadMs = effectiveReminderLeadMinutes(task, settings) * 60_000
        const phase = dueReminderFor(task, now, leadMs)
        if (phase === null) continue
        // 临时锁：该阶段已投递但消费未落盘，跳过本任务（不重发），不影响其他任务
        if (isLocked(task, phase)) continue

        // 紧急任务不弹气泡：HUD 已承载，只消费（到期时仅更新 HUD）
        if (task.importance === 'urgent') {
          consumeOrLock(task, phase, now)
          return
        }

        // 免打扰：普通提醒静默消费，不弹也不排队（避免 DND 结束后刷屏）
        if (isDndActive(now, DND_SETTINGS)) {
          consumeOrLock(task, phase, now)
          return
        }

        // HUD 活跃：先消费成功再入队并返回（角标由 HUD 推送）；空闲：本调度直接弹泡
        const text = reminderText(task, phase, now)
        const decision = deps.hud.offerNormalReminder(
          {
            taskId: task.id,
            dueAt: task.dueAt as Timestamp,
            phase,
            text,
          },
          now,
        )
        if (decision === 'queued') return

        let sent = false
        try {
          sent = deps.sendBubble(text)
        } catch (error) {
          console.error('[task-reminder] 提醒气泡发送失败（下轮重试，不消费）:', error)
        }
        // 发送失败不消费：下一 tick 仍可重试；成功才写消费（写失败进临时锁）
        if (!sent) return
        consumeOrLock(task, phase, now)
        return
      }
    } catch (error) {
      // 提醒失败不能影响主进程（掉线/窗口销毁/存储异常都只记录）
      console.error('[task-reminder] 到期提醒检查失败（不影响主流程）:', error)
    }
  }

  return {
    start(): void {
      if (timer !== null) return
      tick()
      timer = setInterval(tick, intervalMs)
      timer.unref?.()
    },

    stop(): void {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    },

    tick,
  }
}
