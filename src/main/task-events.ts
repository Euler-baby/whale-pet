/**
 * main → 界面的数据变更通知 · Agent-Main
 *
 * 两类数据完全独立（docs/35 §3.3、§6.3）：
 * - 任务/项目提交成功 → `tasks-changed`（任务窗+宠物窗重新取数/重算）
 * - Habit 提交成功 → `habits-changed`（只让任务窗重新取打卡快照），**不写 tasks-changed**，
 *   也不触发任务统计/HUD/提醒重算
 * 窗口销毁/发送失败不能把已经成功的保存变成 IPC 失败，因此这里只记录不抛。
 */
import { IPC } from '@shared/ipc-channels'
import type { PetEvent } from '@shared/types'

import type { BrowserWindow } from 'electron'

import { refreshTrayTooltip } from './tray'
import { getPetWindow } from './windows/pet-window'
import { getTasksWindow } from './windows/tasks-window'

function sendToWindows(event: PetEvent, wins: readonly (BrowserWindow | null)[]): void {
  for (const win of wins) {
    if (win === null || win.webContents.isDestroyed()) continue
    try {
      win.webContents.send(IPC.event, event)
    } catch (error) {
      console.warn('[tasks] 窗口通知失败，下次聚焦将刷新:', error)
    }
  }
}

/** 任务/项目数据已提交后通知界面；`completed=true` 时额外播放完成庆祝（宠物可见才发）。 */
export function notifyTasksChanged(completed = false): void {
  try {
    refreshTrayTooltip()
  } catch (error) {
    console.warn('[tasks] 托盘摘要刷新失败:', error)
  }
  sendToWindows({ type: 'tasks-changed' }, [getTasksWindow(), getPetWindow()])
  if (!completed) return
  const pet = getPetWindow()
  if (pet === null || pet.webContents.isDestroyed() || !pet.isVisible()) return
  try {
    const event: PetEvent = { type: 'pet-state', spriteState: 'happy' }
    pet.webContents.send(IPC.event, event)
    pet.webContents.send(IPC.event, { type: 'pet-action', action: 'celebrate' } satisfies PetEvent)
  } catch (error) {
    console.warn('[tasks] 完成动画通知失败:', error)
  }
}

/** Habit 数据（新建/编辑/删除/打卡/周期推进）提交成功 → 只通知任务窗刷新打卡页。 */
export function notifyHabitsChanged(): void {
  sendToWindows({ type: 'habits-changed' }, [getTasksWindow()])
}

/**
 * 首次打卡成功（isNew=true 且已持久化）→ 复用现有 celebrate。
 * - 宠物隐藏时不发送（docs/35 §3.3：隐藏宠物不发送动作）；
 * - 减少动态效果由 renderer 现有动作层（staticMode）抑制，main 不重复判断；
 * - 只是瞬时动作，不写任务统计、不触发 HUD/提醒。
 */
export function celebrateHabitCheckin(): void {
  const pet = getPetWindow()
  if (pet === null || pet.webContents.isDestroyed() || !pet.isVisible()) return
  try {
    pet.webContents.send(IPC.event, {
      type: 'pet-action',
      action: 'celebrate',
    } satisfies PetEvent)
  } catch (error) {
    console.warn('[habits] 打卡庆祝动作发送失败（数据已保存）:', error)
  }
}
