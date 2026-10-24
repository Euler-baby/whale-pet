/**
 * 任务到期提醒调度单测 · Agent-Data（0.4.0 / docs/35 §4、docs/37 N-01～N-12）
 *
 * 口径：与 Main 的 task-reminder/task-hud 实现联测（真实 TaskHud + 内存 store 模拟）
 * - 注入 now / interval / 可见性 / 设置；tick 手动调用，不依赖真实时钟
 * - 覆盖 soon/due 两阶段、custom/override 提前量、DND 静默、隐藏跳过、紧急只更新 HUD、
 *   HUD 活跃排队 + 角标、HUD 空闲汇总、发送失败重试、发送成功+落盘失败临时锁、每 tick 一条
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTask } from '@shared/tasks'
import type { PetEvent, Project, Settings, Task, Timestamp } from '@shared/types'

import { createTaskHud } from '../../src/main/services/task-hud'
import type { ReminderPhase } from '../../src/main/services/task-hud'
import {
  createTaskReminder,
  TASK_REMINDER_INTERVAL_MS,
} from '../../src/main/services/task-reminder'

/** 2026-10-21（周三）10:00 本地时间 */
const BASE = new Date(2026, 9, 21, 10, 0, 0).getTime()

function at(hour: number, minute = 0, day = 21): number {
  return new Date(2026, 9, day, hour, minute, 0).getTime()
}

function makeTask(overrides: Partial<Task> = {}): Task {
  const base = createTask(
    { title: overrides.title ?? '写周报', category: 'study' },
    BASE,
    overrides.id ?? 'task-1',
  )
  const merged: Task = { ...base, ...overrides }
  // 测试夹具保持 store 不变量：reminderState.dueAt 必须与 dueAt 一致
  return {
    ...merged,
    reminderState: overrides.reminderState ?? {
      dueAt: merged.dueAt,
      soonConsumedAt: null,
      dueConsumedAt: null,
    },
  }
}

interface HarnessOptions {
  visible?: boolean
  now?: Timestamp
  settings?: Partial<Settings>
  bubbleOk?: boolean
  /** 前 N 次 consumeReminder 抛错（模拟落盘失败） */
  failConsumeTimes?: number
}

/** 内存版 main 接线：真实 TaskHud + TaskReminder + 模拟 store.consumeReminder */
function harness(
  initial: readonly Task[],
  projects: readonly Project[] = [],
  options: HarnessOptions = {},
) {
  let tasks = initial.map((task) => ({ ...task, reminderState: { ...task.reminderState } }))
  let visible = options.visible ?? true
  let bubbleOk = options.bubbleOk ?? true
  let now = options.now ?? BASE
  let nowCalls = 0
  let failConsumeRemaining = options.failConsumeTimes ?? 0
  let bubbleSeq = 0
  const settings: Settings = {
    autostart: false,
    muted: false,
    reminderLeadMin: 15,
    customReminderLeadMin: null,
    hudScope: 'urgent',
    ...options.settings,
  }
  /** 调度直接弹的普通气泡 */
  const reminderBubbles: string[] = []
  /** HUD 汇总气泡 */
  const hudBubbles: { id: string; text: string }[] = []
  const dismissed: string[] = []
  const events: PetEvent[] = []
  const consumed: { id: string; phase: ReminderPhase; at: Timestamp }[] = []

  const consumeReminder = vi.fn(
    (input: { id: string; phase: ReminderPhase; at: Timestamp }): void => {
      consumed.push({ ...input })
      if (failConsumeRemaining > 0) {
        failConsumeRemaining -= 1
        throw new Error('任务保存失败（模拟）')
      }
      const index = tasks.findIndex((task) => task.id === input.id)
      const task = tasks[index]
      if (task === undefined) throw new Error('任务不存在')
      if (task.status !== 'todo' || task.archivedAt !== null || task.dueAt === null) {
        throw new Error('TASK_NOT_ACTIVE: 任务当前不可提醒')
      }
      const state = task.reminderState
      if (input.phase === 'soon' && state.soonConsumedAt !== null) return
      if (input.phase === 'due' && state.dueConsumedAt !== null) return
      tasks[index] = {
        ...task,
        remindedAt: input.at,
        reminderState: {
          ...state,
          soonConsumedAt: state.soonConsumedAt ?? input.at,
          dueConsumedAt: input.phase === 'due' ? input.at : state.dueConsumedAt,
        },
      }
    },
  )

  const hud = createTaskHud({
    getTasks: () => tasks,
    getProjects: () => projects,
    getSettings: () => settings,
    sendEvent: (event) => {
      events.push(event)
    },
    sendBubble: (text) => {
      if (!bubbleOk) return null
      bubbleSeq += 1
      const id = `bubble-${String(bubbleSeq)}`
      hudBubbles.push({ id, text })
      return id
    },
    dismissBubble: (bubbleId) => {
      dismissed.push(bubbleId)
    },
    consumeReminder,
    bubbleDurationMs: 8_000,
  })

  const reminder = createTaskReminder({
    getTasks: () => tasks,
    consumeReminder,
    sendBubble: (text) => {
      if (!bubbleOk) return false
      reminderBubbles.push(text)
      return true
    },
    isPetVisible: () => visible,
    getSettings: () => settings,
    hud,
    intervalMs: TASK_REMINDER_INTERVAL_MS,
    now: () => {
      nowCalls += 1
      return now
    },
  })

  return {
    hud,
    reminder,
    settings,
    reminderBubbles,
    hudBubbles,
    dismissed,
    events,
    consumed,
    now: () => now,
    nowCalls: () => nowCalls,
    getTasks: () => tasks,
    setNow: (value: Timestamp): void => {
      now = value
    },
    setVisible: (value: boolean): void => {
      visible = value
    },
    setBubbleOk: (value: boolean): void => {
      bubbleOk = value
    },
    setSettings: (patch: Partial<Settings>): void => {
      Object.assign(settings, patch)
    },
    setTasks: (next: readonly Task[]): void => {
      tasks = next.map((task) => ({ ...task, reminderState: { ...task.reminderState } }))
    },
    setFailConsume: (count: number): void => {
      failConsumeRemaining = count
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('两阶段提醒（soon/due）', () => {
  it('soon 消费一次；到期后再 due 一次，互不干扰', () => {
    const h = harness([makeTask({ dueAt: at(18) })])

    // 17:45 进入 15 分钟 soon 窗口
    h.setNow(at(17, 45))
    h.reminder.tick()
    expect(h.reminderBubbles).toEqual(['「写周报」还有 15 分钟'])
    expect(h.consumed.at(-1)).toMatchObject({ phase: 'soon', at: at(17, 45) })

    h.setNow(at(17, 50))
    h.reminder.tick()
    expect(h.reminderBubbles).toHaveLength(1)

    // 到期：due 独立于 soon 消费
    h.setNow(at(18))
    h.reminder.tick()
    expect(h.reminderBubbles).toEqual(['「写周报」还有 15 分钟', '「写周报」已到期'])
    expect(h.consumed.at(-1)).toMatchObject({ phase: 'due', at: at(18) })

    h.reminder.tick()
    expect(h.reminderBubbles).toHaveLength(2)
  })

  it('due 消费补齐 soon（不追补旧 soon）', () => {
    const h = harness([makeTask({ dueAt: at(18) })])
    // 直接跳到到期：只发 due
    h.setNow(at(18))
    h.reminder.tick()
    expect(h.reminderBubbles).toEqual(['「写周报」已到期'])
    const consumed = h.getTasks()[0]?.reminderState
    expect(consumed).toEqual({
      dueAt: at(18),
      soonConsumedAt: at(18),
      dueConsumedAt: at(18),
    })
  })

  it('未进入提前量窗口不提醒', () => {
    const h = harness([makeTask({ dueAt: at(18) })])
    h.setNow(at(17, 44))
    h.reminder.tick()
    expect(h.reminderBubbles).toEqual([])
    expect(h.consumed).toEqual([])
  })
})

describe('提前量来源（custom / override）', () => {
  it('全局自定义 45 分钟：30 分钟后到期会提前提醒', () => {
    const h = harness([makeTask({ dueAt: at(10, 30) })], [], {
      settings: { customReminderLeadMin: 45 },
    })
    h.reminder.tick()
    expect(h.reminderBubbles).toEqual(['「写周报」还有 30 分钟'])
  })

  it('任务覆盖 5 分钟：30 分钟后到期不提醒（不受全局 45 影响）', () => {
    const h = harness([makeTask({ dueAt: at(10, 30), reminderLeadMinOverride: 5 })], [], {
      settings: { customReminderLeadMin: 45 },
    })
    h.reminder.tick()
    expect(h.reminderBubbles).toEqual([])
  })

  it('每 tick 读取设置：运行中改全局自定义生效', () => {
    const h = harness([makeTask({ dueAt: at(10, 30) })])
    h.reminder.tick()
    expect(h.reminderBubbles).toEqual([])

    h.setSettings({ customReminderLeadMin: 45 })
    h.reminder.tick()
    expect(h.reminderBubbles).toEqual(['「写周报」还有 30 分钟'])
  })

  it('改全局默认不重复已消费的 soon', () => {
    const h = harness([makeTask({ dueAt: at(18) })])
    h.setNow(at(17, 45))
    h.reminder.tick()
    expect(h.reminderBubbles).toHaveLength(1)

    h.setSettings({ reminderLeadMin: 60 })
    h.reminder.tick()
    expect(h.reminderBubbles).toHaveLength(1)
  })
})

describe('宠物窗可见性与免打扰', () => {
  it('隐藏时跳过且不消费，显示后补发', () => {
    const h = harness([makeTask({ dueAt: at(18) })], [], { visible: false })
    h.setNow(at(18))
    h.reminder.tick()
    expect(h.reminderBubbles).toEqual([])
    expect(h.consumed).toEqual([])

    h.setVisible(true)
    h.reminder.tick()
    expect(h.reminderBubbles).toEqual(['「写周报」已到期'])
    expect(h.consumed.at(-1)).toMatchObject({ phase: 'due' })
  })

  it('DND 23:00–07:00 静默消费，不弹泡不排队', () => {
    const dndNow = at(23, 30)
    const h = harness([makeTask({ dueAt: new Date(2026, 9, 21, 23, 40, 0).getTime() })], [], {
      now: dndNow,
    })
    h.reminder.tick()
    expect(h.reminderBubbles).toEqual([])
    expect(h.hudBubbles).toEqual([])
    expect(h.consumed.at(-1)).toMatchObject({ phase: 'soon', at: dndNow })
    expect(h.hud.getState(dndNow).queued).toBe(0)
  })

  it('DND 结束不重放已静默的 soon；逾期只补一次 due', () => {
    const dndNow = at(23, 30)
    const dueAt = new Date(2026, 9, 21, 23, 40, 0).getTime()
    const h = harness([makeTask({ dueAt })], [], { now: dndNow })
    h.reminder.tick()
    expect(h.reminderBubbles).toEqual([])

    h.setNow(at(7, 30, 22))
    h.reminder.tick()
    expect(h.reminderBubbles).toEqual(['「写周报」已到期'])
    h.reminder.tick()
    expect(h.reminderBubbles).toHaveLength(1)
  })
})

describe('紧急任务只更新 HUD', () => {
  it('紧急任务不弹普通气泡，只消费并推送 HUD', () => {
    const h = harness([makeTask({ importance: 'urgent', dueAt: at(18) })])
    h.setNow(at(18))
    h.reminder.tick()
    expect(h.reminderBubbles).toEqual([])
    expect(h.consumed.at(-1)).toMatchObject({ phase: 'due' })
    expect(h.events.at(-1)).toMatchObject({
      type: 'tasks-urgent',
      urgentTasks: { total: 1 },
    })
  })

  it('紧急任务在 DND 仍只更新 HUD（不弹泡）', () => {
    const dndNow = at(23, 30)
    const dueAt = new Date(2026, 9, 21, 23, 40, 0).getTime()
    const h = harness([makeTask({ importance: 'urgent', dueAt })], [], { now: dndNow })
    h.reminder.tick()
    expect(h.reminderBubbles).toEqual([])
    expect(h.consumed.at(-1)).toMatchObject({ phase: 'soon' })
    expect(h.events.at(-1)).toMatchObject({ type: 'tasks-urgent', urgentTasks: { total: 1 } })
  })
})

describe('HUD 冲突：排队 + 角标 / 空闲汇总', () => {
  it('HUD 活跃时普通提醒入队并消费，事件带 queued 角标，不弹泡', () => {
    const h = harness([
      makeTask({ id: 'urgent', importance: 'urgent', title: '紧急任务' }),
      makeTask({ id: 'normal', title: '普通任务', dueAt: at(18) }),
    ])
    h.setNow(at(17, 50))
    h.reminder.tick()

    expect(h.reminderBubbles).toEqual([])
    expect(h.consumed.at(-1)).toMatchObject({ id: 'normal', phase: 'soon' })
    expect(h.events.at(-1)).toMatchObject({ type: 'tasks-urgent', urgentTasks: { queued: 1 } })
  })

  it('HUD 空闲后一次 tick 发 1 条汇总（含标题），不逐条弹泡', () => {
    const h = harness([
      makeTask({ id: 'urgent', importance: 'urgent', title: '紧急任务' }),
      makeTask({ id: 'normal', title: '普通任务', dueAt: at(18) }),
    ])
    h.setNow(at(17, 50))
    h.reminder.tick()
    expect(h.consumed.at(-1)).toMatchObject({ id: 'normal', phase: 'soon' })

    // 紧急任务完成 → HUD 空闲
    h.setTasks(h.getTasks().filter((task) => task.id !== 'urgent'))
    h.setNow(at(17, 51))
    h.reminder.tick()
    expect(h.hudBubbles.map((bubble) => bubble.text)).toEqual(['还有 1 条任务提醒：普通任务'])
  })
})

describe('发送失败与消费落盘失败', () => {
  it('气泡发送失败不消费，下一 tick 重试', () => {
    const h = harness([makeTask({ dueAt: at(18) })], [], { bubbleOk: false })
    h.setNow(at(18))
    h.reminder.tick()
    expect(h.reminderBubbles).toEqual([])
    expect(h.consumed).toEqual([])

    h.setBubbleOk(true)
    h.reminder.tick()
    expect(h.reminderBubbles).toEqual(['「写周报」已到期'])
    expect(h.consumed.at(-1)).toMatchObject({ phase: 'due' })
  })

  it('发送成功但消费落盘失败：本进程不重发，下轮只重试落盘', () => {
    const h = harness([makeTask({ dueAt: at(18) })], [], { failConsumeTimes: 1 })
    h.setNow(at(18))
    h.reminder.tick()
    // 第一次：气泡已发，消费失败 → 临时锁
    expect(h.reminderBubbles).toEqual(['「写周报」已到期'])
    expect(h.consumed).toHaveLength(1)

    h.reminder.tick()
    // 不重复发送；消费写入重试成功
    expect(h.reminderBubbles).toHaveLength(1)
    expect(h.consumed).toHaveLength(2)
    expect(h.getTasks()[0]?.reminderState.dueConsumedAt).toBe(at(18))
  })

  it('读取任务异常不中断，下一次 tick 仍可提醒', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const tasks = [makeTask({ dueAt: at(18) })]
    let failNext = true
    const settings: Settings = {
      autostart: false,
      muted: false,
      reminderLeadMin: 15,
      customReminderLeadMin: null,
      hudScope: 'urgent',
    }
    const getTasks = (): readonly Task[] => {
      if (failNext) {
        failNext = false
        throw new Error('boom')
      }
      return tasks
    }
    const bubbles: string[] = []
    const consumed: ReminderPhase[] = []
    const hud = createTaskHud({
      getTasks,
      getProjects: () => [],
      getSettings: () => settings,
      sendEvent: () => {},
      sendBubble: () => 'bubble-id',
      dismissBubble: () => {},
      consumeReminder: () => {},
      bubbleDurationMs: 8_000,
    })
    const reminder = createTaskReminder({
      getTasks,
      consumeReminder: (input) => {
        consumed.push(input.phase)
      },
      sendBubble: (text) => {
        bubbles.push(text)
        return true
      },
      isPetVisible: () => true,
      getSettings: () => settings,
      hud,
      now: () => at(18),
    })

    expect(() => reminder.tick()).not.toThrow()
    expect(errorSpy).toHaveBeenCalled()

    reminder.tick()
    expect(bubbles).toEqual(['「写周报」已到期'])
    expect(consumed).toEqual(['due'])
  })
})

describe('每 tick 一条与不处理完成/搁置', () => {
  it('多条到期任务逐 tick 一条，按 dueAt/createdAt/id 稳定顺序', () => {
    const h = harness([
      makeTask({ id: 'later', title: '后到期', dueAt: at(9, 0, 21) }),
      makeTask({ id: 'earlier', title: '先到期', dueAt: at(8, 0, 21) }),
    ])
    h.reminder.tick()
    expect(h.reminderBubbles).toEqual(['「先到期」已到期'])
    expect(h.consumed.at(-1)).toMatchObject({ id: 'earlier' })

    h.reminder.tick()
    expect(h.reminderBubbles).toEqual(['「先到期」已到期', '「后到期」已到期'])
    expect(h.consumed.at(-1)).toMatchObject({ id: 'later' })
  })

  it('已完成/已搁置/无截止任务不提醒不消费', () => {
    const h = harness([
      makeTask({ id: 'done', status: 'done', completedAt: at(9), dueAt: at(8) }),
      makeTask({ id: 'archived', archivedAt: at(9), dueAt: at(8) }),
      makeTask({ id: 'no-due' }),
    ])
    h.reminder.tick()
    expect(h.reminderBubbles).toEqual([])
    expect(h.consumed).toEqual([])
  })
})

describe('start / stop', () => {
  it('start() 立即检查一次并按间隔轮询，stop() 后停止', () => {
    vi.useFakeTimers()
    const h = harness([makeTask({ dueAt: at(18) })])
    h.setNow(at(18))

    h.reminder.start()
    expect(h.nowCalls()).toBe(1)
    expect(h.reminderBubbles).toHaveLength(1)

    vi.advanceTimersByTime(TASK_REMINDER_INTERVAL_MS)
    expect(h.nowCalls()).toBe(2)

    h.reminder.stop()
    vi.advanceTimersByTime(TASK_REMINDER_INTERVAL_MS * 2)
    expect(h.nowCalls()).toBe(2)

    h.reminder.stop()
    h.reminder.start()
    expect(h.nowCalls()).toBe(3)
    h.reminder.stop()
  })
})
