/**
 * IPC 注册 · Agent-Main（契约 2.0 / ADR-0004）
 *
 * 硬规则：
 * 1. 全部 `ipcMain.handle`（不用 send/on 传业务请求）
 * 2. 每个 handler 入参先过 `IPC_INPUT_SCHEMAS[channel].parse(raw)`（strictObject 拒绝多余字段）
 * 3. 校验 sender 必须是受信窗口，并按 pet/settings/tasks 角色限制通道
 * 4. 未实现的能力不注册通道（契约里没有），不返回假数据
 *
 * 契约 2.0（0.4.0）共 31 个 invoke + 1 event：
 * app:bootstrap、window×9、settings×2、tasks×9、projects×4、habits×6。
 * 破坏性变更：删除 `pet:tasks:checkin`（旧整体打卡）与 TaskStats 旧打卡字段；
 * habits 完全独立于任务/项目/HUD/提醒，不写 tasks-changed（docs/35 §3.3、§6.4）。
 */
import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'

import type { z } from 'zod'

import { IPC, IPC_INPUT_SCHEMAS } from '@shared/ipc'
import type { IpcChannel, IpcInput, IpcInvokeChannel, IpcOutput } from '@shared/ipc'
import { IPC_VERSION } from '@shared/ipc-version'
import type { TaskStore } from '@shared/tasks'
import type { Bootstrap, SettingsPatch } from '@shared/types'

import { applyAutostart, isAutostartSupported } from './platform/autostart'
import { broadcastSettings } from './settings-events'
import type { SettingsStore } from './services/settings-store'
import { shouldInvalidateQueuedBeforeUpdate } from './services/task-hud'
import type { TaskHud } from './services/task-hud'
import { celebrateHabitCheckin, notifyHabitsChanged, notifyTasksChanged } from './task-events'
import { refreshTrayMenu } from './tray'
import {
  getClickThrough,
  getPlacement,
  getPetWindow,
  moveBy,
  resetPosition,
  setBubbleRegion,
  setBubbleVisible,
  setClickThrough,
  setVisible,
  showPetContextMenu,
} from './windows/pet-window'
import { getSettingsWindow } from './windows/settings-window'
import { createTasksWindow, getTasksWindow } from './windows/tasks-window'

/** sender 不是受信窗口，或通道不在该窗口角色的白名单内 */
export class IpcSenderRejectedError extends Error {
  constructor(senderId: number, channel: string) {
    super(
      `IPC_SENDER_REJECTED: 窗口/通道未授权 (webContentsId=${String(senderId)}, channel=${channel})`,
    )
    this.name = 'IpcSenderRejectedError'
  }
}

type SenderRole = 'pet' | 'settings' | 'tasks'

/** 设置窗只能访问这 4 个通道（最小权限；0.4 不扩大） */
const SETTINGS_ROLE_CHANNELS: ReadonlySet<IpcInvokeChannel> = new Set<IpcInvokeChannel>([
  IPC.appBootstrap,
  IPC.settingsGet,
  IPC.settingsUpdate,
  IPC.windowResetPosition,
])

/**
 * 任务清单窗：app:bootstrap + 任务数据通道（8 条，已删除旧 tasks:checkin）
 * + 项目 CRUD（4）+ 独立打卡（6）。仍不能调用 tasks:open 或窗口控制。
 */
const TASK_ROLE_CHANNELS: ReadonlySet<IpcInvokeChannel> = new Set<IpcInvokeChannel>([
  IPC.appBootstrap,
  IPC.tasksList,
  IPC.tasksCreate,
  IPC.tasksUpdate,
  IPC.tasksToggle,
  IPC.tasksDelete,
  IPC.tasksStats,
  IPC.tasksRestore,
  IPC.tasksSetArchived,
  IPC.projectsList,
  IPC.projectsCreate,
  IPC.projectsUpdate,
  IPC.projectsDelete,
  IPC.habitsList,
  IPC.habitsCreate,
  IPC.habitsUpdate,
  IPC.habitsDelete,
  IPC.habitsCheckin,
  IPC.habitsHistory,
])

function resolveSenderRole(senderId: number): SenderRole | null {
  const pet = getPetWindow()
  if (pet !== null && !pet.webContents.isDestroyed() && pet.webContents.id === senderId) {
    return 'pet'
  }
  const settings = getSettingsWindow()
  if (
    settings !== null &&
    !settings.webContents.isDestroyed() &&
    settings.webContents.id === senderId
  ) {
    return 'settings'
  }
  const tasks = getTasksWindow()
  if (tasks !== null && !tasks.webContents.isDestroyed() && tasks.webContents.id === senderId) {
    return 'tasks'
  }
  return null
}

type InputSchemas = { [C in IpcInvokeChannel]: z.ZodType<IpcInput<C>> }

/** 契约表已经用 satisfies 约束过，这里再显式收窄成「按通道索引得到精确入参类型」 */
const INPUT_SCHEMAS: InputSchemas = IPC_INPUT_SCHEMAS

type IpcHandler<C extends IpcInvokeChannel> = (
  input: IpcInput<C>,
  event: IpcMainInvokeEvent,
) => IpcOutput<C> | Promise<IpcOutput<C>>

/** 所有 invoke 通道（排除唯一的 main→renderer 推送通道 pet:event） */
export const INVOKE_CHANNELS: readonly IpcInvokeChannel[] = (
  Object.values(IPC) as IpcChannel[]
).filter((channel): channel is IpcInvokeChannel => channel !== IPC.event)

let registered = false

/** 校验 sender 为受信窗口，并按窗口角色检查通道白名单（先于入参解析/副作用） */
function assertTrustedSender(event: IpcMainInvokeEvent, channel: IpcInvokeChannel): void {
  const role = resolveSenderRole(event.sender.id)
  if (role === null) throw new IpcSenderRejectedError(event.sender.id, channel)
  if (role === 'settings' && !SETTINGS_ROLE_CHANNELS.has(channel)) {
    throw new IpcSenderRejectedError(event.sender.id, channel)
  }
  if (role === 'tasks' && !TASK_ROLE_CHANNELS.has(channel)) {
    throw new IpcSenderRejectedError(event.sender.id, channel)
  }
}

function buildBootstrap(settingsStore: SettingsStore, hud: TaskHud): Bootstrap {
  // 任务文件处于保护错误态时 getTasks 会 throw：bootstrap 仍必须可用，
  // 否则桌宠/任务窗连错误提示都加载不出来（main 仍拒绝一切任务写入）。
  let urgentTasks: Bootstrap['urgentTasks']
  try {
    urgentTasks = hud.getState(Date.now())
  } catch (error) {
    console.error('[hud] bootstrap 读取任务失败（任务数据处于保护错误态）:', error)
    urgentTasks = { tasks: [], total: 0, queued: 0 }
  }
  return {
    ipcVersion: IPC_VERSION,
    now: Date.now(),
    spriteState: 'idle',
    settings: settingsStore.get(),
    autostartSupported: isAutostartSupported(),
    windowVisible: getPetWindow()?.isVisible() ?? false,
    clickThrough: getClickThrough(),
    placement: getPlacement(),
    urgentTasks,
  }
}

/** 注册全部契约通道；重复调用幂等（避免 electron-vite 重载时重复 handle 报错） */
export function registerIpcHandlers(deps: {
  settings: SettingsStore
  tasks: TaskStore
  hud: TaskHud
}): void {
  if (registered) return
  registered = true

  /**
   * 任务/项目/设置变化后重算 HUD；失败不能影响业务写入结果。
   * 任务写操作会先 dropQueued 再 syncTasks（同时过滤报废队列并撤换已显示汇总）。
   */
  const refreshHud = (taskId?: string): void => {
    try {
      if (taskId !== undefined) deps.hud.dropQueued([taskId])
      deps.hud.syncTasks(Date.now())
    } catch (error) {
      console.error('[hud] HUD 刷新失败（不影响本次业务写入）:', error)
    }
  }

  /**
   * habits:list 可能原子推进周期并持久化：只有周期快照实际变化才广播 habits-changed，
   * 无变化不广播（避免刷新循环）。首次调用（缓存为空）只记录不广播。
   */
  let lastHabitCycleSignature: string | null = null
  const habitCycleSignature = (
    snapshots: readonly { habit: { id: string; currentCycle: { key: string } } }[],
  ): string =>
    snapshots.map((snapshot) => `${snapshot.habit.id}:${snapshot.habit.currentCycle.key}`).join('|')

  function handle<C extends IpcInvokeChannel>(channel: C, handler: IpcHandler<C>): void {
    ipcMain.handle(channel, (event, raw: unknown) => {
      assertTrustedSender(event, channel)
      const input = INPUT_SCHEMAS[channel].parse(raw)
      return handler(input, event)
    })
  }

  // app
  handle(IPC.appBootstrap, () => buildBootstrap(deps.settings, deps.hud))

  // 窗口（v1 单窗口；多窗口时改为 sender 推导目标窗口）
  handle(IPC.windowSetClickThrough, (input) => {
    setClickThrough(input.ignore)
  })
  handle(IPC.windowGetClickThrough, () => getClickThrough())
  handle(IPC.windowMoveBy, (input) => {
    moveBy(input.dx, input.dy)
  })
  handle(IPC.windowSetVisible, (input) => {
    setVisible(input.visible)
  })
  handle(IPC.windowResetPosition, () => {
    resetPosition()
  })
  handle(IPC.windowGetPlacement, () => getPlacement())
  handle(IPC.windowShowContextMenu, (input) => {
    showPetContextMenu(input.source)
  })
  handle(IPC.windowSetBubbleVisible, (input) => {
    setBubbleVisible(input.visible)
  })
  handle(IPC.windowSetBubbleRegion, (input) => {
    setBubbleRegion(input.rect)
  })

  // 设置（JSON 持久化；自启写入 HKCU Run，dev/portable 返回 false）
  handle(IPC.settingsGet, () => deps.settings.get())
  handle(IPC.settingsUpdate, (input) => {
    const next = deps.settings.update(input.patch as SettingsPatch)
    if (input.patch.autostart !== undefined) {
      const applied = applyAutostart(next.autostart)
      if (!applied) {
        console.info('[settings] 当前运行形态不支持自启（dev/portable），仅保存设置值')
      }
    }
    // 菜单不会自动读取新状态（复选框/设置页都可能改了设置）
    refreshTrayMenu()
    // 设置窗/任务窗保持打开时也要同步（0.4 任务表单读默认提醒）
    broadcastSettings(next)
    // hudScope 变化会影响 HUD 内容范围；customReminderLeadMin 由提醒 tick 读取
    refreshHud()
    return next
  })

  // 任务清单（JSON v3 持久化，main 单写者）：list 把 view/category/viewScope 交给 store
  handle(IPC.tasksList, (input) => deps.tasks.getSnapshot(input, Date.now()))
  handle(IPC.tasksCreate, (input) => {
    const task = deps.tasks.create(input, Date.now())
    notifyTasksChanged()
    refreshHud()
    return task
  })
  handle(IPC.tasksUpdate, (input) => {
    // 编辑备注/标题/重要性/提醒覆盖不应丢掉已排队提醒与已消费阶段；
    // 只有 dueAt 变化（或任务失效/状态变化）才作废旧队列（P2 回归修复）。
    const before = deps.tasks.getTasks().find((task) => task.id === input.id)
    const task = deps.tasks.update(input, Date.now())
    const invalidateQueued =
      before === undefined || shouldInvalidateQueuedBeforeUpdate(before, task)
    notifyTasksChanged()
    refreshHud(invalidateQueued ? task.id : undefined)
    return task
  })
  handle(IPC.tasksToggle, (input) => {
    const wasDone = deps.tasks.getTasks().find((task) => task.id === input.id)?.status === 'done'
    const task = deps.tasks.setDone(input, Date.now())
    // 完成/取消完成：清该任务排队项；只有新增完成才 celebrate
    notifyTasksChanged(!wasDone && task.status === 'done')
    refreshHud(task.id)
    return task
  })
  handle(IPC.tasksDelete, (input) => {
    deps.tasks.remove(input.id)
    notifyTasksChanged()
    refreshHud(input.id)
  })
  handle(IPC.tasksStats, () => deps.tasks.getStats(Date.now()))
  handle(IPC.tasksRestore, (input) => {
    const task = deps.tasks.restore(input.id, Date.now())
    notifyTasksChanged()
    // 恢复不复活旧队列；HUD 按当前资格重算
    refreshHud(task.id)
    return task
  })
  handle(IPC.tasksSetArchived, (input) => {
    const task = deps.tasks.setArchived(input.id, input.archived, Date.now())
    notifyTasksChanged()
    // 搁置/恢复：清该任务排队项；搁置任务不再进入 HUD/普通提醒
    refreshHud(task.id)
    return task
  })
  handle(IPC.tasksOpen, () => {
    createTasksWindow()
  })

  // 项目（0.3.1b，契约 1.8）：项目 CRUD；任务范围切换由 tasks:list project scope 承担
  handle(IPC.projectsList, () => [...deps.tasks.getProjects()])
  handle(IPC.projectsCreate, (input) => {
    const project = deps.tasks.createProject(input, Date.now())
    notifyTasksChanged()
    refreshHud()
    return project
  })
  handle(IPC.projectsUpdate, (input) => {
    const project = deps.tasks.updateProject(input, Date.now())
    notifyTasksChanged()
    refreshHud()
    return project
  })
  handle(IPC.projectsDelete, (input) => {
    deps.tasks.removeProject(input.id)
    notifyTasksChanged()
    refreshHud()
  })

  // 独立打卡（0.4.0，契约 2.0）：与任务/项目/HUD/提醒/统计完全独立（docs/35 §3.3）
  handle(IPC.habitsList, () => {
    const snapshots = deps.tasks.listHabits(Date.now())
    // list 可能原子推进周期：周期快照变化才广播（无变化不写盘/不广播，避免刷新循环）
    const signature = habitCycleSignature(snapshots)
    if (lastHabitCycleSignature !== null && signature !== lastHabitCycleSignature) {
      notifyHabitsChanged()
    }
    lastHabitCycleSignature = signature
    return snapshots
  })
  handle(IPC.habitsCreate, (input) => {
    const snapshot = deps.tasks.createHabit(input, Date.now())
    lastHabitCycleSignature = null
    notifyHabitsChanged()
    return snapshot
  })
  handle(IPC.habitsUpdate, (input) => {
    const snapshot = deps.tasks.updateHabit(input, Date.now())
    lastHabitCycleSignature = null
    notifyHabitsChanged()
    return snapshot
  })
  handle(IPC.habitsDelete, (input) => {
    deps.tasks.deleteHabit(input.id)
    lastHabitCycleSignature = null
    notifyHabitsChanged()
  })
  handle(IPC.habitsCheckin, (input) => {
    const result = deps.tasks.checkinHabit(input, Date.now())
    lastHabitCycleSignature = null
    notifyHabitsChanged()
    // 只有“当前周期首次成功持久化”才庆祝；重复/失败不庆祝（docs/35 §3.3）
    if (result.isNew) celebrateHabitCheckin()
    return result
  })
  handle(IPC.habitsHistory, (input) => deps.tasks.listHabitHistory(input))

  console.info(`[ipc] 契约 v${IPC_VERSION}：已注册 ${String(INVOKE_CHANNELS.length)} 个通道`)
}

/** 仅供测试/诊断：重置注册标记（重载场景不要调用） */
export function __resetIpcRegistrationForTest(): void {
  registered = false
}
