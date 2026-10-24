/**
 * 设置变更广播 · Agent-Main
 *
 * 为什么要广播：设置可由多个入口修改（设置窗、托盘复选框），Electron 菜单/窗口不会自动刷新。
 * main 在写库成功后把 `pet:event` 的 `settings` 事件推给所有已打开窗口；renderer 各自更新 UI。
 * 事件信封沿用 v1 契约（`PetEvent`），不新增通道。
 *
 * 0.4：任务窗也要收（任务表单显示“跟随默认（当前 N 分钟）”与 customReminderLeadMin），
 * 但 tasks 角色的调用权限不因此扩大（docs/35 §6.4）。
 */
import { IPC } from '@shared/ipc-channels'
import type { PetEvent, Settings } from '@shared/types'

import { getPetWindow } from './windows/pet-window'
import { getSettingsWindow } from './windows/settings-window'
import { getTasksWindow } from './windows/tasks-window'

export function broadcastSettings(settings: Settings): void {
  const payload = { type: 'settings', settings } satisfies PetEvent
  for (const win of [getPetWindow(), getSettingsWindow(), getTasksWindow()]) {
    if (win !== null && !win.webContents.isDestroyed()) {
      win.webContents.send(IPC.event, payload)
    }
  }
}
