/**
 * preload · Agent-Main（契约 v1）
 *
 * A5：必须构建为 **CJS**（`sandbox:true` 不支持 ESM preload）；产物 `out/preload/index.js`。
 * 本文件只做 contextBridge 白名单转发：
 * - 不 import 任何 Node 内置（只用 electron 的 contextBridge / ipcRenderer）
 * - 不暴露 ipcRenderer / require / path / process
 * - renderer 唯一出口是 `window.pet`
 *
 * 关键：通道常量从 `@shared/ipc-channels` 引入（zod-free），类型从 `@shared/ipc` **type-only** 引入；
 * 这样 preload 产物只 `require("electron")`，不会把 zod 带进 sandbox preload。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

import { IPC } from '@shared/ipc-channels'
import type { IpcInput, IpcInvokeChannel, IpcOutput, PetApi, PetEvent } from '@shared/ipc'

/** 白名单 invoke 转发：类型由契约的 IpcInvokeMap 推导，preload 不写业务逻辑 */
function invoke<C extends IpcInvokeChannel>(
  channel: C,
  input?: IpcInput<C>,
): Promise<IpcOutput<C>> {
  return ipcRenderer.invoke(channel, input) as Promise<IpcOutput<C>>
}

const api: PetApi = {
  bootstrap: () => invoke(IPC.appBootstrap),

  onEvent(listener) {
    const handler = (_event: IpcRendererEvent, event: PetEvent): void => {
      listener(event)
    }
    ipcRenderer.on(IPC.event, handler)
    return () => {
      ipcRenderer.removeListener(IPC.event, handler)
    }
  },

  // 窗口
  setClickThrough: (ignore) => invoke(IPC.windowSetClickThrough, { ignore }),
  getClickThrough: () => invoke(IPC.windowGetClickThrough),
  moveBy: (dx, dy) => invoke(IPC.windowMoveBy, { dx, dy }),
  setVisible: (visible) => invoke(IPC.windowSetVisible, { visible }),
  resetPosition: () => invoke(IPC.windowResetPosition),
  getPlacement: () => invoke(IPC.windowGetPlacement),
  showContextMenu: (source) =>
    invoke(IPC.windowShowContextMenu, source === undefined ? {} : { source }),
  setBubbleVisible: (visible) => invoke(IPC.windowSetBubbleVisible, { visible }),
  setBubbleRegion: (rect) => invoke(IPC.windowSetBubbleRegion, { rect }),

  // 设置
  getSettings: () => invoke(IPC.settingsGet),
  updateSettings: (patch) => invoke(IPC.settingsUpdate, { patch }),

  // 任务清单（v1.5）
  listTasks: (input) => invoke(IPC.tasksList, input),
  createTask: (input) => invoke(IPC.tasksCreate, input),
  updateTask: (input) => invoke(IPC.tasksUpdate, input),
  toggleTask: (input) => invoke(IPC.tasksToggle, input),
  deleteTask: (id) => invoke(IPC.tasksDelete, { id }),
  getTaskStats: () => invoke(IPC.tasksStats),
  restoreTask: (id) => invoke(IPC.tasksRestore, { id }),
  openTasks: () => invoke(IPC.tasksOpen),
  setTaskArchived: (input) => invoke(IPC.tasksSetArchived, input),

  // 项目（0.3.1b，契约 1.8）
  listProjects: () => invoke(IPC.projectsList),
  createProject: (input) => invoke(IPC.projectsCreate, input),
  updateProject: (input) => invoke(IPC.projectsUpdate, input),
  deleteProject: (id) => invoke(IPC.projectsDelete, { id }),

  // 独立打卡（0.4.0，IPC 2.0）
  listHabits: () => invoke(IPC.habitsList),
  createHabit: (input) => invoke(IPC.habitsCreate, input),
  updateHabit: (input) => invoke(IPC.habitsUpdate, input),
  deleteHabit: (id) => invoke(IPC.habitsDelete, { id }),
  checkinHabit: (input) => invoke(IPC.habitsCheckin, input),
  listHabitHistory: (input) => invoke(IPC.habitsHistory, input),
}

contextBridge.exposeInMainWorld('pet', api)
