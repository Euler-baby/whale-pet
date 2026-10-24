/**
 * 任务清单纯函数单测 · Agent-Data（0.4.0 / docs/35 §2、§4；docs/37 T/N 相关项）
 *
 * 覆盖：创建/补丁/完成/搁置、提醒两阶段消费与迁移映射、视图筛选/计数/排序、
 * 今日谓词、HUD 候选、统计五字段、倒计时文案。
 */
import { describe, expect, it } from 'vitest'

import {
  applyTaskArchived,
  applyTaskPatch,
  computeTaskStats,
  computeViewCounts,
  countdownLevel,
  createReminderState,
  createTask,
  dueReminderFor,
  effectiveReminderLeadMinutes,
  formatCountdown,
  formatDueAt,
  HUD_MAX_SHOWN,
  HUD_QUEUE_MAX,
  HUD_QUEUE_TTL_MS,
  isHudCandidate,
  isTaskInTodayView,
  isTaskOverdue,
  isValidReminderLeadMin,
  markReminderConsumed,
  matchesTaskView,
  migrateReminderState,
  normalizeNote,
  normalizeProjectName,
  normalizeProjectNote,
  normalizeTitle,
  reminderText,
  selectHudTasks,
  selectTaskList,
  setTaskDone,
  sortTasks,
  sortTasksForView,
  TASK_DND_END,
  TASK_DND_START,
  type TaskReminderPhase,
} from '@shared/tasks'
import type { Project, Task } from '@shared/types'

/** 2026-10-21（周三）10:00 本地时间 */
const NOW = new Date(2026, 9, 21, 10, 0, 0).getTime()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function at(hour: number, minute = 0, day = 21): number {
  return new Date(2026, 9, day, hour, minute, 0).getTime()
}

function makeTask(overrides: Partial<Task> = {}): Task {
  const base = createTask({ title: '写周报', category: 'study' }, NOW, overrides.id ?? 'task-1')
  const merged: Task = { ...base, ...overrides }
  // 夹具保持 store 不变量：reminderState.dueAt 必须与 dueAt 一致
  return {
    ...merged,
    reminderState: overrides.reminderState ?? {
      dueAt: merged.dueAt,
      soonConsumedAt: null,
      dueConsumedAt: null,
    },
  }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return { id: 'proj-1', name: '项目一', note: null, createdAt: NOW, updatedAt: NOW, ...overrides }
}

function ids(tasks: readonly Task[], now = NOW): string[] {
  return sortTasks(tasks, now).map((task) => task.id)
}

/** 直接构造项目任务（createTask 会自动 XOR） */
function makeProjectTask(overrides: Partial<Task> = {}): Task {
  return makeTask({ category: null, projectId: 'proj-1', ...overrides })
}

// ---------------------------------------------------------------------------

describe('归一化', () => {
  it('标题合并空白并截断；空标题 null', () => {
    expect(normalizeTitle('  写   周报  ')).toBe('写 周报')
    expect(normalizeTitle('   ')).toBeNull()
    expect(normalizeTitle('x'.repeat(200))).toHaveLength(80)
  })

  it('备注/项目名/项目备注', () => {
    expect(normalizeNote('  ')).toBeNull()
    expect(normalizeNote('备注')).toBe('备注')
    expect(normalizeProjectName('  学习   计划 ')).toBe('学习 计划')
    expect(normalizeProjectName('   ')).toBeNull()
    expect(normalizeProjectNote('x'.repeat(300))).toHaveLength(200)
  })

  it('提醒提前量只接受 1–1440 整数', () => {
    expect(isValidReminderLeadMin(1)).toBe(true)
    expect(isValidReminderLeadMin(1440)).toBe(true)
    expect(isValidReminderLeadMin(0)).toBe(false)
    expect(isValidReminderLeadMin(1441)).toBe(false)
    expect(isValidReminderLeadMin(1.5)).toBe(false)
    expect(isValidReminderLeadMin('15')).toBe(false)
  })
})

describe('createTask（0.4 新字段）', () => {
  it('默认：未搁置、无覆盖、空消费状态', () => {
    const task = makeTask()
    expect(task).toMatchObject({
      category: 'study',
      projectId: null,
      archivedAt: null,
      reminderLeadMinOverride: null,
      status: 'todo',
      dueAt: null,
    })
    expect(task.reminderState).toEqual({ dueAt: null, soonConsumedAt: null, dueConsumedAt: null })
  })

  it('项目任务 XOR：category=null + projectId；冲突拒绝', () => {
    const projectTask = createTask({ title: '项目任务', projectId: 'proj-1' }, NOW, 'p1')
    expect(projectTask).toMatchObject({ category: null, projectId: 'proj-1' })
    expect(() =>
      createTask({ title: '冲突', category: 'study', projectId: 'proj-1' }, NOW, 'p2'),
    ).toThrow('项目任务不能设置分类')
  })

  it('dueAt 与 reminderState 同步；覆盖值校验', () => {
    const withDue = createTask({ title: '有截止', dueAt: at(18) }, NOW, 't1')
    expect(withDue.reminderState.dueAt).toBe(at(18))
    expect(withDue.reminderLeadMinOverride).toBeNull()

    const withOverride = createTask(
      { title: '自定义提醒', dueAt: at(18), reminderLeadMinOverride: 5 },
      NOW,
      't2',
    )
    expect(withOverride.reminderLeadMinOverride).toBe(5)

    expect(() => createTask({ title: '非法覆盖', reminderLeadMinOverride: 0 }, NOW, 't3')).toThrow(
      '提醒提前量必须是 1–1440 的整数分钟',
    )
  })

  it('拒绝空标题', () => {
    expect(() => createTask({ title: '   ' }, NOW, 'x')).toThrow('任务标题不能为空')
  })
})

describe('applyTaskPatch', () => {
  it('改 dueAt 清空 remindedAt 并重置两阶段消费状态', () => {
    const task = makeTask({
      dueAt: at(18),
      remindedAt: at(17),
      reminderState: { dueAt: at(18), soonConsumedAt: at(17), dueConsumedAt: null },
    })
    const patched = applyTaskPatch(task, { dueAt: at(19) }, NOW + 1_000)
    expect(patched.dueAt).toBe(at(19))
    expect(patched.remindedAt).toBeNull()
    expect(patched.reminderState).toEqual({
      dueAt: at(19),
      soonConsumedAt: null,
      dueConsumedAt: null,
    })
    expect(patched.updatedAt).toBe(NOW + 1_000)
  })

  it('dueAt 不变时保留消费状态', () => {
    const task = makeTask({
      dueAt: at(18),
      reminderState: { dueAt: at(18), soonConsumedAt: at(17), dueConsumedAt: null },
    })
    const patched = applyTaskPatch(task, { dueAt: at(18), title: '改标题' }, NOW + 1_000)
    expect(patched.reminderState.soonConsumedAt).toBe(at(17))
    expect(patched.title).toBe('改标题')
  })

  it('reminderLeadMinOverride 可设置/清空/校验', () => {
    const task = makeTask()
    expect(applyTaskPatch(task, { reminderLeadMinOverride: 30 }, NOW).reminderLeadMinOverride).toBe(
      30,
    )
    const withValue = applyTaskPatch(task, { reminderLeadMinOverride: 30 }, NOW)
    expect(
      applyTaskPatch(withValue, { reminderLeadMinOverride: null }, NOW).reminderLeadMinOverride,
    ).toBeNull()
    expect(() => applyTaskPatch(task, { reminderLeadMinOverride: 1441 }, NOW)).toThrow(
      '提醒提前量必须是 1–1440 的整数分钟',
    )
  })
})

describe('完成与搁置状态机', () => {
  it('完成写入 completedAt 并清 archivedAt（T-11）', () => {
    const archived = makeTask({ archivedAt: at(9) })
    const done = setTaskDone(archived, true, NOW)
    expect(done).toMatchObject({ status: 'done', completedAt: NOW, archivedAt: null })
  })

  it('取消完成重置 remindedAt 与两阶段消费状态，不自动搁置', () => {
    const task = makeTask({
      dueAt: at(18),
      status: 'done',
      completedAt: at(9),
      remindedAt: at(17),
      reminderState: { dueAt: at(18), soonConsumedAt: at(17), dueConsumedAt: at(18) },
    })
    const reopened = setTaskDone(task, false, NOW)
    expect(reopened).toMatchObject({ status: 'todo', completedAt: null, remindedAt: null })
    expect(reopened.archivedAt).toBeNull()
    expect(reopened.reminderState).toEqual({
      dueAt: at(18),
      soonConsumedAt: null,
      dueConsumedAt: null,
    })
  })

  it('搁置仅 todo；done 拒绝 TASK_NOT_ACTIVE', () => {
    const task = makeTask()
    expect(applyTaskArchived(task, true, NOW).archivedAt).toBe(NOW)
    expect(() =>
      applyTaskArchived(makeTask({ status: 'done', completedAt: NOW }), true, NOW),
    ).toThrow('TASK_NOT_ACTIVE')
  })

  it('重复搁置不改原 archivedAt；恢复只清 archivedAt 保留 dueAt/消费标记', () => {
    const archived = applyTaskArchived(makeTask({ dueAt: at(18) }), true, NOW)
    expect(applyTaskArchived(archived, true, NOW + 1_000).archivedAt).toBe(NOW)

    const withConsumed: Task = {
      ...archived,
      reminderState: { dueAt: at(18), soonConsumedAt: at(17), dueConsumedAt: null },
    }
    const restored = applyTaskArchived(withConsumed, false, NOW + 2_000)
    expect(restored.archivedAt).toBeNull()
    expect(restored.dueAt).toBe(at(18))
    expect(restored.reminderState.soonConsumedAt).toBe(at(17))
  })
})

describe('提醒两阶段状态与迁移映射', () => {
  it('migrateReminderState：null/早于 due/不早于 due/无 due', () => {
    expect(migrateReminderState(null, 123)).toEqual({
      dueAt: null,
      soonConsumedAt: null,
      dueConsumedAt: null,
    })
    expect(migrateReminderState(at(18), null)).toEqual({
      dueAt: at(18),
      soonConsumedAt: null,
      dueConsumedAt: null,
    })
    expect(migrateReminderState(at(18), at(17))).toEqual({
      dueAt: at(18),
      soonConsumedAt: at(17),
      dueConsumedAt: null,
    })
    expect(migrateReminderState(at(18), at(18))).toEqual({
      dueAt: at(18),
      soonConsumedAt: at(18),
      dueConsumedAt: at(18),
    })
    expect(migrateReminderState(at(18), at(19))).toEqual({
      dueAt: at(18),
      soonConsumedAt: at(19),
      dueConsumedAt: at(19),
    })
  })

  it('markReminderConsumed：单阶段幂等；due 补 soon', () => {
    const empty = createReminderState(at(18))
    const soon = markReminderConsumed(empty, 'soon', at(17))
    expect(soon).toEqual({ dueAt: at(18), soonConsumedAt: at(17), dueConsumedAt: null })
    expect(markReminderConsumed(soon, 'soon', at(17) + 1)).toEqual(soon)

    const due = markReminderConsumed(soon, 'due', at(18))
    expect(due).toEqual({ dueAt: at(18), soonConsumedAt: at(17), dueConsumedAt: at(18) })

    const directDue = markReminderConsumed(empty, 'due', at(18))
    expect(directDue).toEqual({ dueAt: at(18), soonConsumedAt: at(18), dueConsumedAt: at(18) })
    expect(markReminderConsumed(directDue, 'due', at(19))).toEqual(directDue)
  })

  it('有效提前量：任务覆盖 > 全局自定义 > 旧预设', () => {
    const settings = { reminderLeadMin: 15 as const, customReminderLeadMin: 60 }
    expect(effectiveReminderLeadMinutes(makeTask({ reminderLeadMinOverride: 5 }), settings)).toBe(5)
    expect(effectiveReminderLeadMinutes(makeTask(), settings)).toBe(60)
    expect(
      effectiveReminderLeadMinutes(makeTask(), {
        reminderLeadMin: 30,
        customReminderLeadMin: null,
      }),
    ).toBe(30)
  })

  it('dueReminderFor：soon/due 独立去重，不追补旧 soon', () => {
    const task = makeTask({ dueAt: at(18) })
    // 提前量 15 分钟：17:45 进入 soon
    expect(dueReminderFor(task, at(17, 44), 15 * MINUTE)).toBeNull()
    expect(dueReminderFor(task, at(17, 45), 15 * MINUTE)).toBe('soon')

    const soonConsumed: Task = {
      ...task,
      reminderState: { dueAt: at(18), soonConsumedAt: at(17, 45), dueConsumedAt: null },
    }
    expect(dueReminderFor(soonConsumed, at(17, 50), 15 * MINUTE)).toBeNull()
    // 到期不受 soon 消费影响
    expect(dueReminderFor(soonConsumed, at(18), 15 * MINUTE)).toBe('due')

    const dueConsumed: Task = {
      ...soonConsumed,
      reminderState: { dueAt: at(18), soonConsumedAt: at(17, 45), dueConsumedAt: at(18) },
    }
    expect(dueReminderFor(dueConsumed, at(18, 30), 15 * MINUTE)).toBeNull()

    // 改为更小的提前量不清消费标记：soon 仍视为已消费
    expect(dueReminderFor(soonConsumed, at(17, 59), 5 * MINUTE)).toBeNull()
  })

  it('dueReminderFor：无截止/已完成/搁置不调度', () => {
    expect(dueReminderFor(makeTask(), NOW)).toBeNull()
    expect(
      dueReminderFor(makeTask({ dueAt: at(18), status: 'done', completedAt: NOW }), at(18)),
    ).toBeNull()
    expect(dueReminderFor(makeTask({ dueAt: at(18), archivedAt: at(9) }), at(18))).toBeNull()
  })

  it('提醒文案与长标题截断', () => {
    const task = makeTask({ dueAt: at(18) })
    expect(reminderText(task, 'soon' as TaskReminderPhase, at(17, 45))).toBe(
      '「写周报」还有 15 分钟',
    )
    expect(reminderText(task, 'due', at(18))).toBe('「写周报」已到期')
    const longTitle = makeTask({ title: '这是一个特别特别特别特别特别长的任务标题用于截断' })
    expect(reminderText(longTitle, 'due', NOW).length).toBeLessThanOrEqual(24)
  })
})

describe('今日谓词', () => {
  it('非项目任务：今天到期/已过期/无时间进今日，未来不进', () => {
    expect(isTaskInTodayView(makeTask({ dueAt: at(18) }), NOW)).toBe(true)
    expect(isTaskInTodayView(makeTask({ dueAt: at(8) }), NOW)).toBe(true)
    expect(isTaskInTodayView(makeTask(), NOW)).toBe(true)
    expect(isTaskInTodayView(makeTask({ dueAt: at(9, 0, 22) }), NOW)).toBe(false)
  })

  it('已完成按业务日：今天完成进今日，昨天完成不进', () => {
    expect(isTaskInTodayView(makeTask({ status: 'done', completedAt: at(9) }), NOW)).toBe(true)
    expect(isTaskInTodayView(makeTask({ status: 'done', completedAt: at(9, 0, 20) }), NOW)).toBe(
      false,
    )
  })

  it('项目任务：紧急或今天到期/过期进今日；未来/无截止非紧急不进', () => {
    expect(isTaskInTodayView(makeProjectTask({ dueAt: at(18) }), NOW)).toBe(true)
    expect(isTaskInTodayView(makeProjectTask({ dueAt: at(9) }), NOW)).toBe(true)
    expect(isTaskInTodayView(makeProjectTask({ importance: 'urgent' }), NOW)).toBe(true)
    expect(
      isTaskInTodayView(makeProjectTask({ importance: 'urgent', dueAt: at(9, 0, 25) }), NOW),
    ).toBe(true)
    expect(isTaskInTodayView(makeProjectTask({ dueAt: at(9, 0, 22) }), NOW)).toBe(false)
    expect(isTaskInTodayView(makeProjectTask(), NOW)).toBe(false)
  })

  it('isTaskOverdue 只对未完成 todo 生效（含搁置，供全局统计）', () => {
    expect(isTaskOverdue(makeTask({ dueAt: at(9) }), NOW)).toBe(true)
    expect(isTaskOverdue(makeTask({ dueAt: at(9), archivedAt: at(8) }), NOW)).toBe(true)
    expect(isTaskOverdue(makeTask({ dueAt: at(9), status: 'done', completedAt: at(9) }), NOW)).toBe(
      false,
    )
  })
})

describe('排序（活动/完成/搁置）', () => {
  it('活动：紧急置顶 → 到期桶 → dueAt → 重要性 → createdAt → id', () => {
    const overdue = makeTask({ id: 'a', dueAt: at(8) })
    const soon = makeTask({ id: 'b', dueAt: at(12) })
    const later = makeTask({ id: 'c', dueAt: at(18) })
    const noDueHigh = makeTask({ id: 'd', importance: 'high' })
    const urgentFuture = makeTask({ id: 'e', importance: 'urgent', dueAt: at(9, 0, 25) })
    expect(ids([overdue, soon, later, noDueHigh, urgentFuture])).toEqual(['e', 'a', 'b', 'c', 'd'])
  })

  it('活动：同 dueAt 按重要性 → createdAt → id', () => {
    const low = makeTask({ id: 'c', dueAt: at(18), importance: 'low' })
    const highA = makeTask({ id: 'a', dueAt: at(18), importance: 'high' })
    const highB = makeTask({ id: 'b', dueAt: at(18), importance: 'high' })
    expect(ids([low, highB, highA])).toEqual(['a', 'b', 'c'])
  })

  it('已完成按 completedAt 倒序（null 回退 0）→ createdAt → id', () => {
    const oldDone = makeTask({ id: 'a', status: 'done', completedAt: at(9) })
    const newDone = makeTask({ id: 'b', status: 'done', completedAt: at(11) })
    const legacyDone = makeTask({ id: 'c', status: 'done', completedAt: null })
    expect(
      sortTasksForView([oldDone, newDone, legacyDone], 'completed', NOW).map((task) => task.id),
    ).toEqual(['b', 'a', 'c'])
  })

  it('搁置按 archivedAt 倒序 → createdAt → id', () => {
    const first = makeTask({ id: 'a', archivedAt: at(9) })
    const later = makeTask({ id: 'b', archivedAt: at(11) })
    const sameCreated = NOW - 1_000
    const tieB = makeTask({ id: 'd', archivedAt: at(12), createdAt: sameCreated })
    const tieA = makeTask({ id: 'c', archivedAt: at(12), createdAt: sameCreated })
    expect(sortTasksForView([first, later, tieB, tieA], 'archived', NOW).map((t) => t.id)).toEqual([
      'c',
      'd',
      'b',
      'a',
    ])
  })

  it('matchesTaskView', () => {
    expect(matchesTaskView(makeTask(), 'active')).toBe(true)
    expect(matchesTaskView(makeTask({ archivedAt: at(9) }), 'active')).toBe(false)
    expect(matchesTaskView(makeTask({ status: 'done', completedAt: NOW }), 'completed')).toBe(true)
    expect(matchesTaskView(makeTask({ archivedAt: at(9) }), 'archived')).toBe(true)
    expect(matchesTaskView(makeTask(), 'archived')).toBe(false)
  })
})

describe('视图计数与选择', () => {
  const active = makeTask({ id: 'active', dueAt: at(9) }) // 逾期活动
  const activeFuture = makeTask({ id: 'active-future', dueAt: at(9, 0, 25) })
  const done = makeTask({ id: 'done', status: 'done', completedAt: at(9) })
  const archived = makeTask({ id: 'archived', archivedAt: at(8), dueAt: at(9) })
  const projectActive = makeProjectTask({ id: 'project', dueAt: at(18) })

  it('computeViewCounts：scope+分类后、view 前计数；逾期只计活动', () => {
    expect(computeViewCounts([active, activeFuture, done, archived, projectActive], NOW)).toEqual({
      active: 3,
      completed: 1,
      archived: 1,
      overdue: 1,
    })
  })

  it('selectTaskList：view 未提供时兼容旧调用（不加状态过滤、活动排序）', () => {
    const result = selectTaskList([active, done, archived], { scope: 'all' }, NOW)
    expect(result.viewCounts).toBeUndefined()
    // 旧排序：未完成在前（搁置仍是 todo），已完成在后
    expect(result.tasks.map((task) => task.id)).toEqual(['active', 'archived', 'done'])
  })

  it('selectTaskList：view 过滤 + viewCounts（应用 view 前计数）', () => {
    const result = selectTaskList(
      [active, activeFuture, done, archived],
      { scope: 'all', view: 'active' },
      NOW,
    )
    expect(result.tasks.map((task) => task.id)).toEqual(['active', 'active-future'])
    expect(result.viewCounts).toEqual({ active: 2, completed: 1, archived: 1, overdue: 1 })
  })

  it('selectTaskList：category=null 混排、project 只取项目任务、具体分类过滤', () => {
    const tasks = [
      makeTask({ id: 'life', category: 'life' }),
      makeTask({ id: 'study' }),
      projectActive,
    ]
    expect(
      selectTaskList(tasks, { scope: 'all', category: null }, NOW)
        .tasks.map((task) => task.id)
        .sort(),
    ).toEqual(['life', 'project', 'study'])
    expect(
      selectTaskList(tasks, { scope: 'all', category: 'project' }, NOW).tasks.map(
        (task) => task.id,
      ),
    ).toEqual(['project'])
    expect(
      selectTaskList(tasks, { scope: 'all', category: 'life' }, NOW).tasks.map((task) => task.id),
    ).toEqual(['life'])
    // 省略 category = 旧调用，不加分类过滤
    expect(selectTaskList(tasks, { scope: 'all' }, NOW).tasks).toHaveLength(3)
  })

  it('selectTaskList：scope=today 叠加今日谓词；project+viewScope=today 再筛', () => {
    const future = makeTask({ id: 'future', dueAt: at(9, 0, 25) })
    const today = makeTask({ id: 'today', dueAt: at(18) })
    expect(selectTaskList([future, today], { scope: 'today' }, NOW).tasks.map((t) => t.id)).toEqual(
      ['today'],
    )

    const projectFuture = makeProjectTask({ id: 'p-future', dueAt: at(9, 0, 25) })
    const projectToday = makeProjectTask({ id: 'p-today', dueAt: at(18) })
    expect(
      selectTaskList(
        [projectFuture, projectToday],
        { scope: 'project', projectId: 'proj-1', viewScope: 'today' },
        NOW,
      ).tasks.map((t) => t.id),
    ).toEqual(['p-today'])
    // 不传 viewScope 时项目 scope 返回全部项目任务
    expect(
      selectTaskList([projectFuture, projectToday], { scope: 'project', projectId: 'proj-1' }, NOW)
        .tasks,
    ).toHaveLength(2)
  })
})

describe('任务统计（0.4 五字段）', () => {
  it('只返回 todayKey/todayTotal/todayDone/overdue/totalTodo', () => {
    const tasks: Task[] = [
      makeTask({ id: 'a', dueAt: at(18) }),
      makeTask({ id: 'b', dueAt: at(8) }),
      makeTask({ id: 'c', status: 'done', completedAt: at(9) }),
      makeTask({ id: 'd', dueAt: at(9, 0, 25) }),
      makeTask({ id: 'e', archivedAt: at(7) }),
    ]
    const stats = computeTaskStats(tasks, NOW)
    expect(stats).toEqual({
      todayKey: '2026-10-21',
      // 0.4.2：搁置任务不占今日分母（e 被排除）
      todayTotal: 3,
      todayDone: 1,
      // totalTodo/overdue 仍为全局口径（含搁置）
      overdue: 1,
      totalTodo: 4,
    })
    expect(Object.keys(stats).sort()).toEqual([
      'overdue',
      'todayDone',
      'todayKey',
      'todayTotal',
      'totalTodo',
    ])
  })

  it('搁置任务不占今日分子/分母；恢复后回升；totalTodo/overdue 仍含搁置（0.4.2）', () => {
    const normalDone = makeTask({ id: 'done', status: 'done', completedAt: at(9) })
    const normalTodo = makeTask({ id: 'todo', dueAt: at(18) })
    // 搁置未完成：今日到期（原谓词本会进今日）且已逾期
    const archivedUndone = makeTask({ id: 'arch', archivedAt: at(9), dueAt: at(8) })
    // 防御夹具：store 不会产生 done+archived，但统计层也必须排除，避免分子混入
    const archivedDone = makeTask({
      id: 'archDone',
      status: 'done',
      completedAt: at(9),
      archivedAt: at(9),
    })

    const stats = computeTaskStats([normalDone, normalTodo, archivedUndone, archivedDone], NOW)
    expect(stats.todayTotal).toBe(2) // normalDone + normalTodo
    expect(stats.todayDone).toBe(1) // 仅 normalDone
    expect(stats.totalTodo).toBe(2) // normalTodo + archivedUndone（搁置仍算全局 todo）
    expect(stats.overdue).toBe(1) // archivedUndone（全局逾期含搁置）

    // 恢复搁置的未完成任务 → 重新占今日分母（dueAt 保留，仍属今日）
    const restoredUndone = applyTaskArchived(archivedUndone, false, NOW + 1_000)
    expect(restoredUndone.archivedAt).toBeNull()
    const afterRestoreUndone = computeTaskStats(
      [normalDone, normalTodo, restoredUndone, archivedDone],
      NOW,
    )
    expect(afterRestoreUndone.todayTotal).toBe(3)
    expect(afterRestoreUndone.todayDone).toBe(1)
    expect(afterRestoreUndone.totalTodo).toBe(2)
    expect(afterRestoreUndone.overdue).toBe(1)

    // 防御：恢复一个 done+archived 夹具 → 今日分子/分母都回升
    const restoredDone = { ...archivedDone, archivedAt: null }
    const afterRestoreDone = computeTaskStats([normalDone, normalTodo, restoredDone], NOW)
    expect(afterRestoreDone.todayTotal).toBe(3)
    expect(afterRestoreDone.todayDone).toBe(2)
  })
})

describe('HUD 候选（0.4：搁置排除）', () => {
  it('常量与契约一致', () => {
    expect(HUD_MAX_SHOWN).toBe(3)
    expect(HUD_QUEUE_MAX).toBe(5)
    expect(HUD_QUEUE_TTL_MS).toBe(10 * MINUTE)
    expect(TASK_DND_START).toBe('23:00')
    expect(TASK_DND_END).toBe('07:00')
  })

  it('isHudCandidate：紧急/今日到期，但完成和搁置都不算', () => {
    expect(isHudCandidate(makeTask({ importance: 'urgent' }), 'urgent', NOW)).toBe(true)
    expect(
      isHudCandidate(makeTask({ importance: 'urgent', archivedAt: at(9) }), 'urgent', NOW),
    ).toBe(false)
    expect(
      isHudCandidate(
        makeTask({ importance: 'urgent', status: 'done', completedAt: at(9) }),
        'urgent',
        NOW,
      ),
    ).toBe(false)
    expect(isHudCandidate(makeProjectTask({ dueAt: at(18) }), 'urgent-due', NOW)).toBe(true)
    expect(
      isHudCandidate(makeProjectTask({ dueAt: at(18), archivedAt: at(9) }), 'urgent-due', NOW),
    ).toBe(false)
  })

  it('selectHudTasks：排序/项目名/最多 3 条 + total', () => {
    const projects = [makeProject({ id: 'proj-1', name: '项目一' })]
    const tasks = [
      makeProjectTask({ id: 'p', importance: 'urgent', title: '项目紧急' }),
      makeTask({ id: 'n', importance: 'urgent', title: '普通紧急' }),
      makeTask({ id: 'u1', importance: 'urgent', dueAt: at(12) }),
      makeTask({ id: 'u2', importance: 'urgent', dueAt: at(13) }),
    ]
    const result = selectHudTasks(tasks, projects, 'urgent', NOW)
    expect(result.total).toBe(4)
    expect(result.tasks).toHaveLength(3)
    // dueAt 升序：u1、u2，然后无截止按 id 字典序（n < p）
    expect(result.tasks.map((task) => task.id)).toEqual(['u1', 'u2', 'n'])
    expect(
      selectHudTasks([makeProjectTask({ importance: 'urgent' })], projects, 'urgent', NOW).tasks[0],
    ).toMatchObject({ projectName: '项目一', category: null })
  })
})

describe('倒计时与到期文案', () => {
  it('countdownLevel 边界', () => {
    expect(countdownLevel(null, NOW)).toBe('none')
    expect(countdownLevel(NOW - 1, NOW)).toBe('overdue')
    expect(countdownLevel(NOW, NOW)).toBe('imminent')
    expect(countdownLevel(NOW + HOUR - 1, NOW)).toBe('imminent')
    expect(countdownLevel(NOW + HOUR, NOW)).toBe('soon')
    expect(countdownLevel(NOW + DAY - 1, NOW)).toBe('soon')
    expect(countdownLevel(NOW + DAY, NOW)).toBe('far')
  })

  it('formatCountdown / formatDueAt', () => {
    expect(formatCountdown(null, NOW)).toBe('无截止')
    expect(formatCountdown(NOW, NOW)).toBe('还剩 不到 1 分钟')
    expect(formatCountdown(NOW + MINUTE + 1, NOW)).toBe('还剩 2 分钟')
    expect(formatCountdown(NOW + HOUR, NOW)).toBe('还剩 1 小时')
    expect(formatCountdown(NOW + DAY, NOW)).toBe('还剩 1 天')
    expect(formatCountdown(NOW - MINUTE, NOW)).toBe('已过期 1 分钟')
    expect(formatDueAt(null, NOW)).toBe('无时间')
    expect(formatDueAt(at(18), NOW)).toBe('今天 18:00')
    expect(formatDueAt(at(9, 0, 22), NOW)).toBe('明天 09:00')
    expect(formatDueAt(at(9), NOW)).toBe('今天 09:00 已过期')
  })
})
