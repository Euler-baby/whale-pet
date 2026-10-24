/**
 * 系统托盘 · Agent-Main
 *
 * 菜单（docs/05 §2 / docs/23 §5 / 0.4.1）：显示/隐藏、重置窗口位置、设置…、任务清单…、
 * 使用教程…、开机自启（复选框，默认关）、退出。
 * - 设置项变化后调用 `refreshTrayMenu()` 重建菜单（菜单未自动刷新）；
 * - 任务数据变化后调用 `refreshTrayTooltip()`：tooltip 显示今日剩余任务数；
 * - 自启在 dev/portable 下 applyAutostart 返回 false：只保存设置，不写 Run 项；
 * - 图标缺失时用内存占位 PNG 兜底，不能崩。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { app, Menu, nativeImage, Tray } from 'electron'
import type { MenuItemConstructorOptions, NativeImage } from 'electron'

import { applyAutostart, isAutostartSupported } from './platform/autostart'
import type { SettingsStore } from './services/settings-store'
import { broadcastSettings } from './settings-events'
import { getPetWindow, resetPosition, setVisible } from './windows/pet-window'
import { createSettingsWindow } from './windows/settings-window'
import { createTutorialWindow } from './windows/tutorial-window'

/** 16×16 蓝色圆点占位图（assets/tray.ico 缺失时保证托盘可见） */
const TRAY_FALLBACK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAQ0lEQVR42mNgoAVQTX79HxumSDNRhiArTFj6CwUTNASXRlwGEW0zUS7Bphkd4HXFMDKA7ECkOBqpkpCokpSpkplIBQB1vbkoLe7aKQAAAABJRU5ErkJggg=='

const TRAY_TOOLTIP = 'DeepSeek 鲸鱼娘'

export interface TrayDeps {
  settings: SettingsStore
  openSettings: () => void
  /** 打开任务清单窗口（托盘/右键菜单共用入口） */
  openTasks: () => void
  /** 今日任务摘要（如「今日还有 3 项」）；由 main 注入，避免 tray 直接依赖 store */
  getTaskSummary?: () => string
}

let tray: Tray | null = null
let deps: TrayDeps | null = null

/** 托盘图标路径：dev = app 根 assets/；packaged = resources/assets（extraResources） */
export function trayIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'assets', 'tray.ico')
    : join(app.getAppPath(), 'assets', 'tray.ico')
}

function loadTrayIcon(): NativeImage {
  const iconPath = trayIconPath()
  if (existsSync(iconPath)) {
    const image = nativeImage.createFromPath(iconPath)
    if (!image.isEmpty()) return image
    console.warn(`[tray] 图标文件为空/无法解码，使用内存占位图: ${iconPath}`)
  } else {
    console.warn(`[tray] 未找到托盘图标，使用内存占位图: ${iconPath}`)
  }
  return nativeImage.createFromBuffer(Buffer.from(TRAY_FALLBACK_PNG_BASE64, 'base64'))
}

function toggleVisible(): void {
  const win = getPetWindow()
  if (win === null) return
  setVisible(!win.isVisible())
}

function toggleAutostart(checked: boolean): void {
  if (deps === null || !isAutostartSupported()) return
  const next = deps.settings.update({ autostart: checked })
  const applied = applyAutostart(checked)
  if (!applied) {
    console.info('[tray] 当前运行形态不支持自启（dev/portable），仅保存设置')
  }
  refreshTrayMenu()
  // 设置页若打开，需即时反映托盘的修改（docs/16）
  broadcastSettings(next)
}

/** 托盘 tooltip：默认文案 + 今日任务摘要（摘要由 main 注入，异常时回退默认文案） */
function buildTooltip(): string {
  if (deps?.getTaskSummary === undefined) return TRAY_TOOLTIP
  try {
    const summary = deps.getTaskSummary()
    return summary.length > 0 ? `${TRAY_TOOLTIP} · ${summary}` : TRAY_TOOLTIP
  } catch (error) {
    console.error('[tray] 读取任务摘要失败（回退默认 tooltip）:', error)
    return TRAY_TOOLTIP
  }
}

function buildMenu(): Menu {
  const autostart = deps?.settings.get().autostart ?? false
  const template: MenuItemConstructorOptions[] = [
    { label: '显示/隐藏鲸鱼娘', click: toggleVisible },
    { label: '重置窗口位置', click: resetPosition },
    { type: 'separator' },
    { label: '设置…', click: () => deps?.openSettings() },
    { label: '任务清单…', click: () => deps?.openTasks() },
    // 0.4.1：静态教程窗口（无 preload/IPC），与宠物右键菜单一致
    { label: '使用教程…', click: () => createTutorialWindow() },
    {
      label: '开机自启（仅安装版）',
      type: 'checkbox',
      checked: autostart,
      enabled: isAutostartSupported(),
      click: (item) => toggleAutostart(item.checked),
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]
  return Menu.buildFromTemplate(template)
}

/** 设置变化后重建托盘菜单（Electron 的 Tray 菜单不会自动读取新状态） */
export function refreshTrayMenu(): void {
  if (tray === null) return
  tray.setContextMenu(buildMenu())
  tray.setToolTip(buildTooltip())
}

/** 任务数据变化后刷新 tooltip（不重建菜单；tooltip 不会被 Electron 自动刷新） */
export function refreshTrayTooltip(): void {
  if (tray === null) return
  tray.setToolTip(buildTooltip())
}

/** 打开设置窗口（托盘/右键菜单共用入口） */
export function openSettingsWindow(): void {
  createSettingsWindow()
}

/** 创建托盘（重复调用返回同一实例）；失败只记录，不阻塞窗口/主流程 */
export function createTray(trayDeps: TrayDeps): Tray | null {
  deps = trayDeps
  if (tray !== null) {
    refreshTrayMenu()
    return tray
  }
  try {
    const created = new Tray(loadTrayIcon())
    created.setToolTip(buildTooltip())
    created.setContextMenu(buildMenu())
    created.on('click', toggleVisible)
    tray = created
    return tray
  } catch (error) {
    console.error('[tray] 创建托盘失败（不阻塞启动）:', error)
    return null
  }
}

/** 退出前销毁托盘（Windows 上不 destroy 会残留图标） */
export function destroyTray(): void {
  if (tray === null) return
  tray.destroy()
  tray = null
  deps = null
}
