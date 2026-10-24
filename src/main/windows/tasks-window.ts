/**
 * 任务清单窗口 · Agent-Main
 *
 * 口径（docs/34 §2.2、docs/36）：独立普通窗，默认 900×680、最小 720×480，
 * 可缩放、可聚焦、**可最大化/还原**（0.4 修复项），复用同一 preload（window.pet），
 * 不透明浅色背景，避免 IME/焦点问题。
 *
 * IPC sender 校验按窗口角色白名单（src/main/ipc.ts）：任务窗允许
 * app:bootstrap + tasks×8 + projects×4 + habits×6（契约 2.0）；设置窗仍 4 个。
 */
import { join } from 'node:path'

import { app, BrowserWindow } from 'electron'

import { hardenWebContents } from './harden'

const TASKS_WINDOW_SIZE = { width: 900, height: 680 } as const
const TASKS_WINDOW_MIN_SIZE = { width: 720, height: 480 } as const

let tasksWindow: BrowserWindow | null = null

export function getTasksWindow(): BrowserWindow | null {
  if (tasksWindow === null || tasksWindow.isDestroyed()) return null
  return tasksWindow
}

function loadTasksPage(win: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const loadPromise = devUrl
    ? win.loadURL(`${devUrl.replace(/\/$/, '')}/tasks.html`)
    : win.loadFile(join(__dirname, '../renderer/tasks.html'))
  loadPromise.catch((error: unknown) => {
    console.error('[tasks-window] 任务页加载失败:', error)
  })
}

/** 打开（或聚焦已存在的）任务清单窗口；单例，重复打开只聚焦 */
export function createTasksWindow(): BrowserWindow {
  const existing = getTasksWindow()
  if (existing !== null) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return existing
  }

  const win = new BrowserWindow({
    width: TASKS_WINDOW_SIZE.width,
    height: TASKS_WINDOW_SIZE.height,
    minWidth: TASKS_WINDOW_MIN_SIZE.width,
    minHeight: TASKS_WINDOW_MIN_SIZE.height,
    resizable: true,
    frame: true,
    transparent: false,
    backgroundColor: '#f7f9ff',
    minimizable: true,
    // 0.4：任务清单可最大化/还原（标题栏按钮与双击标题栏），仍可拖动缩放
    maximizable: true,
    fullscreenable: false,
    show: false,
    title: '任务清单 · DeepSeek 鲸鱼娘',
    webPreferences: {
      // A5：产物必须是 CJS（out/preload/index.js），sandbox:true 不支持 ESM preload
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged,
    },
  })
  win.setMenu(null)
  hardenWebContents(win)
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })
  win.on('closed', () => {
    // renderer 的 close 可先于原生 closed；此时用户可能已重新打开新窗口。
    // 旧窗口只能注销自身，不能清掉新窗口的 IPC sender 身份。
    if (tasksWindow === win) tasksWindow = null
  })

  tasksWindow = win
  loadTasksPage(win)
  return win
}
