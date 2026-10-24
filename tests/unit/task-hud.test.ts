/**
 * HUD 状态机 + 普通提醒队列单测 · Agent-Main（0.4.0，契约 2.0）
 *
 * 口径（docs/35 §4、docs/37 N-05/N-08/N-11/N-12）：
 * - HUD 候选只含活动任务（todo 且未搁置），按 hudScope 两档 + 项目名映射 + 总数/角标
 * - 事件去重：状态变化才推送 tasks-urgent
 * - 普通提醒：HUD 活跃时先消费成功再入队（同 taskId 一项、due 替换 soon）；
 *   HUD 空闲返回 'send'；队列上限 / TTL / 免打扰汇总
 * - HUD 空闲后一条汇总（≤3 标题 + 等 N 条），成功才清队；失败保留重试
 * - 任务完成/搁置/删除/改 dueAt/显式 dropQueued：清队列、撤换已显示汇总、不复活失效项
 * - 任务编辑只有 dueAt（或失效/状态）变化才作废排队项；只改备注/标题/重要性/提醒覆盖保留队列
 */
import { describe, expect, it, vi } from 'vitest'

import { HUD_QUEUE_MAX, HUD_QUEUE_TTL_MS } from '@shared/tasks'
import type { PetEvent, Project, Settings, Task } from '@shared/types'

import type { ReminderPhase } from '../../src/main/services/task-hud'
import { createTaskHud, shouldInvalidateQueuedBeforeUpdate } from '../../src/main/services/task-hud'

/** 2026-10-21 10:00（本地时区；业务日 04:00 口径） */
const BASE = new Date(2026, 9, 21, 10, 0, 0).getTime()
const MINUTE = 60_000

function at(hour: number, minute = 0, day = 21): number {
  return new Date(2026, 9, day, hour, minute, 0).getTime()
}

function makeTask(overrides: Partial<Task> = {}): Task {
  const task: Task = {
    id: 'task-1',
    title: '任务',
    category: 'life',
    projectId: null,
    importance: 'normal',
    status: 'todo',
    dueAt: null,
    remindedAt: null,
    note: null,
    createdAt: BASE,
    updatedAt: BASE,
    completedAt: null,
    todayPinnedDayKey: null,
    archivedAt: null,
    reminderLeadMinOverride: null,
    reminderState: { dueAt: null, soonConsumedAt: null, dueConsumedAt: null },
    ...overrides,
  }
  // dueAt 覆盖时提醒消费快照必须同步（v3 不变量）
  if (overrides.dueAt !== undefined && overrides.reminderState === undefined) {
    task.reminderState = { dueAt: overrides.dueAt, soonConsumedAt: null, dueConsumedAt: null }
  }
  return task
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: '项目一',
    note: null,
    createdAt: BASE,
    updatedAt: BASE,
    ...overrides,
  }
}

interface OfferInput {
  taskId: string
  dueAt: number
  phase: ReminderPhase
  text: string
}

interface HarnessOptions {
  tasks?: readonly Task[]
  projects?: readonly Project[]
  settings?: Partial<Settings>
  bubbleOk?: boolean
  now?: number
  /** 覆盖事件发送（用于测试异常路径）；默认收集到 events */
  sendEvent?: (event: PetEvent) => void
  /** 覆盖消费提交（用于测试写入失败路径） */
  consumeReminder?: (input: { id: string; phase: ReminderPhase; at: number }) => void
}

function harness(options: HarnessOptions = {}) {
  let tasks = (options.tasks ?? []).map((task) => ({ ...task }))
  const projects = (options.projects ?? []).map((project) => ({ ...project }))
  let settings: Settings = {
    autostart: false,
    muted: false,
    reminderLeadMin: 15,
    customReminderLeadMin: null,
    hudScope: 'urgent',
    ...options.settings,
  }
  let bubbleOk = options.bubbleOk ?? true
  let now = options.now ?? BASE
  let bubbleSeq = 0
  const events: PetEvent[] = []
  const bubbles: { id: string; text: string }[] = []
  const dismissed: string[] = []
  const consumed: { id: string; phase: ReminderPhase; at: number }[] = []

  const hud = createTaskHud({
    getTasks: () => tasks,
    getProjects: () => projects,
    getSettings: () => settings,
    sendEvent:
      options.sendEvent ??
      ((event) => {
        events.push(event)
      }),
    sendBubble: (text) => {
      if (!bubbleOk) return null
      bubbleSeq += 1
      const id = `bubble-${String(bubbleSeq)}`
      bubbles.push({ id, text })
      return id
    },
    dismissBubble: (bubbleId) => {
      dismissed.push(bubbleId)
    },
    consumeReminder:
      options.consumeReminder ??
      ((input) => {
        consumed.push(input)
      }),
    bubbleDurationMs: 8000,
    now: () => now,
  })

  return {
    hud,
    events,
    bubbles,
    dismissed,
    consumed,
    now: () => now,
    getTasks: () => tasks,
    setNow: (value: number): void => {
      now = value
    },
    setTasks: (next: readonly Task[]): void => {
      tasks = next.map((task) => ({ ...task }))
    },
    setSettings: (patch: Partial<Settings>): void => {
      settings = { ...settings, ...patch }
    },
    setBubbleOk: (value: boolean): void => {
      bubbleOk = value
    },
    offer: (input: OfferInput): 'queued' | 'send' => hud.offerNormalReminder(input, now),
  }
}

describe('getState', () => {
  it('按 hudScope 选候选：urgent 只含紧急；urgent-due 额外含今天到期', () => {
    const h = harness({
      tasks: [
        makeTask({ id: 'u', importance: 'urgent', title: '紧急' }),
        makeTask({ id: 'due', dueAt: at(18), title: '今天到期' }),
        makeTask({ id: 'future', dueAt: at(18, 0, 25), title: '未来' }),
      ],
    })

    const urgent = h.hud.getState(BASE)
    expect(urgent.tasks.map((task) => task.id)).toEqual(['u'])
    expect(urgent.total).toBe(1)
    expect(urgent.queued).toBe(0)

    h.setSettings({ hudScope: 'urgent-due' })
    const due = h.hud.getState(BASE)
    expect(due.tasks.map((task) => task.id)).toEqual(['due', 'u'])
    expect(due.total).toBe(2)
  })

  it('排除已完成与搁置任务（0.4：归档后不再进入 HUD）', () => {
    const h = harness({
      tasks: [
        makeTask({ id: 'done', importance: 'urgent', status: 'done', completedAt: BASE }),
        makeTask({ id: 'archived', importance: 'urgent', archivedAt: BASE }),
        makeTask({ id: 'live', importance: 'urgent' }),
      ],
    })
    const state = h.hud.getState(BASE)
    expect(state.tasks.map((task) => task.id)).toEqual(['live'])
    expect(state.total).toBe(1)
  })

  it('项目任务映射项目名，非项目任务 projectName=null', () => {
    const h = harness({
      tasks: [
        makeTask({
          id: 'p',
          category: null,
          projectId: 'proj-1',
          importance: 'urgent',
          title: '项目任务',
        }),
        makeTask({ id: 'n', importance: 'urgent', title: '普通紧急任务' }),
      ],
      projects: [makeProject()],
    })
    const state = h.hud.getState(BASE)
    const byId = new Map(state.tasks.map((task) => [task.id, task]))
    expect(byId.get('p')).toMatchObject({ projectName: '项目一', category: null })
    expect(byId.get('n')).toMatchObject({ projectName: null, category: 'life' })
  })
})

describe('refresh 与事件去重', () => {
  it('首次推送一次；状态不变不重复；变化才推送', () => {
    const h = harness({ tasks: [makeTask({ id: 'u', importance: 'urgent' })] })
    h.hud.refresh(BASE)
    expect(h.events).toHaveLength(1)
    expect(h.events[0]).toMatchObject({
      type: 'tasks-urgent',
      urgentTasks: { total: 1, queued: 0 },
    })

    h.hud.refresh(BASE)
    expect(h.events).toHaveLength(1)

    h.setTasks([])
    h.hud.refresh(BASE)
    expect(h.events).toHaveLength(2)
    expect(h.events[1]).toEqual({
      type: 'tasks-urgent',
      urgentTasks: { tasks: [], total: 0, queued: 0 },
    })
  })

  it('切换 hudScope 后状态变化会推送', () => {
    const h = harness({ tasks: [makeTask({ dueAt: at(18) })] })
    h.hud.refresh(BASE)
    expect(h.events).toHaveLength(1) // urgent: 无候选
    h.setSettings({ hudScope: 'urgent-due' })
    h.hud.refresh(BASE)
    expect(h.events).toHaveLength(2)
    expect(h.events[1]).toMatchObject({
      type: 'tasks-urgent',
      urgentTasks: { total: 1, queued: 0 },
    })
  })

  it('事件推送异常被吞掉并记录，下一轮重试', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const events: PetEvent[] = []
    let failNext = true
    const tasks = [makeTask({ importance: 'urgent' })]
    const hud = createTaskHud({
      getTasks: () => tasks,
      getProjects: () => [],
      getSettings: () => ({
        autostart: false,
        muted: false,
        reminderLeadMin: 15,
        customReminderLeadMin: null,
        hudScope: 'urgent',
      }),
      sendEvent: (event) => {
        if (failNext) {
          failNext = false
          throw new Error('webContents 已销毁')
        }
        events.push(event)
      },
      sendBubble: () => null,
      dismissBubble: () => {},
      consumeReminder: () => {},
    })

    expect(() => hud.refresh(BASE)).not.toThrow()
    expect(errorSpy).toHaveBeenCalled()
    expect(events).toHaveLength(0)

    hud.refresh(BASE)
    expect(events).toHaveLength(1)
    errorSpy.mockRestore()
  })
})

describe('offerNormalReminder', () => {
  it('HUD 活跃时先消费再入队，推送 queued 角标，不弹泡', () => {
    const h = harness({
      tasks: [
        makeTask({ id: 'u', importance: 'urgent' }),
        makeTask({ id: 'n1', dueAt: BASE + 5 * MINUTE }),
      ],
    })
    h.hud.refresh(BASE)

    const decision = h.offer({
      taskId: 'n1',
      dueAt: BASE + 5 * MINUTE,
      phase: 'soon',
      text: '「任务」还有 5 分钟',
    })
    expect(decision).toBe('queued')
    expect(h.consumed).toEqual([{ id: 'n1', phase: 'soon', at: BASE }])
    expect(h.hud.getState(BASE).queued).toBe(1)
    expect(h.events.at(-1)).toMatchObject({
      type: 'tasks-urgent',
      urgentTasks: { queued: 1 },
    })
    expect(h.bubbles).toEqual([])
  })

  it('HUD 空闲时返回 send，不入队不消费（由调度弹泡后自行消费）', () => {
    const h = harness()
    h.hud.refresh(BASE)
    const decision = h.offer({ taskId: 'n1', dueAt: BASE + 5 * MINUTE, phase: 'soon', text: 'x' })
    expect(decision).toBe('send')
    expect(h.consumed).toHaveLength(0)
    expect(h.hud.getState(BASE).queued).toBe(0)
  })

  it('同任务 due 替换尚未投递的 soon：只保留一项，不重复摘要', () => {
    const h = harness({
      tasks: [
        makeTask({ id: 'u', importance: 'urgent' }),
        makeTask({ id: 'n1', title: 'A', dueAt: BASE + 10 * MINUTE }),
      ],
    })
    h.offer({ taskId: 'n1', dueAt: BASE + 10 * MINUTE, phase: 'soon', text: '还有 10 分钟' })
    expect(h.consumed).toHaveLength(1)

    const decision = h.offer({
      taskId: 'n1',
      dueAt: BASE + 10 * MINUTE,
      phase: 'due',
      text: '已到期',
    })
    expect(decision).toBe('queued')
    expect(h.consumed.map((item) => item.phase)).toEqual(['soon', 'due'])
    expect(h.hud.getState(BASE).queued).toBe(1)

    h.setTasks([makeTask({ id: 'n1', title: 'A', dueAt: BASE + 10 * MINUTE })])
    h.hud.refresh(BASE + MINUTE)
    expect(h.bubbles.at(-1)?.text).toBe('还有 1 条任务提醒：A')
  })

  it('消费提交失败时抛错且不留下内存排队项', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness({
      tasks: [makeTask({ id: 'u', importance: 'urgent' })],
      consumeReminder: () => {
        throw new Error('磁盘写入失败')
      },
    })
    expect(() =>
      h.offer({ taskId: 'n1', dueAt: BASE + 5 * MINUTE, phase: 'soon', text: 'x' }),
    ).toThrow('磁盘写入失败')
    expect(h.hud.getState(BASE).queued).toBe(0)
    errorSpy.mockRestore()
  })

  it('队列上限 HUD_QUEUE_MAX，超限丢最旧', () => {
    const normalTasks = Array.from({ length: HUD_QUEUE_MAX + 2 }, (_, index) =>
      makeTask({
        id: `n${String(index + 1)}`,
        title: `title-${String(index + 1)}`,
        dueAt: BASE + (index + 1) * MINUTE,
      }),
    )
    const h = harness({ tasks: [makeTask({ id: 'u', importance: 'urgent' }), ...normalTasks] })
    for (let index = 1; index <= HUD_QUEUE_MAX + 2; index += 1) {
      h.offer({
        taskId: `n${String(index)}`,
        dueAt: BASE + index * MINUTE,
        phase: 'soon',
        text: `title-${String(index)}`,
      })
    }
    expect(h.hud.getState(BASE).queued).toBe(HUD_QUEUE_MAX)

    // HUD 清空后汇总：只保留最后 5 条（title-3..title-7）
    h.setTasks(normalTasks)
    h.hud.refresh(BASE + 200)
    const summary = h.bubbles.at(-1)?.text ?? ''
    expect(summary).toContain('title-3')
    expect(summary).not.toContain('title-2')
    expect(summary).toContain('等 2 条')
  })
})

describe('队列 TTL 与免打扰', () => {
  it('入队后 10 分钟内保留，达到 TTL 即清理并推送角标变化', () => {
    const h = harness({
      tasks: [
        makeTask({ id: 'u', importance: 'urgent' }),
        makeTask({ id: 'n1', title: 'A', dueAt: BASE + 5 * MINUTE }),
      ],
    })
    h.offer({ taskId: 'n1', dueAt: BASE + 5 * MINUTE, phase: 'soon', text: 'x' })

    h.hud.refresh(BASE + HUD_QUEUE_TTL_MS - 1)
    expect(h.hud.getState(BASE + HUD_QUEUE_TTL_MS - 1).queued).toBe(1)

    const eventsBefore = h.events.length
    h.hud.refresh(BASE + HUD_QUEUE_TTL_MS)
    expect(h.hud.getState(BASE + HUD_QUEUE_TTL_MS).queued).toBe(0)
    expect(h.events.length).toBeGreaterThan(eventsBefore)
    expect(h.events.at(-1)).toMatchObject({ type: 'tasks-urgent', urgentTasks: { queued: 0 } })
  })

  it('过期项不会被汇总补发（直接丢弃）', () => {
    const h = harness({
      tasks: [
        makeTask({ id: 'u', importance: 'urgent' }),
        makeTask({ id: 'n1', title: 'A', dueAt: BASE + 5 * MINUTE }),
      ],
    })
    h.offer({ taskId: 'n1', dueAt: BASE + 5 * MINUTE, phase: 'soon', text: 'x' })
    h.setTasks([])
    h.hud.refresh(BASE + HUD_QUEUE_TTL_MS)
    expect(h.bubbles).toEqual([])
    expect(h.hud.getState(BASE + HUD_QUEUE_TTL_MS).queued).toBe(0)
  })

  it('免打扰 23:00–07:00 内不发普通汇总（过期照常淘汰）', () => {
    const dndStart = at(23, 0, 21)
    const h = harness({
      now: dndStart,
      tasks: [
        makeTask({ id: 'u', importance: 'urgent' }),
        makeTask({ id: 'n1', title: 'A', dueAt: dndStart + 5 * MINUTE }),
      ],
    })
    h.offer({ taskId: 'n1', dueAt: dndStart + 5 * MINUTE, phase: 'soon', text: 'x' })
    // HUD 空闲但处于 DND：不汇总，队列保留（仍在 TTL 内）
    h.setTasks([makeTask({ id: 'n1', title: 'A', dueAt: dndStart + 5 * MINUTE })])
    h.hud.refresh(dndStart + MINUTE)
    expect(h.bubbles).toEqual([])
    expect(h.hud.getState(dndStart + MINUTE).queued).toBe(1)

    // 次日 DND 结束已过 TTL：过期淘汰，不补发
    h.hud.refresh(at(7, 1, 22))
    expect(h.bubbles).toEqual([])
    expect(h.hud.getState(at(7, 1, 22)).queued).toBe(0)
  })
})

describe('HUD 空闲汇总与失效重建', () => {
  it('≤3 条：一条汇总列出全部标题，成功清队并推送 queued=0', () => {
    const h = harness({
      tasks: [
        makeTask({ id: 'u', importance: 'urgent', title: '紧急任务' }),
        makeTask({ id: 'n1', title: 'A', dueAt: BASE + MINUTE }),
        makeTask({ id: 'n2', title: 'B', dueAt: BASE + 2 * MINUTE }),
      ],
    })
    h.offer({ taskId: 'n1', dueAt: BASE + MINUTE, phase: 'soon', text: 'x' })
    h.offer({ taskId: 'n2', dueAt: BASE + 2 * MINUTE, phase: 'soon', text: 'x' })
    expect(h.hud.getState(BASE).queued).toBe(2)

    // 紧急任务完成 → HUD 空闲
    h.setTasks([
      makeTask({ id: 'n1', title: 'A', dueAt: BASE + MINUTE }),
      makeTask({ id: 'n2', title: 'B', dueAt: BASE + 2 * MINUTE }),
    ])
    h.hud.refresh(BASE + 2 * MINUTE)

    expect(h.bubbles.map((bubble) => bubble.text)).toEqual(['还有 2 条任务提醒：A、B'])
    expect(h.hud.getState(BASE + 2 * MINUTE).queued).toBe(0)
    expect(h.events.at(-1)).toMatchObject({
      type: 'tasks-urgent',
      urgentTasks: { tasks: [], total: 0, queued: 0 },
    })
  })

  it('>3 条：最多列 3 条标题，其余“等 N 条”', () => {
    const h = harness({
      tasks: [
        makeTask({ id: 'u', importance: 'urgent', title: '紧急任务' }),
        makeTask({ id: 'n1', title: 'A', dueAt: BASE + MINUTE }),
        makeTask({ id: 'n2', title: 'B', dueAt: BASE + 2 * MINUTE }),
        makeTask({ id: 'n3', title: 'C', dueAt: BASE + 3 * MINUTE }),
        makeTask({ id: 'n4', title: 'D', dueAt: BASE + 4 * MINUTE }),
      ],
    })
    for (const id of ['n1', 'n2', 'n3', 'n4']) {
      const dueAt = BASE + Number(id.slice(1)) * MINUTE
      h.offer({ taskId: id, dueAt, phase: 'soon', text: 'x' })
    }
    h.setTasks([
      makeTask({ id: 'n1', title: 'A', dueAt: BASE + MINUTE }),
      makeTask({ id: 'n2', title: 'B', dueAt: BASE + 2 * MINUTE }),
      makeTask({ id: 'n3', title: 'C', dueAt: BASE + 3 * MINUTE }),
      makeTask({ id: 'n4', title: 'D', dueAt: BASE + 4 * MINUTE }),
    ])
    h.hud.refresh(BASE + MINUTE)

    expect(h.bubbles.at(-1)?.text).toBe('还有 4 条任务提醒：A、B、C 等 1 条')
  })

  it('汇总发送失败保留队列，下次 refresh 重试；成功后不再重复', () => {
    const h = harness({
      tasks: [
        makeTask({ id: 'u', importance: 'urgent', title: '紧急任务' }),
        makeTask({ id: 'n1', title: 'A', dueAt: BASE + MINUTE }),
      ],
    })
    h.offer({ taskId: 'n1', dueAt: BASE + MINUTE, phase: 'soon', text: 'x' })
    h.setTasks([makeTask({ id: 'n1', title: 'A', dueAt: BASE + MINUTE })])

    h.setBubbleOk(false)
    h.hud.refresh(BASE + MINUTE)
    expect(h.bubbles).toEqual([])
    expect(h.hud.getState(BASE + MINUTE).queued).toBe(1)

    h.setBubbleOk(true)
    h.hud.refresh(BASE + 2 * MINUTE)
    expect(h.bubbles.map((bubble) => bubble.text)).toEqual(['还有 1 条任务提醒：A'])
    expect(h.hud.getState(BASE + 2 * MINUTE).queued).toBe(0)

    // 已清队，不再重复汇总
    h.hud.refresh(BASE + 3 * MINUTE)
    expect(h.bubbles).toHaveLength(1)
  })

  it('已显示汇总中的任务被搁置：撤下旧气泡，按剩余项重建；全部失效则不再显示', () => {
    const h = harness({
      tasks: [
        makeTask({ id: 'u', importance: 'urgent', title: '紧急任务' }),
        makeTask({ id: 'n1', title: 'A', dueAt: BASE + MINUTE }),
        makeTask({ id: 'n2', title: 'B', dueAt: BASE + 2 * MINUTE }),
      ],
    })
    h.offer({ taskId: 'n1', dueAt: BASE + MINUTE, phase: 'soon', text: 'x' })
    h.offer({ taskId: 'n2', dueAt: BASE + 2 * MINUTE, phase: 'soon', text: 'x' })
    h.setTasks([
      makeTask({ id: 'n1', title: 'A', dueAt: BASE + MINUTE }),
      makeTask({ id: 'n2', title: 'B', dueAt: BASE + 2 * MINUTE }),
    ])
    h.hud.refresh(BASE + MINUTE)
    expect(h.bubbles).toHaveLength(1)
    expect(h.dismissed).toEqual([])

    // 搁置 A → 旧汇总撤下，重建 B（在同一 8 秒展示窗口内）
    h.setTasks([
      makeTask({ id: 'n1', title: 'A', dueAt: BASE + MINUTE, archivedAt: BASE + MINUTE }),
      makeTask({ id: 'n2', title: 'B', dueAt: BASE + 2 * MINUTE }),
    ])
    h.hud.refresh(BASE + MINUTE + 2000)
    expect(h.dismissed).toEqual(['bubble-1'])
    expect(h.bubbles.at(-1)?.text).toBe('还有 1 条任务提醒：B')

    // 再删除 B → 撤下汇总且不再重建
    h.setTasks([])
    h.hud.refresh(BASE + MINUTE + 4000)
    expect(h.dismissed).toEqual(['bubble-1', 'bubble-2'])
    expect(h.bubbles).toHaveLength(2)
  })

  it('dropQueued 撤下包含该任务的已显示汇总并按剩余项重建', () => {
    const h = harness({
      tasks: [
        makeTask({ id: 'u', importance: 'urgent' }),
        makeTask({ id: 'n1', title: 'A', dueAt: BASE + MINUTE }),
        makeTask({ id: 'n2', title: 'B', dueAt: BASE + 2 * MINUTE }),
      ],
    })
    h.offer({ taskId: 'n1', dueAt: BASE + MINUTE, phase: 'soon', text: 'x' })
    h.offer({ taskId: 'n2', dueAt: BASE + 2 * MINUTE, phase: 'soon', text: 'x' })
    h.setTasks([
      makeTask({ id: 'n1', title: 'A', dueAt: BASE + MINUTE }),
      makeTask({ id: 'n2', title: 'B', dueAt: BASE + 2 * MINUTE }),
    ])
    h.hud.refresh(BASE + MINUTE)
    expect(h.bubbles.at(-1)?.text).toBe('还有 2 条任务提醒：A、B')

    h.hud.dropQueued(['n1'])
    expect(h.dismissed).toEqual(['bubble-1'])
    h.hud.syncTasks(BASE + 2 * MINUTE)
    expect(h.bubbles.at(-1)?.text).toBe('还有 1 条任务提醒：B')
  })

  it('任务改 dueAt / 完成 / 删除后 syncTasks 过滤失效队列项', () => {
    const h = harness({
      tasks: [
        makeTask({ id: 'u', importance: 'urgent' }),
        makeTask({ id: 'n1', title: 'A', dueAt: BASE + MINUTE }),
        makeTask({ id: 'n2', title: 'B', dueAt: BASE + 2 * MINUTE }),
        makeTask({ id: 'n3', title: 'C', dueAt: BASE + 3 * MINUTE }),
      ],
    })
    h.offer({ taskId: 'n1', dueAt: BASE + MINUTE, phase: 'soon', text: 'x' })
    h.offer({ taskId: 'n2', dueAt: BASE + 2 * MINUTE, phase: 'soon', text: 'x' })
    h.offer({ taskId: 'n3', dueAt: BASE + 3 * MINUTE, phase: 'soon', text: 'x' })
    expect(h.hud.getState(BASE).queued).toBe(3)

    h.setTasks([
      makeTask({ id: 'n1', title: 'A', dueAt: BASE + 9 * MINUTE }), // 改 dueAt
      makeTask({
        id: 'n2',
        title: 'B',
        dueAt: BASE + 2 * MINUTE,
        status: 'done',
        completedAt: BASE,
      }),
      // n3 删除
    ])
    h.hud.syncTasks(BASE + MINUTE)
    expect(h.hud.getState(BASE + MINUTE).queued).toBe(0)
    expect(h.bubbles).toEqual([])
  })

  it('只改备注/标题/重要性/提醒覆盖：dueAt 不变 → 保留排队项与已消费状态', () => {
    const dueAt = BASE + 5 * MINUTE
    const h = harness({
      tasks: [
        makeTask({ id: 'u', importance: 'urgent' }),
        makeTask({ id: 'n1', title: 'A', dueAt }),
      ],
    })
    h.offer({ taskId: 'n1', dueAt, phase: 'soon', text: 'x' })
    expect(h.hud.getState(BASE).queued).toBe(1)
    expect(h.consumed).toEqual([{ id: 'n1', phase: 'soon', at: BASE }])

    // 模拟 tasks:update 改备注/标题/重要性/提醒覆盖（dueAt 不变）→ syncTasks 不清队列
    h.setTasks([
      makeTask({ id: 'u', importance: 'urgent' }),
      makeTask({
        id: 'n1',
        title: 'A（改标题）',
        note: '改备注',
        importance: 'high',
        reminderLeadMinOverride: 30,
        dueAt,
      }),
    ])
    h.hud.syncTasks(BASE + MINUTE)
    expect(h.hud.getState(BASE + MINUTE).queued).toBe(1)
    // 已消费状态未被重置（没有新的 consumeReminder 调用）
    expect(h.consumed).toEqual([{ id: 'n1', phase: 'soon', at: BASE }])
  })
})

describe('shouldInvalidateQueuedBeforeUpdate（P2：编辑不误清提醒）', () => {
  const DUE = BASE + 5 * MINUTE
  const base = makeTask({ id: 'n1', title: 'A', dueAt: DUE })

  it('dueAt 不变：标题/备注/重要性/提醒覆盖变更都不作废队列', () => {
    for (const after of [
      { ...base, title: 'A2' },
      { ...base, note: '备注' },
      { ...base, importance: 'urgent' as const },
      { ...base, reminderLeadMinOverride: 30 },
      { ...base, reminderLeadMinOverride: null },
    ]) {
      expect(shouldInvalidateQueuedBeforeUpdate(base, after)).toBe(false)
    }
    expect(shouldInvalidateQueuedBeforeUpdate(base, { ...base })).toBe(false)
  })

  it('dueAt 变化（含清空）才作废队列', () => {
    expect(shouldInvalidateQueuedBeforeUpdate(base, { ...base, dueAt: DUE + MINUTE })).toBe(true)
    expect(shouldInvalidateQueuedBeforeUpdate(base, { ...base, dueAt: null })).toBe(true)
  })

  it('任务失效/状态变化也作废（完成、搁置；防御 update 不改这些）', () => {
    expect(
      shouldInvalidateQueuedBeforeUpdate(base, {
        ...base,
        status: 'done',
        completedAt: BASE,
      }),
    ).toBe(true)
    expect(shouldInvalidateQueuedBeforeUpdate(base, { ...base, archivedAt: BASE })).toBe(true)
    const done = { ...base, status: 'done' as const, completedAt: BASE }
    expect(shouldInvalidateQueuedBeforeUpdate(done, { ...done, title: 'B' })).toBe(true)
  })
})
