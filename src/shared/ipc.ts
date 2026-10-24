/**
 * IPC 契约 v1（Lead 维护，ADR-0004）
 *
 * 唯一事实源：
 * - 通道名在 `ipc-channels.ts`（zod-free，供 preload 安全引用）
 * - 入参 zod、出参类型、`PetApi`（preload 白名单）在本文件
 * - main 注册 handler 时用 `IPC_INPUT_SCHEMAS[channel].parse(raw)` 校验入参
 * - preload 只做白名单转发，不暴露 ipcRenderer / require / 路径
 * - renderer 只通过 `window.pet` 调用
 *
 * v1 范围（docs/05）：窗口壳 + 设置。**不包含**计划/打卡/提醒/番茄/成长/数据导出；
 * 任务清单为 v1.5 minor（docs/23），只包含任务 CRUD/打卡/统计，不含番茄/成长。
 * 这些学习通道随 P2 方案保留在文档中，不进入本契约（删除 = major，见 ipc-version.ts）。
 *
 * 硬规则：
 * 1. **只加不改**；删除/改语义 → major（当前 2.0.0，首次发布前由 ADR-0004 重置）。
 * 2. 入参一律 strictObject：多余字段直接拒绝（防 typo 静默失败）。
 * 3. 时间戳 epoch ms；v1 无 day_key（任务清单沿用 rules.ts 业务日）。
 *
 * 2.0（0.4.0）：删除旧整体打卡 `tasks:checkin` 与 TaskStats 旧字段（major）；新增
 * `tasks:set-archived` + habits×6；tasks:list 增加 view/category/viewScope；共 31 invoke + 1 event。
 * 1.10（0.3.3）：`pet:event.pet-action` 瞬时角色动作；无新增 invoke。
 * 1.9（0.3.2）：Bootstrap.urgentTasks + `pet:event.tasks-urgent`（HUD）；settings 新增可选
 * `hudScope`。无新增 invoke 通道（仍 25 invoke + 1 event）。
 * 1.8（0.3.1b）：新增 projects:list/create/update/delete；tasks:list 增加 project scope；
 * tasks:create 增加可选 projectId（与 category XOR，store 校验）。
 * 1.7（0.3.1a）：settings 新增可选 `reminderLeadMin`；任务模型切 v2（三分类 + urgent）。
 */
import { z } from 'zod'

import { IPC } from './ipc-channels'
import type { IpcChannel, IpcInvokeChannel } from './ipc-channels'
import type { PetRect } from './pet-layout'
import type {
  Bootstrap,
  Habit,
  HabitCheckin,
  HabitCheckinInput,
  HabitCheckinResult,
  HabitCreateInput,
  HabitCycleSnapshot,
  HabitHistoryInput,
  HabitHistoryPage,
  HabitPatch,
  HabitSchedule,
  HabitSnapshot,
  HabitUpdateInput,
  PetEvent,
  Settings,
  SettingsPatch,
  WindowPlacement,
} from './types'
import type {
  Project,
  ProjectCreateInput,
  ProjectPatch,
  ProjectUpdateInput,
  Task,
  TaskCategory,
  TaskCategorySelection,
  TaskCreateInput,
  TaskImportance,
  TaskPatch,
  TaskReminderState,
  TaskScope,
  TaskStats,
  TaskToggleInput,
  TaskUpdateInput,
  TasksListInput,
  TasksSnapshot,
  TaskView,
  TaskViewCounts,
} from './types'

export { IPC }
export type { IpcChannel, IpcInvokeChannel }

// ---------------------------------------------------------------------------
// 入参 schema（每个 invoke 通道一个）
// ---------------------------------------------------------------------------

export const zAppBootstrapInput = z.undefined()

export const zWindowSetClickThroughInput = z.strictObject({ ignore: z.boolean() })
export const zWindowGetClickThroughInput = z.undefined()
export const zWindowMoveByInput = z.strictObject({
  dx: z.number().finite(),
  dy: z.number().finite(),
})
export const zWindowSetVisibleInput = z.strictObject({ visible: z.boolean() })
export const zWindowResetPositionInput = z.undefined()
export const zWindowGetPlacementInput = z.undefined()
export const zWindowShowContextMenuInput = z.strictObject({
  source: z.enum(['pet', 'bubble']).optional(),
})
export const zWindowSetBubbleVisibleInput = z.strictObject({ visible: z.boolean() })
const zBubbleRect = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
})
export const zWindowSetBubbleRegionInput = z.strictObject({
  rect: zBubbleRect.nullable(),
})

export const zSettingsGetInput = z.undefined()
const zReminderLeadMin = z.union([z.literal(5), z.literal(15), z.literal(30), z.literal(60)])
const zCustomReminderLeadMin = z.number().int().min(1).max(1440).nullable()
const zHudScope = z.enum(['urgent', 'urgent-due'])
export const zSettingsPatch = z.strictObject({
  autostart: z.boolean().optional(),
  muted: z.boolean().optional(),
  reminderLeadMin: zReminderLeadMin.optional(),
  customReminderLeadMin: zCustomReminderLeadMin.optional(),
  hudScope: zHudScope.optional(),
})
export const zSettingsUpdateInput = z.strictObject({ patch: zSettingsPatch })

// 任务清单（v1.5）：入参 schema 与 types.ts 的接口一一对应
// 0.3.1a（契约 1.7）：三分类 life/sport/study；重要性新增 urgent；项目任务在 0.3.1b 才可创建
const zTaskCategory = z.enum(['life', 'sport', 'study'])
const zTaskImportance = z.enum(['urgent', 'high', 'normal', 'low'])
const zTaskView = z.enum(['active', 'completed', 'archived'])
const zTaskCategorySelection = z.union([zTaskCategory, z.literal('project')]).nullable()
const zReminderLeadOverride = z.number().int().min(1).max(1440).nullable()
export const zTasksListInput = z
  .strictObject({
    scope: z.enum(['today', 'all', 'project']),
    projectId: z.string().min(1).max(64).optional(),
    view: zTaskView.optional(),
    category: zTaskCategorySelection.optional(),
    viewScope: z.enum(['today', 'all']).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.scope === 'project' && value.projectId === undefined) {
      ctx.addIssue({ code: 'custom', message: 'scope=project 时必须提供 projectId' })
    }
    if (value.scope !== 'project' && value.projectId !== undefined) {
      ctx.addIssue({ code: 'custom', message: '非 project scope 不能携带 projectId' })
    }
    if (value.scope !== 'project' && value.viewScope !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'viewScope 仅允许 scope=project' })
    }
    if (value.scope === 'project' && value.category !== undefined && value.category !== 'project') {
      ctx.addIssue({ code: 'custom', message: 'scope=project 时 category 只能省略或 project' })
    }
  })
export const zTasksCreateInput = z
  .strictObject({
    title: z.string().min(1).max(80),
    category: zTaskCategory.nullable().optional(),
    projectId: z.string().min(1).max(64).nullable().optional(),
    importance: zTaskImportance.optional(),
    dueAt: z.number().finite().nullable().optional(),
    note: z.string().max(500).nullable().optional(),
    reminderLeadMinOverride: zReminderLeadOverride.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.category != null && value.projectId != null) {
      ctx.addIssue({ code: 'custom', message: 'category 与 projectId 只能二选一（XOR）' })
    }
  })
export const zTasksPatch = z.strictObject({
  title: z.string().min(1).max(80).optional(),
  category: zTaskCategory.optional(),
  importance: zTaskImportance.optional(),
  dueAt: z.number().finite().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  reminderLeadMinOverride: zReminderLeadOverride.optional(),
})
export const zTasksUpdateInput = z.strictObject({
  id: z.string().min(1).max(64),
  patch: zTasksPatch,
})
export const zTasksToggleInput = z.strictObject({
  id: z.string().min(1).max(64),
  done: z.boolean().optional(),
})
export const zTasksDeleteInput = z.strictObject({ id: z.string().min(1).max(64) })
export const zTasksSetArchivedInput = z.strictObject({
  id: z.string().min(1).max(64),
  archived: z.boolean(),
})
export const zTasksStatsInput = z.undefined()
export const zTasksRestoreInput = z.strictObject({ id: z.string().min(1).max(64) })
export const zTasksOpenInput = z.undefined()

// 项目（0.3.1b，契约 1.8）
const zProjectName = z.string().min(1).max(40)
const zProjectNote = z.string().max(200).nullable()
export const zProjectsListInput = z.undefined()
export const zProjectsCreateInput = z.strictObject({
  name: zProjectName,
  note: zProjectNote.optional(),
})
export const zProjectsPatch = z.strictObject({
  name: zProjectName.optional(),
  note: zProjectNote.optional(),
})
export const zProjectsUpdateInput = z.strictObject({
  id: z.string().min(1).max(64),
  patch: zProjectsPatch,
})
export const zProjectsDeleteInput = z.strictObject({ id: z.string().min(1).max(64) })

// 独立打卡（0.4.0，IPC 2.0）
const zIsoWeekday = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
])
const zHabitSchedule = z.discriminatedUnion('frequency', [
  z.strictObject({ frequency: z.literal('daily'), deadlineWeekday: z.null() }),
  z.strictObject({ frequency: z.literal('weekly'), deadlineWeekday: zIsoWeekday }),
])
const zHabitName = z.string().min(1).max(80)
const zHabitNote = z.string().max(200).nullable()
export const zHabitsListInput = z.undefined()
export const zHabitsCreateInput = z.strictObject({
  name: zHabitName,
  note: zHabitNote.optional(),
  schedule: zHabitSchedule,
})
export const zHabitsPatch = z.strictObject({
  name: zHabitName.optional(),
  note: zHabitNote.optional(),
  schedule: zHabitSchedule.optional(),
})
export const zHabitsUpdateInput = z.strictObject({
  id: z.string().min(1).max(64),
  patch: zHabitsPatch,
})
export const zHabitsDeleteInput = z.strictObject({ id: z.string().min(1).max(64) })
export const zHabitsCheckinInput = z.strictObject({
  habitId: z.string().min(1).max(64),
  cycleKey: z.string().min(1).max(200),
  note: z.string().max(140).nullable().optional(),
})
export const zHabitsHistoryInput = z.strictObject({
  habitId: z.string().min(1).max(64),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(500).optional(),
})

// ---------------------------------------------------------------------------
// 入参类型（由 schema 推导，main 与 renderer 共用）
// ---------------------------------------------------------------------------

export type WindowMoveByInput = z.infer<typeof zWindowMoveByInput>
export type WindowShowContextMenuInput = z.infer<typeof zWindowShowContextMenuInput>
export type SettingsUpdateInput = z.infer<typeof zSettingsUpdateInput>

// ---------------------------------------------------------------------------
// 通道 → 入参/出参映射（main 的 handler 注册表按此类型实现）
// ---------------------------------------------------------------------------

export interface IpcInvokeMap {
  [IPC.appBootstrap]: { input: undefined; output: Bootstrap }

  [IPC.windowSetClickThrough]: { input: z.infer<typeof zWindowSetClickThroughInput>; output: void }
  [IPC.windowGetClickThrough]: { input: undefined; output: boolean }
  [IPC.windowMoveBy]: { input: WindowMoveByInput; output: void }
  [IPC.windowSetVisible]: { input: z.infer<typeof zWindowSetVisibleInput>; output: void }
  [IPC.windowResetPosition]: { input: undefined; output: void }
  [IPC.windowGetPlacement]: { input: undefined; output: WindowPlacement | null }
  [IPC.windowShowContextMenu]: { input: WindowShowContextMenuInput; output: void }
  [IPC.windowSetBubbleVisible]: {
    input: z.infer<typeof zWindowSetBubbleVisibleInput>
    output: void
  }
  [IPC.windowSetBubbleRegion]: {
    input: z.infer<typeof zWindowSetBubbleRegionInput>
    output: void
  }

  [IPC.settingsGet]: { input: undefined; output: Settings }
  [IPC.settingsUpdate]: { input: SettingsUpdateInput; output: Settings }

  [IPC.tasksList]: { input: TasksListInput; output: TasksSnapshot }
  [IPC.tasksCreate]: { input: TaskCreateInput; output: Task }
  [IPC.tasksUpdate]: { input: TaskUpdateInput; output: Task }
  [IPC.tasksToggle]: { input: TaskToggleInput; output: Task }
  [IPC.tasksDelete]: { input: z.infer<typeof zTasksDeleteInput>; output: void }
  [IPC.tasksStats]: { input: undefined; output: TaskStats }
  [IPC.tasksRestore]: { input: z.infer<typeof zTasksRestoreInput>; output: Task }
  [IPC.tasksOpen]: { input: undefined; output: void }
  [IPC.tasksSetArchived]: { input: z.infer<typeof zTasksSetArchivedInput>; output: Task }

  [IPC.projectsList]: { input: undefined; output: Project[] }
  [IPC.projectsCreate]: { input: ProjectCreateInput; output: Project }
  [IPC.projectsUpdate]: { input: ProjectUpdateInput; output: Project }
  [IPC.projectsDelete]: { input: z.infer<typeof zProjectsDeleteInput>; output: void }

  [IPC.habitsList]: { input: undefined; output: HabitSnapshot[] }
  [IPC.habitsCreate]: { input: HabitCreateInput; output: HabitSnapshot }
  [IPC.habitsUpdate]: { input: HabitUpdateInput; output: HabitSnapshot }
  [IPC.habitsDelete]: { input: z.infer<typeof zHabitsDeleteInput>; output: void }
  [IPC.habitsCheckin]: { input: HabitCheckinInput; output: HabitCheckinResult }
  [IPC.habitsHistory]: { input: HabitHistoryInput; output: HabitHistoryPage }
}

export type IpcInput<C extends IpcInvokeChannel> = IpcInvokeMap[C]['input']
export type IpcOutput<C extends IpcInvokeChannel> = IpcInvokeMap[C]['output']

/** 入参校验表：main 侧 handler 注册前必须先 parse（多余字段会被 strictObject 拒绝） */
export const IPC_INPUT_SCHEMAS = {
  [IPC.appBootstrap]: zAppBootstrapInput,
  [IPC.windowSetClickThrough]: zWindowSetClickThroughInput,
  [IPC.windowGetClickThrough]: zWindowGetClickThroughInput,
  [IPC.windowMoveBy]: zWindowMoveByInput,
  [IPC.windowSetVisible]: zWindowSetVisibleInput,
  [IPC.windowResetPosition]: zWindowResetPositionInput,
  [IPC.windowGetPlacement]: zWindowGetPlacementInput,
  [IPC.windowShowContextMenu]: zWindowShowContextMenuInput,
  [IPC.windowSetBubbleVisible]: zWindowSetBubbleVisibleInput,
  [IPC.windowSetBubbleRegion]: zWindowSetBubbleRegionInput,
  [IPC.settingsGet]: zSettingsGetInput,
  [IPC.settingsUpdate]: zSettingsUpdateInput,
  [IPC.tasksList]: zTasksListInput,
  [IPC.tasksCreate]: zTasksCreateInput,
  [IPC.tasksUpdate]: zTasksUpdateInput,
  [IPC.tasksToggle]: zTasksToggleInput,
  [IPC.tasksDelete]: zTasksDeleteInput,
  [IPC.tasksStats]: zTasksStatsInput,
  [IPC.tasksRestore]: zTasksRestoreInput,
  [IPC.tasksOpen]: zTasksOpenInput,
  [IPC.tasksSetArchived]: zTasksSetArchivedInput,
  [IPC.projectsList]: zProjectsListInput,
  [IPC.projectsCreate]: zProjectsCreateInput,
  [IPC.projectsUpdate]: zProjectsUpdateInput,
  [IPC.projectsDelete]: zProjectsDeleteInput,
  [IPC.habitsList]: zHabitsListInput,
  [IPC.habitsCreate]: zHabitsCreateInput,
  [IPC.habitsUpdate]: zHabitsUpdateInput,
  [IPC.habitsDelete]: zHabitsDeleteInput,
  [IPC.habitsCheckin]: zHabitsCheckinInput,
  [IPC.habitsHistory]: zHabitsHistoryInput,
} satisfies { [C in IpcInvokeChannel]: z.ZodType<IpcInput<C>> }

// ---------------------------------------------------------------------------
// preload 白名单 API（window.pet 的类型；preload 只做转发，不含业务逻辑）
// ---------------------------------------------------------------------------

export interface PetApi {
  // app
  bootstrap(): Promise<Bootstrap>
  /** 订阅 main → renderer 的唯一事件通道；返回取消订阅函数 */
  onEvent(listener: (event: PetEvent) => void): () => void

  // 窗口
  setClickThrough(ignore: boolean): Promise<void>
  getClickThrough(): Promise<boolean>
  moveBy(dx: number, dy: number): Promise<void>
  setVisible(visible: boolean): Promise<void>
  resetPosition(): Promise<void>
  getPlacement(): Promise<WindowPlacement | null>
  showContextMenu(source?: WindowShowContextMenuInput['source']): Promise<void>
  /** 气泡显示/隐藏 → main 命中区域（v1.1 minor；v1.2 起改用 setBubbleRegion） */
  setBubbleVisible(visible: boolean): Promise<void>
  /** 气泡实际矩形（内容区 DIP，viewport 坐标）；null = 隐藏（v1.2 minor） */
  setBubbleRegion(rect: PetRect | null): Promise<void>

  // 设置
  getSettings(): Promise<Settings>
  updateSettings(patch: SettingsPatch): Promise<Settings>

  // 任务清单（v1.5 minor）
  listTasks(input: TasksListInput): Promise<TasksSnapshot>
  createTask(input: TaskCreateInput): Promise<Task>
  updateTask(input: TaskUpdateInput): Promise<Task>
  toggleTask(input: TaskToggleInput): Promise<Task>
  deleteTask(id: string): Promise<void>
  getTaskStats(): Promise<TaskStats>
  /** 30 秒内恢复本进程中删除的任务，原 ID 与状态保持不变。 */
  restoreTask(id: string): Promise<Task>
  /** 仅宠物窗口可调用，打开或聚焦任务面板。 */
  openTasks(): Promise<void>
  /** 0.4：搁置/恢复任务；done 任务拒绝搁置。 */
  setTaskArchived(input: { id: string; archived: boolean }): Promise<Task>

  // 项目（0.3.1b minor）
  listProjects(): Promise<Project[]>
  createProject(input: ProjectCreateInput): Promise<Project>
  updateProject(input: ProjectUpdateInput): Promise<Project>
  /** 仅允许删除空项目（无任务）；有任务时 reject。 */
  deleteProject(id: string): Promise<void>

  // 独立打卡（0.4.0，IPC 2.0；无旧 checkin）
  listHabits(): Promise<HabitSnapshot[]>
  createHabit(input: HabitCreateInput): Promise<HabitSnapshot>
  updateHabit(input: HabitUpdateInput): Promise<HabitSnapshot>
  deleteHabit(id: string): Promise<void>
  checkinHabit(input: HabitCheckinInput): Promise<HabitCheckinResult>
  listHabitHistory(input: HabitHistoryInput): Promise<HabitHistoryPage>
}

export type {
  Bootstrap,
  Habit,
  HabitCheckin,
  HabitCheckinInput,
  HabitCheckinResult,
  HabitCreateInput,
  HabitCycleSnapshot,
  HabitHistoryInput,
  HabitHistoryPage,
  HabitPatch,
  HabitSchedule,
  HabitSnapshot,
  HabitUpdateInput,
  PetEvent,
  Project,
  ProjectCreateInput,
  ProjectPatch,
  ProjectUpdateInput,
  Settings,
  SettingsPatch,
  Task,
  TaskCategory,
  TaskCategorySelection,
  TaskImportance,
  TaskPatch,
  TaskReminderState,
  TaskScope,
  TaskStats,
  TaskToggleInput,
  TaskUpdateInput,
  TaskView,
  TaskViewCounts,
  TasksListInput,
  TasksSnapshot,
  WindowPlacement,
}
