/**
 * 使用教程窗口 · Agent-Main（0.4.1 补丁）
 *
 * 纯静态窗口：不挂 preload、不开放任何 IPC/窗口角色，只展示 renderer 的教程页。
 * - 普通不透明窗口（frame:true、可聚焦/缩放），默认约 560×620，最小 480×420；
 * - 单例：重复打开只聚焦，不重复创建；
 * - dev 从 ELECTRON_RENDERER_URL 加载 /tutorial.html，生产加载 out/renderer/tutorial.html；
 * - hardenWebContents：拒绝页面导航与新窗口。
 *
 * 入口：宠物右键菜单与托盘菜单的「使用教程…」（不新增 IPC 通道/角色）。
 */
import { join } from 'node:path'

import { app, BrowserWindow } from 'electron'

import { hardenWebContents } from './harden'

const TUTORIAL_WINDOW_SIZE = { width: 560, height: 620 } as const
const TUTORIAL_WINDOW_MIN_SIZE = { width: 480, height: 420 } as const

let tutorialWindow: BrowserWindow | null = null

export function getTutorialWindow(): BrowserWindow | null {
  if (tutorialWindow === null || tutorialWindow.isDestroyed()) return null
  return tutorialWindow
}

function loadTutorialPage(win: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const loadPromise = devUrl
    ? win.loadURL(`${devUrl.replace(/\/$/, '')}/tutorial.html`)
    : win.loadFile(join(__dirname, '../renderer/tutorial.html'))
  loadPromise.catch((error: unknown) => {
    console.error('[tutorial-window] 教程页加载失败:', error)
  })
}

/** 打开（或聚焦已存在的）使用教程窗口；单例，重复打开只聚焦 */
export function createTutorialWindow(): BrowserWindow {
  const existing = getTutorialWindow()
  if (existing !== null) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return existing
  }

  const win = new BrowserWindow({
    width: TUTORIAL_WINDOW_SIZE.width,
    height: TUTORIAL_WINDOW_SIZE.height,
    minWidth: TUTORIAL_WINDOW_MIN_SIZE.width,
    minHeight: TUTORIAL_WINDOW_MIN_SIZE.height,
    resizable: true,
    frame: true,
    transparent: false,
    backgroundColor: '#f7f9ff',
    minimizable: true,
    // 教程是阅读页：不提供最大化，避免内容被拉宽后行宽失控
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: '使用教程 · 鲸鱼娘',
    webPreferences: {
      // 静态页：无 preload、无 Node/integration 能力，也不需要任何 IPC 角色；
      // 保持 Chromium sandbox + contextIsolation，教程页只是普通网页。
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
    // renderer 的 close 可先于原生 closed；旧窗口只注销自身，不影响可能已新建的窗口
    if (tutorialWindow === win) tutorialWindow = null
  })

  tutorialWindow = win
  loadTutorialPage(win)
  return win
}
