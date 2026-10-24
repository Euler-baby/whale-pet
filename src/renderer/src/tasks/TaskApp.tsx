/**
 * 任务清单主界面（0.4.2；docs/40）
 *
 * - 一级导航：待办 / 打卡。待办不再有「活动/已完成/搁置」状态 tabs。
 * - 单一列表：当前 scope/分类下所有**未搁置**任务（含已完成；已完成划掉、可取消完成），
 *   排序沿用 shared sortTasks。
 * - 摘要右侧「搁置 N」打开独立「搁置任务清单」（scope:'all' + view:'archived' + category:null，
 *   全部搁置任务；可恢复/删除/返回待办），N 用该清单总数。
 * - 新建任务：不再顶部常驻 QuickAdd；右下角 FAB「+」打开底部面板，复用 QuickAdd，
 *   Esc/关闭按钮/点外部关闭，提交后可继续添加。
 * - 保留 scope/分类筛选、任务 CRUD/完成、删除 30 秒撤销、项目任务混排、保存失败草稿。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { sortTasks } from '@shared/tasks'
import type {
  Bootstrap,
  Habit,
  HabitCreateInput,
  HabitPatch,
  HabitSchedule,
  HabitSnapshot,
  Project,
  Settings,
  Task,
  TaskCategory,
  TaskCategorySelection,
  TaskCreateInput,
  TaskPatch,
  TaskScope,
  TaskStats,
  TaskViewCounts,
} from '@shared/types'

import HabitFormDialog from './habits/HabitFormDialog'
import HabitHistoryDialog from './habits/HabitHistoryDialog'
import HabitsPage from './habits/HabitsPage'
import ProjectDetail from './ProjectDetail'
import ProjectForm from './ProjectForm'
import ProjectList from './ProjectList'
import type { ProjectCardData } from './ProjectList'
import QuickAdd from './QuickAdd'
import type { QuickAddAttribution } from './QuickAdd'
import TaskEditor from './TaskEditor'
import TaskRows from './TaskRows'
import { DEFAULT_REMINDER_LEAD_MIN, describeError } from './format'

type Tab = 'todo' | 'habits'
type ScopeSelection = Extract<TaskScope, 'today' | 'all'>

interface UndoItem {
  id: string
  title: string
  expiresAt: number
}

interface ProjectDetailState {
  project: Project
  tasks: Task[]
  counts: TaskViewCounts
}

interface ProjectModalState {
  mode: 'create' | 'edit'
  project?: Project
}

interface HabitModalState {
  mode: 'create' | 'edit'
  habit?: Habit
}

interface Filters {
  tab: Tab
  scope: ScopeSelection
  category: TaskCategorySelection
  projectId: string | null
}

/** 分类导航顺序固定：学习 / 生活 / 运动 / 项目 */
const CATEGORY_OPTIONS: readonly { value: TaskCategory; label: string }[] = [
  { value: 'study', label: '学习' },
  { value: 'life', label: '生活' },
  { value: 'sport', label: '运动' },
]

const PRELOAD_ERROR = 'window.pet 未注入（preload 未生效），请重启应用'

/** bootstrap 单例（StrictMode 下只握手一次） */
let bootstrapOnce: Promise<Bootstrap> | null = null

function loadBootstrap(): Promise<Bootstrap> {
  const pet = window.pet
  if (!pet) return Promise.reject(new Error(PRELOAD_ERROR))
  bootstrapOnce ??= pet.bootstrap()
  return bootstrapOnce
}

/** 旧 settings 缺字段时回退默认（0.4：customReminderLeadMin 缺省 null） */
function normalizeSettings(settings: Settings): Settings {
  return {
    ...settings,
    hudScope: settings.hudScope ?? 'urgent',
    customReminderLeadMin: settings.customReminderLeadMin ?? null,
  }
}

function scheduleKey(schedule: HabitSchedule): string {
  return schedule.frequency === 'daily' ? 'daily' : `weekly:${String(schedule.deadlineWeekday)}`
}

/** scope 过滤后的任务集合 → 活动/已完成/搁置计数（搁置优先于完成） */
function viewCountsOf(tasks: readonly Task[], now: number): TaskViewCounts {
  let active = 0
  let completed = 0
  let archived = 0
  let overdue = 0
  for (const task of tasks) {
    if (task.archivedAt !== null) {
      archived += 1
      continue
    }
    if (task.status === 'done') {
      completed += 1
      continue
    }
    active += 1
    if (task.dueAt !== null && task.dueAt < now) overdue += 1
  }
  return { active, completed, archived, overdue }
}

/** 未搁置任务（含已完成）→ shared sortTasks 排序 */
function visibleTasksOf(tasks: readonly Task[], now: number): Task[] {
  return sortTasks(
    tasks.filter((task) => task.archivedAt === null),
    now,
  )
}

export default function TaskApp() {
  // 筛选（会话内保留；重开窗口回默认）
  const [tab, setTab] = useState<Tab>('todo')
  const [scope, setScope] = useState<ScopeSelection>('today')
  const [category, setCategory] = useState<TaskCategorySelection>('life')
  const [projectId, setProjectId] = useState<string | null>(null)

  // 数据
  const [tasks, setTasks] = useState<Task[]>([])
  const [archivedTasks, setArchivedTasks] = useState<Task[]>([])
  const [stats, setStats] = useState<TaskStats | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [projectCards, setProjectCards] = useState<ProjectCardData[]>([])
  const [projectTotals, setProjectTotals] = useState<Record<string, number>>({})
  const [detail, setDetail] = useState<ProjectDetailState | null>(null)
  const [habits, setHabits] = useState<HabitSnapshot[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)

  // 视图状态
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [deleted, setDeleted] = useState<UndoItem[]>([])
  const [editing, setEditing] = useState<Task | null>(null)
  const [projectModal, setProjectModal] = useState<ProjectModalState | null>(null)
  const [habitModal, setHabitModal] = useState<HabitModalState | null>(null)
  const [historyHabit, setHistoryHabit] = useState<Habit | null>(null)

  const actionBusy = useRef(false)
  const requestRef = useRef(0)
  const fabRef = useRef<HTMLButtonElement>(null)
  const previouslyComposerOpen = useRef(false)
  const filtersRef = useRef<Filters>({ tab, scope, category, projectId })
  filtersRef.current = { tab, scope, category, projectId }

  // 设置只用于表单“跟随默认”显示与 customReminderLeadMin 回退；事件同步保持最新
  useEffect(() => {
    let cancelled = false
    loadBootstrap()
      .then((bootstrap) => {
        if (!cancelled) setSettings(normalizeSettings(bootstrap.settings))
      })
      .catch((error: unknown) => {
        if (!cancelled) setActionError(`设置加载失败：${describeError(error)}`)
      })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * 待办数据：普通列表或项目列表/详情；返回当前主列表（用于判断新任务/恢复是否可见）。
   * 主列表只含未搁置任务（含已完成）；同时用「all + view:'archived' + category:null」取
   * 全部搁置任务（摘要按钮计数与独立搁置清单）。
   */
  const refreshTodo = useCallback(async (silent = false): Promise<Task[] | null> => {
    const pet = window.pet
    if (!pet) {
      setLoadError(PRELOAD_ERROR)
      setLoading(false)
      return null
    }
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    const current = filtersRef.current
    if (!silent) setLoading(true)
    setLoadError(null)
    const archivedQuery = () => pet.listTasks({ scope: 'all', view: 'archived', category: null })
    try {
      if (current.category === 'project') {
        // 项目列表/详情：projects 全量 + 全状态任务（删除资格）+ 全部搁置任务
        const [nextProjects, allSnapshot, archivedSnapshot] = await Promise.all([
          pet.listProjects(),
          pet.listTasks({ scope: 'all' }),
          archivedQuery(),
        ])
        if (requestRef.current !== requestId) return null
        const totals: Record<string, number> = {}
        for (const task of allSnapshot.tasks) {
          if (task.projectId === null) continue
          totals[task.projectId] = (totals[task.projectId] ?? 0) + 1
        }
        const stamp = Date.now()
        const query = (targetProjectId: string) =>
          pet.listTasks({
            scope: 'project',
            projectId: targetProjectId,
            viewScope: current.scope,
          })
        if (current.projectId !== null) {
          const snapshot = await query(current.projectId)
          if (requestRef.current !== requestId) return null
          const project = nextProjects.find((entry) => entry.id === current.projectId) ?? null
          const visible = visibleTasksOf(snapshot.tasks, stamp)
          setProjects(nextProjects)
          setProjectTotals(totals)
          setStats(allSnapshot.stats)
          setProjectCards([])
          setArchivedTasks(archivedSnapshot.tasks)
          setProjectId(project === null ? null : current.projectId)
          setDetail(
            project === null
              ? null
              : { project, tasks: visible, counts: viewCountsOf(snapshot.tasks, stamp) },
          )
          setNow(stamp)
          setLoading(false)
          return visible
        }
        const cards = await Promise.all(
          nextProjects.map(async (project) => {
            const snapshot = await query(project.id)
            return {
              project,
              preview: visibleTasksOf(snapshot.tasks, stamp),
              counts: viewCountsOf(snapshot.tasks, stamp),
            }
          }),
        )
        if (requestRef.current !== requestId) return null
        setProjects(nextProjects)
        setProjectTotals(totals)
        setProjectCards(cards)
        setArchivedTasks(archivedSnapshot.tasks)
        setDetail(null)
        setStats(allSnapshot.stats)
        setNow(stamp)
        setLoading(false)
        return null
      }

      const [nextProjects, snapshot, archivedSnapshot] = await Promise.all([
        pet.listProjects(),
        pet.listTasks({ scope: current.scope, category: current.category }),
        archivedQuery(),
      ])
      if (requestRef.current !== requestId) return null
      const stamp = Date.now()
      const visible = visibleTasksOf(snapshot.tasks, stamp)
      setProjects(nextProjects)
      setTasks(visible)
      setArchivedTasks(archivedSnapshot.tasks)
      setStats(snapshot.stats)
      setProjectCards([])
      setDetail(null)
      setNow(stamp)
      setLoading(false)
      return visible
    } catch (error: unknown) {
      if (requestRef.current !== requestId) return null
      if (silent) setActionError(`刷新失败：${describeError(error)}`)
      else setLoadError(`加载任务失败：${describeError(error)}`)
      setLoading(false)
      return null
    }
  }, [])

  /** 打卡数据（habits:list 可能推进周期并持久化；失败不返回半推进快照） */
  const refreshHabits = useCallback(async (silent = false): Promise<HabitSnapshot[] | null> => {
    const pet = window.pet
    if (!pet) {
      setLoadError(PRELOAD_ERROR)
      setLoading(false)
      return null
    }
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    if (!silent) setLoading(true)
    setLoadError(null)
    try {
      const list = await pet.listHabits()
      if (requestRef.current !== requestId) return null
      setHabits(list)
      setNow(Date.now())
      setLoading(false)
      return list
    } catch (error: unknown) {
      if (requestRef.current !== requestId) return null
      if (silent) setActionError(`刷新打卡失败：${describeError(error)}`)
      else setLoadError(`加载打卡项目失败：${describeError(error)}`)
      setLoading(false)
      return null
    }
  }, [])

  const loadCurrent = useCallback(
    async (silent = false): Promise<void> => {
      if (filtersRef.current.tab === 'habits') await refreshHabits(silent)
      else await refreshTodo(silent)
    },
    [refreshHabits, refreshTodo],
  )

  // 筛选变化即重新取数（请求序号保证迟到响应不覆盖）
  useEffect(() => {
    void loadCurrent(false)
  }, [tab, scope, category, projectId, loadCurrent])

  // 30s 轮询 + 窗口回焦/恢复可见刷新
  useEffect(() => {
    const timer = window.setInterval(() => void loadCurrent(true), 30_000)
    return () => window.clearInterval(timer)
  }, [loadCurrent])

  useEffect(() => {
    const refresh = (): void => void loadCurrent(true)
    const handleVisibility = (): void => {
      if (!document.hidden) refresh()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [loadCurrent])

  // main 事件：任务/项目变化刷新待办；habits-changed 只刷新打卡页；settings 同步表单默认值
  useEffect(() => {
    const pet = window.pet
    if (!pet) return
    return pet.onEvent((event) => {
      if (event.type === 'tasks-changed') {
        if (filtersRef.current.tab === 'todo') void loadCurrent(true)
      } else if (event.type === 'habits-changed') {
        if (filtersRef.current.tab === 'habits') void loadCurrent(true)
      } else if (event.type === 'settings') {
        setSettings(normalizeSettings(event.settings))
      }
    })
  }, [loadCurrent])

  // 底部新建面板：Esc 关闭（中文输入法组合期间不触发）
  useEffect(() => {
    if (!composerOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.isComposing) setComposerOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [composerOpen])

  // 面板关闭后焦点回到 FAB
  useEffect(() => {
    if (previouslyComposerOpen.current && !composerOpen) fabRef.current?.focus()
    previouslyComposerOpen.current = composerOpen
  }, [composerOpen])

  // 删除撤销 30 秒过期
  useEffect(() => {
    if (deleted.length === 0) return
    const timer = window.setInterval(() => {
      setDeleted((items) => items.filter((item) => item.expiresAt > Date.now()))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [deleted.length])

  // 提示自动消失
  useEffect(() => {
    if (notice === null) return
    const timer = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const runExclusive = async (action: () => Promise<void>): Promise<void> => {
    if (actionBusy.current) return
    actionBusy.current = true
    setBusy(true)
    try {
      await action()
    } finally {
      actionBusy.current = false
      setBusy(false)
    }
  }

  // ---------- 筛选 / 页面切换 ----------
  const changeTab = (next: Tab): void => {
    if (next === tab) return
    setArchivedOpen(false)
    setComposerOpen(false)
    setActionError(null)
    setNotice(null)
    setTab(next)
  }

  const changeScope = (next: ScopeSelection): void => {
    if (next === scope) return
    setActionError(null)
    setScope(next)
  }

  const changeCategory = (next: TaskCategory): void => {
    setActionError(null)
    setNotice(null)
    if (category === next) {
      // 再次点击已选分类 = 取消选择 → 全部分类混排；退出项目详情
      setCategory(null)
      setProjectId(null)
      return
    }
    setCategory(next)
    setProjectId(null)
  }

  const toggleProjectCategory = (): void => {
    setActionError(null)
    setNotice(null)
    if (category === 'project') {
      setCategory(null)
      setProjectId(null)
      return
    }
    setCategory('project')
    setProjectId(null)
  }

  const openArchived = (): void => {
    setComposerOpen(false)
    setActionError(null)
    setNotice(null)
    setArchivedOpen(true)
    void refreshTodo(true)
  }

  const closeArchived = (): void => {
    setArchivedOpen(false)
    setNotice(null)
  }

  // ---------- 任务操作 ----------
  const handleCreateTask = async (input: TaskCreateInput): Promise<boolean> => {
    const pet = window.pet
    if (!pet) {
      setActionError(PRELOAD_ERROR)
      return false
    }
    if (actionBusy.current) return false
    actionBusy.current = true
    setBusy(true)
    setActionError(null)
    try {
      const created = await pet.createTask(input)
      const list = await refreshTodo(true)
      const current = filtersRef.current
      // 分类筛选固定时，若新任务归属不同则切到该分类，避免“添加后看不见”
      const willSwitchCategory =
        current.category !== null &&
        current.category !== 'project' &&
        input.category !== undefined &&
        input.category !== null &&
        input.category !== current.category
      if (willSwitchCategory && input.category !== undefined && input.category !== null) {
        setCategory(input.category)
      }
      const visible = willSwitchCategory
        ? true
        : list === null
          ? true
          : list.some((task) => task.id === created.id)
      setNotice(visible ? '已添加' : '已添加；当前筛选下不可见，可切换范围或分类查看')
      return true
    } catch (error: unknown) {
      setActionError(`保存失败：${describeError(error)}`)
      return false
    } finally {
      actionBusy.current = false
      setBusy(false)
    }
  }

  const handleToggleTask = async (task: Task): Promise<void> => {
    const pet = window.pet
    if (!pet) return
    await runExclusive(async () => {
      try {
        const next = await pet.toggleTask({ id: task.id, done: task.status !== 'done' })
        await refreshTodo(true)
        setNotice(next.status === 'done' ? '已完成；再次勾选可恢复' : '已恢复为未完成')
      } catch (error: unknown) {
        setActionError(`更新任务失败：${describeError(error)}`)
      }
    })
  }

  const handleArchiveTask = async (task: Task): Promise<void> => {
    const pet = window.pet
    if (!pet) return
    await runExclusive(async () => {
      try {
        await pet.setTaskArchived({ id: task.id, archived: true })
        await refreshTodo(true)
        setNotice('已搁置；可在「搁置任务清单」查看')
      } catch (error: unknown) {
        setActionError(`搁置失败：${describeError(error)}`)
      }
    })
  }

  const handleRestoreTask = async (task: Task): Promise<void> => {
    const pet = window.pet
    if (!pet) return
    await runExclusive(async () => {
      try {
        await pet.setTaskArchived({ id: task.id, archived: false })
        const list = await refreshTodo(true)
        const visible = list === null ? true : list.some((entry) => entry.id === task.id)
        setNotice(visible ? '已恢复为活动任务' : '已恢复；可在「全部」查看')
      } catch (error: unknown) {
        setActionError(`恢复失败：${describeError(error)}`)
      }
    })
  }

  const handleDeleteTask = async (task: Task): Promise<void> => {
    const pet = window.pet
    if (!pet || actionBusy.current) return
    if (!window.confirm(`删除任务「${task.title}」？\n删除后 30 秒内可在本面板撤销。`)) return
    await runExclusive(async () => {
      try {
        await pet.deleteTask(task.id)
        setDeleted((items) => [
          ...items.filter((item) => item.id !== task.id && item.expiresAt > Date.now()),
          { id: task.id, title: task.title, expiresAt: Date.now() + 30_000 },
        ])
        await refreshTodo(true)
        setNotice('已删除，30 秒内可撤销')
      } catch (error: unknown) {
        setActionError(`删除失败：${describeError(error)}`)
      }
    })
  }

  const handleUndoDelete = async (id: string): Promise<void> => {
    const pet = window.pet
    if (!pet) return
    await runExclusive(async () => {
      try {
        await pet.restoreTask(id)
        setDeleted((items) => items.filter((item) => item.id !== id))
        await refreshTodo(true)
        setNotice('已恢复任务')
      } catch (error: unknown) {
        setActionError(`恢复失败：${describeError(error)}`)
      }
    })
  }

  const handleSaveEdit = async (patch: TaskPatch): Promise<void> => {
    if (editing === null || !window.pet) throw new Error('任务面板未就绪，请重试')
    if (actionBusy.current) return
    actionBusy.current = true
    setBusy(true)
    try {
      await window.pet.updateTask({ id: editing.id, patch })
      setEditing(null)
      setActionError(null)
      setNotice('已保存修改')
      await refreshTodo(true)
    } finally {
      actionBusy.current = false
      setBusy(false)
    }
  }

  // ---------- 项目操作 ----------
  const handleCreateProject = async (name: string, note: string): Promise<void> => {
    const pet = window.pet
    if (!pet) throw new Error('任务面板未就绪，请重试')
    if (actionBusy.current) return
    actionBusy.current = true
    setBusy(true)
    try {
      await pet.createProject({ name, note: note === '' ? null : note })
      setProjectModal(null)
      setActionError(null)
      setNotice('已创建项目')
      await refreshTodo(true)
    } finally {
      actionBusy.current = false
      setBusy(false)
    }
  }

  const handleUpdateProject = async (id: string, name: string, note: string): Promise<void> => {
    const pet = window.pet
    if (!pet) throw new Error('任务面板未就绪，请重试')
    if (actionBusy.current) return
    actionBusy.current = true
    setBusy(true)
    try {
      await pet.updateProject({ id, patch: { name, note: note === '' ? null : note } })
      setProjectModal(null)
      setActionError(null)
      setNotice('已保存项目')
      await refreshTodo(true)
    } finally {
      actionBusy.current = false
      setBusy(false)
    }
  }

  const handleDeleteProject = async (project: Project): Promise<void> => {
    const pet = window.pet
    if (!pet) return
    if ((projectTotals[project.id] ?? 0) > 0) {
      setActionError('项目下有任务（含已完成/搁置），不能删除')
      return
    }
    if (!window.confirm(`删除项目「${project.name}」？\n只有空项目可以删除。`)) return
    await runExclusive(async () => {
      try {
        await pet.deleteProject(project.id)
        if (filtersRef.current.projectId === project.id) setProjectId(null)
        setNotice('已删除项目')
        await refreshTodo(true)
      } catch (error: unknown) {
        setActionError(`删除项目失败：${describeError(error)}`)
      }
    })
  }

  // ---------- 打卡操作 ----------
  const handleCreateHabit = async (values: {
    name: string
    note: string | null
    schedule: HabitSchedule
  }): Promise<void> => {
    const pet = window.pet
    if (!pet) throw new Error('任务面板未就绪，请重试')
    if (actionBusy.current) return
    actionBusy.current = true
    setBusy(true)
    try {
      const input: HabitCreateInput = values
      await pet.createHabit(input)
      setHabitModal(null)
      setActionError(null)
      setNotice('已创建打卡项目')
      await refreshHabits(true)
    } finally {
      actionBusy.current = false
      setBusy(false)
    }
  }

  const handleUpdateHabit = async (
    habit: Habit,
    values: { name: string; note: string | null; schedule: HabitSchedule },
  ): Promise<void> => {
    const pet = window.pet
    if (!pet) throw new Error('任务面板未就绪，请重试')
    if (actionBusy.current) return
    actionBusy.current = true
    setBusy(true)
    try {
      const effective = habit.pendingSchedule?.schedule ?? habit.currentCycle.schedule
      const patch: HabitPatch = { name: values.name, note: values.note }
      if (scheduleKey(effective) !== scheduleKey(values.schedule)) patch.schedule = values.schedule
      await pet.updateHabit({ id: habit.id, patch })
      setHabitModal(null)
      setActionError(null)
      setNotice('已保存打卡项目')
      await refreshHabits(true)
    } finally {
      actionBusy.current = false
      setBusy(false)
    }
  }

  const handleDeleteHabit = async (habit: Habit): Promise<void> => {
    const pet = window.pet
    if (!pet) return
    if (!window.confirm(`删除打卡项目「${habit.name}」？\n已有历史记录的打卡项目不能删除。`)) return
    await runExclusive(async () => {
      try {
        await pet.deleteHabit(habit.id)
        setNotice('已删除打卡项目')
        await refreshHabits(true)
      } catch (error: unknown) {
        const message = describeError(error)
        setActionError(
          message.includes('HABIT_HAS_HISTORY')
            ? '该打卡项目已有历史记录，不能删除'
            : `删除失败：${message}`,
        )
      }
    })
  }

  const handleCheckinHabit = async (snapshot: HabitSnapshot): Promise<void> => {
    const pet = window.pet
    if (!pet) return
    await runExclusive(async () => {
      try {
        const result = await pet.checkinHabit({
          habitId: snapshot.habit.id,
          cycleKey: snapshot.habit.currentCycle.key,
        })
        // 以 main 返回的快照为准；仅首次成功 isNew=true（庆祝由 main 触发）
        setHabits((current) =>
          current.map((entry) => (entry.habit.id === result.habit.habit.id ? result.habit : entry)),
        )
        setNotice(result.isNew ? '打卡成功' : '本周期已打卡')
        await refreshHabits(true)
      } catch (error: unknown) {
        const message = describeError(error)
        setActionError(
          message.includes('CYCLE_CHANGED')
            ? '周期已切换，正在刷新列表，请重试打卡'
            : `打卡失败：${message}`,
        )
        await refreshHabits(true)
      }
    })
  }

  // ---------- 派生值 ----------
  const defaultReminderLeadMin =
    settings?.customReminderLeadMin ?? settings?.reminderLeadMin ?? DEFAULT_REMINDER_LEAD_MIN
  const scopeLabel = scope === 'today' ? '今日' : '全部'
  const projectNameMap = new Map(projects.map((project) => [project.id, project.name]))
  const projectNameOf = (task: Task | null): string | null =>
    task === null || task.projectId === null
      ? null
      : (projects.find((project) => project.id === task.projectId)?.name ?? null)
  const currentRangeCount =
    category === 'project'
      ? projectId !== null
        ? (detail?.tasks.length ?? 0)
        : projectCards.reduce((sum, card) => sum + card.preview.length, 0)
      : tasks.length
  const archivedCount = archivedTasks.length
  const composerAttribution: QuickAddAttribution | null =
    category === 'project'
      ? detail !== null
        ? { kind: 'project', projectId: detail.project.id, projectName: detail.project.name }
        : null
      : { kind: 'category', category: category ?? 'life' }
  const showFab = tab === 'todo' && !archivedOpen && composerAttribution !== null
  const composerHint =
    composerAttribution?.kind === 'project'
      ? `任务会添加到项目「${composerAttribution.projectName}」；本版不支持移动归属。`
      : '归属与筛选独立；取消分类筛选不会改变任务类别。'

  const taskRowHandlers = {
    onToggle: (task: Task) => void handleToggleTask(task),
    onEdit: setEditing,
    onDelete: (task: Task) => void handleDeleteTask(task),
    onArchive: (task: Task) => void handleArchiveTask(task),
    onRestore: (task: Task) => void handleRestoreTask(task),
  }

  /** 项目弹窗提交（组件只负责表单；这里区分新建/编辑） */
  const submitProjectForm = async (name: string, note: string): Promise<void> => {
    if (projectModal === null) return
    if (projectModal.project !== undefined) {
      await handleUpdateProject(projectModal.project.id, name, note)
      return
    }
    await handleCreateProject(name, note)
  }

  /** 打卡弹窗提交（编辑时只把实际变化的规则排到下一周期，由 main 决定生效） */
  const submitHabitForm = async (values: {
    name: string
    note: string | null
    schedule: HabitSchedule
  }): Promise<void> => {
    if (habitModal === null) return
    if (habitModal.habit !== undefined) {
      await handleUpdateHabit(habitModal.habit, values)
      return
    }
    await handleCreateHabit(values)
  }

  return (
    <main className="tasks">
      <header className="tasks__header">
        <div className="tasks__topbar">
          <h1 className="tasks__app-title">任务清单</h1>
          <div className="seg" role="tablist" aria-label="一级导航">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'todo'}
              className={tab === 'todo' ? 'seg__item seg__item--active' : 'seg__item'}
              onClick={() => changeTab('todo')}
            >
              待办
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'habits'}
              className={tab === 'habits' ? 'seg__item seg__item--active' : 'seg__item'}
              onClick={() => changeTab('habits')}
            >
              打卡
            </button>
          </div>
          <div className="tasks__topbar-right">
            {tab === 'habits' ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setHabitModal({ mode: 'create' })}
              >
                新建打卡项目
              </button>
            ) : archivedOpen ? null : (
              <div className="seg" role="tablist" aria-label="任务范围">
                <button
                  type="button"
                  role="tab"
                  aria-selected={scope === 'today'}
                  className={scope === 'today' ? 'seg__item seg__item--active' : 'seg__item'}
                  onClick={() => changeScope('today')}
                >
                  今日
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={scope === 'all'}
                  className={scope === 'all' ? 'seg__item seg__item--active' : 'seg__item'}
                  onClick={() => changeScope('all')}
                >
                  全部
                </button>
              </div>
            )}
          </div>
        </div>

        {tab === 'todo' && !archivedOpen ? (
          <>
            <div className="tasks__filter-row">
              <div className="seg seg--category" role="group" aria-label="任务分类">
                {CATEGORY_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={category === option.value}
                    className={
                      category === option.value ? 'seg__item seg__item--active' : 'seg__item'
                    }
                    onClick={() => changeCategory(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
                <button
                  type="button"
                  aria-pressed={category === 'project'}
                  className={category === 'project' ? 'seg__item seg__item--active' : 'seg__item'}
                  onClick={toggleProjectCategory}
                >
                  项目
                </button>
              </div>
              <span className="tasks__filter-hint">
                {category === null ? '全部分类混排（项目任务带项目标签）' : '再点已选分类可取消'}
              </span>
            </div>
            <div className="tasks__status-row">
              <div className="tasks__summary">
                <span className="tasks__summary-item">
                  今日完成 {stats?.todayDone ?? 0}/{stats?.todayTotal ?? 0}
                </span>
                <span className="tasks__summary-item">当前范围内 {currentRangeCount} 项</span>
              </div>
              <div className="tasks__summary-actions">
                {category === 'project' && projectId === null ? (
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => setProjectModal({ mode: 'create' })}
                  >
                    新建项目
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn tasks__archive-entry"
                  aria-label={`打开搁置任务清单，共 ${archivedCount} 项`}
                  onClick={openArchived}
                >
                  搁置 {archivedCount}
                </button>
              </div>
            </div>
          </>
        ) : null}
      </header>

      {!composerOpen && actionError !== null ? (
        <p className="banner banner--error" role="alert">
          {actionError}
        </p>
      ) : !composerOpen && notice !== null ? (
        <p className="banner banner--ok" role="status">
          {notice}
        </p>
      ) : null}

      {deleted.length > 0 ? (
        <div className="tasks__undo" aria-label="最近删除">
          {deleted.map((item) => (
            <div key={item.id} className="tasks__undo-row">
              <span>已删除「{item.title}」 · 30 秒内可撤销</span>
              <button
                type="button"
                className="btn"
                aria-label={`撤销删除「${item.title}」`}
                disabled={busy}
                onClick={() => void handleUndoDelete(item.id)}
              >
                撤销
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {tab === 'habits' ? (
        <>
          {loadError !== null && habits.length > 0 ? (
            <p className="banner banner--error" role="alert">
              {loadError}
            </p>
          ) : null}
          <HabitsPage
            habits={habits}
            loading={loading && habits.length === 0}
            loadError={loadError}
            busy={busy}
            onRetry={() => void refreshHabits()}
            onCreate={() => setHabitModal({ mode: 'create' })}
            onEdit={(habit) => setHabitModal({ mode: 'edit', habit })}
            onDelete={(habit) => void handleDeleteHabit(habit)}
            onCheckin={(snapshot) => void handleCheckinHabit(snapshot)}
            onHistory={(habit) => setHistoryHabit(habit)}
          />
        </>
      ) : archivedOpen ? (
        <section className="archive-page" aria-label="搁置任务清单">
          <div className="archive-page__head">
            <button type="button" className="btn" aria-label="返回待办" onClick={closeArchived}>
              ← 返回待办
            </button>
            <h2 className="section-title">搁置任务清单 · {archivedCount}</h2>
          </div>
          {loading ? (
            <p className="tasks__state">正在加载搁置任务…</p>
          ) : loadError !== null ? (
            <div className="tasks__state tasks__state--error" role="alert">
              <p className="tasks__state-title">搁置任务加载失败</p>
              <p>{loadError}</p>
              <button type="button" className="btn" onClick={() => void refreshTodo()}>
                重试
              </button>
            </div>
          ) : archivedCount === 0 ? (
            <div className="tasks__state">
              <p className="tasks__state-title">还没有搁置任务</p>
              <p>在待办里对未完成任务点「搁置」后，会出现在这里。</p>
            </div>
          ) : (
            <div className="tasks__list" role="tabpanel" aria-label="搁置任务">
              <TaskRows
                tasks={archivedTasks}
                now={now}
                projectNames={projectNameMap}
                busy={busy}
                {...taskRowHandlers}
              />
            </div>
          )}
        </section>
      ) : category === 'project' ? (
        projectId !== null && detail === null ? (
          loading ? (
            <p className="tasks__state">正在加载项目…</p>
          ) : loadError !== null ? (
            <div className="tasks__state tasks__state--error" role="alert">
              <p className="tasks__state-title">项目加载失败</p>
              <p>{loadError}</p>
              <button type="button" className="btn" onClick={() => void refreshTodo()}>
                重试
              </button>
            </div>
          ) : (
            <div className="tasks__state">
              <p className="tasks__state-title">项目不存在或已删除</p>
              <button type="button" className="btn" onClick={() => setProjectId(null)}>
                返回项目列表
              </button>
            </div>
          )
        ) : detail !== null ? (
          <ProjectDetail
            project={detail.project}
            tasks={detail.tasks}
            counts={detail.counts}
            scope={scope}
            now={now}
            busy={busy}
            loading={loading}
            error={loadError}
            totalTasks={projectTotals[detail.project.id] ?? 0}
            onBack={() => setProjectId(null)}
            onRetry={() => void refreshTodo()}
            onEditProject={(project) => setProjectModal({ mode: 'edit', project })}
            onDeleteProject={(project) => void handleDeleteProject(project)}
            onShowAll={() => changeScope('all')}
            onToggleTask={(task) => void handleToggleTask(task)}
            onEditTask={setEditing}
            onDeleteTask={(task) => void handleDeleteTask(task)}
            onArchiveTask={(task) => void handleArchiveTask(task)}
            onRestoreTask={(task) => void handleRestoreTask(task)}
          />
        ) : (
          <ProjectList
            cards={projectCards}
            now={now}
            busy={busy}
            loading={loading && projectCards.length === 0}
            loadError={loadError}
            totals={projectTotals}
            onRetry={() => void refreshTodo()}
            onCreateProject={() => setProjectModal({ mode: 'create' })}
            onEditProject={(project) => setProjectModal({ mode: 'edit', project })}
            onDeleteProject={(project) => void handleDeleteProject(project)}
            onOpenProject={(id) => setProjectId(id)}
            onToggleTask={(task) => void handleToggleTask(task)}
            onEditTask={setEditing}
            onDeleteTask={(task) => void handleDeleteTask(task)}
            onArchiveTask={(task) => void handleArchiveTask(task)}
            onRestoreTask={(task) => void handleRestoreTask(task)}
          />
        )
      ) : (
        <div className="tasks__list" role="tabpanel" aria-label={`${scopeLabel}任务`}>
          {loading ? (
            <p className="tasks__state">正在加载任务…</p>
          ) : loadError !== null ? (
            <div className="tasks__state tasks__state--error" role="alert">
              <p className="tasks__state-title">任务加载失败</p>
              <p>{loadError}</p>
              <button type="button" className="btn" onClick={() => void refreshTodo()}>
                重试
              </button>
            </div>
          ) : tasks.length === 0 ? (
            <div className="tasks__state">
              <p className="tasks__state-title">{scopeLabel}范围内没有任务</p>
              <p>点右下角「+ 新建任务」，或切换分类/时间范围。</p>
              {scope === 'today' ? (
                <button type="button" className="btn" onClick={() => changeScope('all')}>
                  查看全部范围
                </button>
              ) : null}
            </div>
          ) : (
            <TaskRows
              tasks={tasks}
              now={now}
              projectNames={projectNameMap}
              busy={busy}
              {...taskRowHandlers}
            />
          )}
        </div>
      )}

      {showFab && composerAttribution !== null ? (
        <button
          ref={fabRef}
          type="button"
          className="fab"
          aria-label="新建任务"
          onClick={() => setComposerOpen(true)}
        >
          <span aria-hidden="true">+</span>
        </button>
      ) : null}

      {composerOpen && composerAttribution !== null ? (
        <div className="composer" onClick={() => setComposerOpen(false)}>
          <div
            className="composer__panel"
            role="dialog"
            aria-modal="true"
            aria-label="新建任务面板"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="composer__head">
              <h2 className="composer__title">新建任务</h2>
              <button
                type="button"
                className="btn"
                aria-label="关闭新建任务面板"
                onClick={() => setComposerOpen(false)}
              >
                关闭
              </button>
            </div>
            {/* 面板打开时主区提示被遮挡：在面板内重复显示保存成功/失败反馈 */}
            {actionError !== null ? (
              <p className="banner banner--error" role="alert">
                {actionError}
              </p>
            ) : notice !== null ? (
              <p className="banner banner--ok" role="status">
                {notice}
              </p>
            ) : null}
            <QuickAdd
              attribution={composerAttribution}
              allowCategoryChange={composerAttribution.kind === 'category'}
              defaultReminderLeadMin={defaultReminderLeadMin}
              hint={composerHint}
              onCreate={handleCreateTask}
            />
          </div>
        </div>
      ) : null}

      {editing !== null ? (
        <TaskEditor
          key={editing.id}
          task={editing}
          projectName={projectNameOf(editing)}
          defaultReminderLeadMin={defaultReminderLeadMin}
          onSave={handleSaveEdit}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      {projectModal !== null ? (
        <ProjectForm
          mode={projectModal.mode}
          project={projectModal.project}
          onSubmit={submitProjectForm}
          onCancel={() => setProjectModal(null)}
        />
      ) : null}

      {habitModal !== null ? (
        <HabitFormDialog
          habit={habitModal.habit}
          onSubmit={submitHabitForm}
          onCancel={() => setHabitModal(null)}
        />
      ) : null}

      {historyHabit !== null ? (
        <HabitHistoryDialog habit={historyHabit} onClose={() => setHistoryHabit(null)} />
      ) : null}
    </main>
  )
}
