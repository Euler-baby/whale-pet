/**
 * 设置窗口 · Agent-Main
 *
 * v1 要求：设置用独立普通窗口（frame:true、不透明、可聚焦），不放在透明桌宠窗内，
 * 避免 IME/焦点问题（docs/05 §2、experiments #12）。
 *
 * 复用同一 preload（window.pet），但 IPC sender 校验按窗口角色白名单：
 * 设置窗只允许 app:bootstrap / settings:get / settings:update / window:reset-position。
 */
import { join } from 'node:path'

import { app, BrowserWindow } from 'electron'

import { hardenWebContents } from './harden'

const SETTINGS_WINDOW_SIZE = { width: 470, height: 480 } as const

let settingsWindow: BrowserWindow | null = null

export function getSettingsWindow(): BrowserWindow | null {
  if (settingsWindow === null || settingsWindow.isDestroyed()) return null
  return settingsWindow
}

function loadSettingsPage(win: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const loadPromise = devUrl
    ? win.loadURL(`${devUrl.replace(/\/$/, '')}/settings.html`)
    : win.loadFile(join(__dirname, '../renderer/settings.html'))
  loadPromise.catch((error: unknown) => {
    console.error('[settings-window] 设置页加载失败:', error)
  })
}

/** 打开（或聚焦已存在的）设置窗口 */
export function createSettingsWindow(): BrowserWindow {
  const existing = getSettingsWindow()
  if (existing !== null) {
    existing.show()
    existing.focus()
    return existing
  }

  const win = new BrowserWindow({
    width: SETTINGS_WINDOW_SIZE.width,
    height: SETTINGS_WINDOW_SIZE.height,
    // 150% 缩放下内容更高：默认给足高度，同时允许用户拉大/缩小，避免底部按钮被裁掉
    resizable: true,
    minWidth: 420,
    minHeight: 400,
    frame: true,
    transparent: false,
    backgroundColor: '#f7f9ff',
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: '设置 · DeepSeek 鲸鱼娘',
    webPreferences: {
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
    if (settingsWindow === win) settingsWindow = null
  })

  settingsWindow = win
  loadSettingsPage(win)
  return win
}
