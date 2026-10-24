/**
 * main 入口 · Agent-Main（v1 桌宠壳 + 任务清单 / 独立打卡）
 *
 * 启动顺序：
 * 1. `app.whenReady` 之前拿单实例锁，失败直接退出
 * 2. ready 后 setAppUserModelId（必须等于 electron-builder appId）
 * 3. 注入 screen → 创建透明置顶窗 → 先初始化任务存储（v2→v3 迁移/备份）
 *    → 再初始化设置存储 → 注册 IPC → 托盘 → 到期提醒
 * 4. 退出：标记 quitting（允许窗口真正关闭）→ 保存位置 / flush 设置与任务 / 销毁托盘
 *
 * 0.4.0：tasks.json v3（迁移先备份原始 v2/settings，失败保护原文件）；任务提醒升级为
 * soon/due 两阶段消费 + 任务级/全局自定义提前量；独立 habit 打卡只推送 habits-changed。
 * 顺序要点：task store 必须先于 settings store 创建——迁移需要读取 settings 原始字节做备份，
 * 而 settings store 的坏文件回退会重命名原件（docs/35 §5.1）。
 */
import { app, globalShortcut, screen } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { IPC } from '@shared/ipc-channels'
import type { PetEvent } from '@shared/types'

import { registerIpcHandlers } from './ipc'
import { applyAutostart } from './platform/autostart'
import { setScreenApi } from './platform/display'
import { resolvePortableUserDataPath } from './platform/runtime-paths'
import { acquireSingleInstanceLock, installSecondInstanceHandler } from './platform/single-instance'
import { createSettingsStore } from './services/settings-store'
import { createTaskHud } from './services/task-hud'
import { createTaskReminder } from './services/task-reminder'
import { createTaskStore } from './services/task-store'
import { createTray, destroyTray, refreshTrayTooltip } from './tray'
import {
  createPetWindow,
  getPetWindow,
  markQuitting,
  savePlacementNow,
  setVisible,
} from './windows/pet-window'
import { createSettingsWindow } from './windows/settings-window'
import { createTasksWindow } from './windows/tasks-window'

/** 必须与 electron-builder.yml 的 appId 一致 */
const APP_USER_MODEL_ID = 'com.deepseek.whalepet'

/** 任务提醒/汇总气泡固定 12 秒（0.4.2：原 8s；renderer 读取事件 durationMs 自动消失） */
const TASK_BUBBLE_DURATION_MS = 12_000

/** 气泡 id 只需窗口内唯一（renderer 用它去重/关闭） */
let bubbleSeq = 0

function nextBubbleId(prefix: string): string {
  bubbleSeq += 1
  return `${prefix}-${String(Date.now())}-${String(bubbleSeq)}`
}

/** 向宠物窗发送应用内气泡；窗口不存在/已销毁/隐藏时静默跳过。成功返回 bubbleId。 */
function sendBubbleToPet(text: string): string | null {
  const win = getPetWindow()
  if (
    win === null ||
    win.webContents.isDestroyed() ||
    !win.isVisible() ||
    win.webContents.isLoadingMainFrame()
  )
    return null
  const now = Date.now()
  const bubbleId = nextBubbleId('task')
  const event: PetEvent = {
    type: 'bubble',
    bubble: {
      id: bubbleId,
      text,
      createdAt: now,
      durationMs: TASK_BUBBLE_DURATION_MS,
      action: 'open-tasks',
    },
  }
  try {
    win.webContents.send(IPC.event, event)
  } catch (error) {
    console.warn('[main] 气泡发送失败:', error)
    return null
  }
  return bubbleId
}

/** 撤下已显示的提醒/汇总气泡（不依赖窗口可见：隐藏时 renderer 也会清掉） */
function dismissBubbleToPet(bubbleId: string): void {
  const win = getPetWindow()
  if (win === null || win.webContents.isDestroyed()) return
  try {
    win.webContents.send(IPC.event, {
      type: 'bubble-dismiss',
      bubbleId,
    } satisfies PetEvent)
  } catch (error) {
    console.warn('[main] 气泡撤下失败:', error)
  }
}

/** 向宠物窗广播 main → renderer 事件（HUD 状态等）；窗口不可用时静默跳过 */
function sendEventToPet(event: PetEvent): void {
  const win = getPetWindow()
  if (win === null || win.webContents.isDestroyed()) return
  win.webContents.send(IPC.event, event)
}

function onReady(): void {
  app.setAppUserModelId(APP_USER_MODEL_ID)

  // display.ts 不直接 import electron：这里注入 screen，便于纯几何函数单测
  setScreenApi(screen)
  createPetWindow({ initiallyVisible: !process.argv.includes('--hidden') })

  const userData = app.getPath('userData')
  // 先建任务存储：v2→v3 迁移会在修改任何文件前备份 tasks/settings 原始字节
  const tasks = createTaskStore({
    filePath: join(userData, 'tasks.json'),
    settingsFilePath: join(userData, 'settings.json'),
    backupRoot: join(userData, 'backups'),
    appVersion: app.getVersion(),
  })
  // 再建设置存储（读取允许缺 version；新写入 version=1；迁移本身不改 settings）
  const settings = createSettingsStore(join(userData, 'settings.json'))
  // 启动时对齐自启状态；dev/portable 下为 no-op（设置值仍保存）
  applyAutostart(settings.get().autostart)

  /** 托盘 tooltip 摘要：今日未完成数（数据变化后由 IPC handler 刷新） */
  const taskSummary = (): string => {
    try {
      const stats = tasks.getStats(Date.now())
      const remaining = Math.max(0, stats.todayTotal - stats.todayDone)
      return `今日还有 ${String(remaining)} 项`
    } catch {
      return '任务数据读取失败，请打开任务清单查看'
    }
  }

  // HUD（0.4，契约 2.0）：HUD 只含活动任务；普通提醒排队/汇总；任务/项目/设置变化后由 IPC 刷新
  const hud = createTaskHud({
    getTasks: () => tasks.getTasks(),
    getProjects: () => tasks.getProjects(),
    getSettings: () => settings.get(),
    sendEvent: sendEventToPet,
    sendBubble: sendBubbleToPet,
    dismissBubble: dismissBubbleToPet,
    consumeReminder: (input) => {
      tasks.consumeReminder(input)
    },
    bubbleDurationMs: TASK_BUBBLE_DURATION_MS,
  })

  registerIpcHandlers({ settings, tasks, hud })
  createTray({
    settings,
    openSettings: createSettingsWindow,
    openTasks: createTasksWindow,
    getTaskSummary: taskSummary,
  })

  // 到期提醒：30s tick；宠物窗隐藏时跳过不消费，显示后补发（docs/35 §4）
  // 提前量每 tick 从设置/任务覆盖读取；HUD 活跃时普通提醒排队，空闲汇总
  const reminder = createTaskReminder({
    getTasks: () => tasks.getTasks(),
    consumeReminder: (input) => {
      tasks.consumeReminder(input)
    },
    sendBubble: (text) => sendBubbleToPet(text) !== null,
    getSettings: () => settings.get(),
    hud,
    isPetVisible: () => {
      refreshTrayTooltip()
      const win = getPetWindow()
      return win !== null && win.isVisible() && !win.webContents.isLoadingMainFrame()
    },
  })
  reminder.start()

  // 全局快捷键 Ctrl+Alt+T：打开任务清单（被占用/不支持时静默忽略）
  try {
    const registered = globalShortcut.register('CommandOrControl+Alt+T', createTasksWindow)
    if (!registered) {
      console.info('[main] 全局快捷键 Ctrl+Alt+T 注册失败（可能已被占用），忽略')
    }
  } catch (error) {
    console.warn('[main] 全局快捷键 Ctrl+Alt+T 注册异常（忽略）:', error)
  }

  app.on('will-quit', () => {
    // 释放全局快捷键（Windows 上不释放可能影响下次注册）
    globalShortcut.unregisterAll()
  })

  app.on('before-quit', () => {
    reminder.stop()
    // 设置文件损坏/不可写时 flush 按保护语义抛错：退出路径只记录，不阻止退出、不覆盖原文件
    try {
      settings.flush()
    } catch (error) {
      console.warn('[settings] 退出前保存失败（不阻止退出，原文件保持受保护状态）:', error)
    }
    tasks.flush()
  })

  console.info('[main] DeepSeek 鲸鱼娘 v1 已启动（窗口 + 托盘 + 设置 + 任务清单 + 打卡）')
}

function main(): void {
  // 单实例锁必须先于 whenReady；second-instance 处理器尽早注册
  installSecondInstanceHandler(() => {
    setVisible(true)
  })

  app.on('before-quit', () => {
    // 允许 pet-window 的 close 处理器真正关闭（否则 close 会被拦截为 hide）
    markQuitting()
    savePlacementNow()
    destroyTray()
  })

  // 窗口被销毁（崩溃/退出）后退出进程；正常「关闭」已被 pet-window 转为 hide
  app.on('window-all-closed', () => {
    app.quit()
  })

  void app
    .whenReady()
    .then(onReady)
    .catch((error: unknown) => {
      console.error('[main] 启动失败:', error)
      app.quit()
    })
}

/** portable 的锁、设置和窗口位置必须使用同一个 exe 旁数据目录。 */
function configureRuntimePaths(): boolean {
  const userData = resolvePortableUserDataPath({
    isPackaged: app.isPackaged,
    portableExecutableDir: process.env['PORTABLE_EXECUTABLE_DIR'],
    argv: process.argv,
  })
  if (userData === null) return true
  try {
    mkdirSync(userData, { recursive: true })
    app.setPath('userData', userData)
    return true
  } catch (error) {
    console.error('[main] 无法创建便携版数据目录:', userData, error)
    return false
  }
}

// 数据目录决定单实例锁的作用域，必须先设置，再拿锁，最后 whenReady。
if (configureRuntimePaths() && acquireSingleInstanceLock()) {
  main()
} else {
  app.quit()
}
