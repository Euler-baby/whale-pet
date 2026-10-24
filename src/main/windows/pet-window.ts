/**
 * 桌宠主窗口 · Agent-Main
 *
 * 口径：PLAN §6「320×400 DIP 透明无边框置顶窗」、02-arch §2.2/§9。
 * - transparent + frame:false + backgroundColor:'#00000000'
 * - 默认点击穿透 `setIgnoreMouseEvents(true, { forward: true })`；命中精灵/气泡后由 renderer
 *   经 IPC 关闭穿透（M1 完整命中逻辑，M0 只提供开关）
 * - 位置记忆不依赖 display.id：见 platform/display.ts
 * - 安全：will-navigate / window.open 一律 deny（02-arch §2.3）
 */
import { join } from 'node:path'

import { app, BrowserWindow, Menu } from 'electron'

import { IPC } from '@shared/ipc-channels'
import { PET_WINDOW_SIZE } from '@shared/pet-layout'
import type { PetRect } from '@shared/pet-layout'
import type { PetEvent, WindowPlacement } from '@shared/types'

import {
  clampToDisplayArea,
  createJsonPlacementStorage,
  createWindowPlacement,
  defaultWindowPosition,
  loadWindowPlacement,
  restoreWindowPosition,
  saveWindowPlacement,
} from '../platform/display'
import type { PlacementStorage } from '../platform/display'
import {
  noteDragActivity,
  setBubbleRegion as setHitBubbleRegion,
  setBubbleVisible as setHitBubbleVisible,
  startPointerHitTest,
  stopPointerHitTest,
} from './pointer-hit'
import { createSettingsWindow } from './settings-window'
import { createTasksWindow } from './tasks-window'
import { createTutorialWindow } from './tutorial-window'

export { PET_WINDOW_SIZE }

/** 拖拽/移动后延迟落盘，避免 moved 事件高频写文件 */
const PLACEMENT_SAVE_DEBOUNCE_MS = 250

let petWindow: BrowserWindow | null = null
let clickThrough = true
/** true = 正在退出（允许 close 真正销毁窗口）；否则 close 一律转为 hide */
let quitting = false
let placementStorage: PlacementStorage | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
/** ready-to-show 异步触发；隐藏启动与后续用户显示操作共用此意图。 */
let visibleWhenReady = true

function getPlacementStorage(): PlacementStorage {
  if (placementStorage === null) {
    placementStorage = createJsonPlacementStorage(
      join(app.getPath('userData'), 'window-placement.json'),
    )
  }
  return placementStorage
}

/** 当前唯一主窗口（IPC sender 校验用；null = 未创建/已销毁） */
export function getPetWindow(): BrowserWindow | null {
  if (petWindow === null || petWindow.isDestroyed()) return null
  return petWindow
}

/** 标记「正在退出」：只有此时 close 才会真正关闭窗口（否则 = 隐藏到托盘） */
export function markQuitting(): void {
  quitting = true
}

function cancelScheduledPlacementSave(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
}

/** 立即保存窗口位置（关窗/重置位置时调用） */
export function savePlacementNow(): void {
  cancelScheduledPlacementSave()
  const win = getPetWindow()
  if (win === null) return
  saveWindowPlacement(getPlacementStorage(), createWindowPlacement(win.getBounds()))
}

function schedulePlacementSave(): void {
  cancelScheduledPlacementSave()
  saveTimer = setTimeout(() => {
    saveTimer = null
    const win = getPetWindow()
    if (win === null) return
    saveWindowPlacement(getPlacementStorage(), createWindowPlacement(win.getBounds()))
  }, PLACEMENT_SAVE_DEBOUNCE_MS)
}

/** 窗口安全基线：禁一切页面内导航与新窗口（02-arch §2.3） */
function hardenWebContents(win: BrowserWindow): void {
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    console.warn('[pet-window] 已拒绝页面导航:', url)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    console.warn('[pet-window] 已拒绝新窗口:', url)
    return { action: 'deny' }
  })
}

/**
 * dev 兜底占位页：renderer（Agent-UI）尚未构建/加载失败时，仍能验证
 * main + preload + bootstrap 链路。仅未打包环境触发，正常 renderer 就绪后不会执行。
 * TODO(M1): renderer 稳定后删除这个临时兜底（问题应暴露为启动失败而不是静默占位）。
 */
function devFallbackHtml(): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<style>html,body{background:transparent;color:#9cc3ff;',
    'font:12px/1.5 system-ui,Segoe UI,sans-serif;margin:0;padding:16px}</style></head><body>',
    '<div>renderer 未就绪（Agent-UI），当前为 M0 临时占位页</div>',
    '<div id="ipc">正在检查 window.pet.bootstrap() …</div>',
    '<script>',
    "const el=document.getElementById('ipc')",
    "if(window.pet&&typeof window.pet.bootstrap==='function'){",
    'window.pet.bootstrap().then((data)=>{',
    "el.textContent='bootstrap ok · ipcVersion='+data.ipcVersion+' · dayKey='+data.dayKey",
    "}).catch((error)=>{el.textContent='bootstrap 失败: '+String(error&&error.message||error)})",
    "}else{el.textContent='window.pet 未注入（preload 未生效）'}",
    '</script></body></html>',
  ].join('')
}

function loadRenderer(win: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const loadPromise = devUrl
    ? win.loadURL(devUrl)
    : win.loadFile(join(__dirname, '../renderer/index.html'))
  loadPromise.catch((error: unknown) => {
    console.error('[pet-window] renderer 加载失败:', error)
  })
}

/**
 * 把窗口收敛到目标内容区 320×400（docs/05 §2.1）。
 *
 * 150% DPI 下实测：`useContentSize`/`setContentSize` 会得到 322×402（多 2 DIP），
 * 而直接 `setBounds(320×400)` 外框可达标准。因此以「外框 320×400」建窗，
 * 再用内容区实测值做最多 3 次自校正；resizable:false 下尺寸只应被外部意外改动。
 */
let enforcingSize = false

function enforceContentSize(win: BrowserWindow): void {
  if (win.isDestroyed() || enforcingSize) return
  enforcingSize = true
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const content = win.getContentBounds()
      const outer = win.getBounds()
      const deltaWidth = PET_WINDOW_SIZE.width - content.width
      const deltaHeight = PET_WINDOW_SIZE.height - content.height
      if (deltaWidth === 0 && deltaHeight === 0) {
        if (attempt > 0) {
          console.info(
            `[pet-window] 尺寸自校正完成：content=${String(content.width)}×${String(content.height)}`,
          )
        }
        return
      }
      win.setBounds({
        x: outer.x,
        y: outer.y,
        width: outer.width + deltaWidth,
        height: outer.height + deltaHeight,
      })
    }
    console.warn('[pet-window] 无法把内容区修正到 320×400:', win.getContentBounds())
  } finally {
    enforcingSize = false
  }
}

function createBrowserWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: PET_WINDOW_SIZE.width,
    height: PET_WINDOW_SIZE.height,
    frame: false,
    // 去原生边框/阴影，避免 150% DPI 下外框比内容区多 1 DIP
    thickFrame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    title: 'DeepSeek 鲸鱼娘',
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
  win.setAlwaysOnTop(true, 'normal')
  hardenWebContents(win)
  return win
}

/** 创建（或返回已存在的）桌宠主窗口。只在 app ready 后调用。 */
export function createPetWindow(options: { initiallyVisible?: boolean } = {}): BrowserWindow {
  const existing = getPetWindow()
  if (existing !== null) return existing

  const win = createBrowserWindow()
  visibleWhenReady = options.initiallyVisible ?? true
  petWindow = win
  const sendVisibility = (): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    const event: PetEvent = { type: 'window-visibility', visible: win.isVisible() }
    win.webContents.send(IPC.event, event)
  }
  win.on('show', sendVisibility)
  win.on('hide', sendVisibility)
  clickThrough = true
  win.setIgnoreMouseEvents(true, { forward: true })
  // 命中轮询：命中精灵/可见气泡 → 关穿透；其余透明区 → 穿透（docs/05 §2.1）
  startPointerHitTest(win, (ignore) => {
    clickThrough = ignore
    win.setIgnoreMouseEvents(ignore, { forward: true })
  })

  // 恢复位置（M0：userData JSON；M2 接 pet_state.window_json，接口不变）
  const saved = loadWindowPlacement(getPlacementStorage())
  const target = saved !== null ? restoreWindowPosition(PET_WINDOW_SIZE, saved) : null
  const position = target ?? defaultWindowPosition(PET_WINDOW_SIZE)
  // 显式按外框 320×400 放置，再做内容区自校正（docs/05 §2.1）
  win.setBounds({
    x: position.x,
    y: position.y,
    width: PET_WINDOW_SIZE.width,
    height: PET_WINDOW_SIZE.height,
  })
  enforceContentSize(win)

  let fallbackShown = false
  win.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 /* ERR_ABORTED：正常换页 */) return
      console.error(
        `[pet-window] renderer 加载失败 code=${String(errorCode)} (${errorDescription}) url=${String(validatedURL)}`,
      )
      if (app.isPackaged || fallbackShown) return
      fallbackShown = true
      void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(devFallbackHtml())}`)
      if (visibleWhenReady) win.showInactive()
    },
  )

  win.once('ready-to-show', () => {
    // 显示前再校正一次：不同 DPI/主题下首次布局可能改变内容区
    enforceContentSize(win)
    if (visibleWhenReady) win.showInactive()
  })
  win.on('moved', () => {
    schedulePlacementSave()
  })
  // 防御：外部意外 resize 时恢复 320×400（正常路径不会触发用户缩放）
  win.on('resize', () => {
    if (enforcingSize) return
    const bounds = win.getBounds()
    console.warn(
      `[pet-window] 检测到外部 resize: ${String(bounds.width)}×${String(bounds.height)}（将恢复 320×400）`,
    )
    enforceContentSize(win)
  })
  win.on('close', (event) => {
    savePlacementNow()
    if (quitting) return
    // v1：关窗 = 隐藏到托盘，不退出进程（退出只从托盘/右键菜单）
    event.preventDefault()
    visibleWhenReady = false
    win.hide()
  })
  win.on('closed', () => {
    stopPointerHitTest()
    cancelScheduledPlacementSave()
    petWindow = null
  })

  loadRenderer(win)
  return win
}

// ---------------------------------------------------------------------------
// window:* IPC 背后的行为
// ---------------------------------------------------------------------------

/** 点击穿透开关（02 §2.2：true 时 forward mousemove 供 renderer 命中判断） */
export function setClickThrough(ignore: boolean): void {
  const win = getPetWindow()
  if (win === null) return
  clickThrough = ignore
  win.setIgnoreMouseEvents(ignore, { forward: true })
}

export function getClickThrough(): boolean {
  return clickThrough
}

/**
 * 按 DIP 位移并钳制到目标屏幕 display.bounds（拖拽用；0.4.2）。
 * - 用户确认可拖到屏幕最底部并覆盖任务栏，但至少整窗可见；
 * - 用窗口中心找最近屏幕，再按 display.bounds 钳制 x/y（不再用排除任务栏的 workArea）。
 */
export function moveBy(dx: number, dy: number): void {
  const win = getPetWindow()
  if (win === null) return
  noteDragActivity()
  const bounds = win.getBounds()
  const target = clampToDisplayArea(PET_WINDOW_SIZE, { x: bounds.x + dx, y: bounds.y + dy })
  win.setPosition(target.x, target.y)
  schedulePlacementSave()
}

/** 气泡可见性：只有可见时把气泡区域纳入命中（renderer 在显示/隐藏时调用） */
export function setBubbleVisible(visible: boolean): void {
  setHitBubbleVisible(visible)
}

/** 气泡实际矩形（内容区 DIP；v1.2）：精确命中，避免整块 300×140 吃掉透明区点击 */
export function setBubbleRegion(rect: PetRect | null): void {
  setHitBubbleRegion(rect)
}

/** 显示/隐藏（关窗=隐藏不退出是 M1 行为；M0 由托盘「显示/隐藏」使用） */
export function setVisible(visible: boolean): void {
  visibleWhenReady = visible
  const win = getPetWindow()
  if (win === null) return
  if (visible) {
    win.showInactive()
  } else {
    win.hide()
  }
}

/** 回到主屏右下角默认位置 */
export function resetPosition(): void {
  const win = getPetWindow()
  if (win === null) return
  const position = defaultWindowPosition(PET_WINDOW_SIZE)
  win.setPosition(position.x, position.y)
  savePlacementNow()
  console.info('[pet-window] 窗口位置已重置')
}

/** 当前窗口位置快照（window:get-placement） */
export function getPlacement(): WindowPlacement | null {
  const win = getPetWindow()
  if (win === null) return null
  return createWindowPlacement(win.getBounds())
}

/**
 * 宠物右键原生菜单：显示/隐藏、重置位置、设置…、任务清单…、使用教程…、退出。
 * 0.4.1：新增「使用教程…」（静态教程窗口，不新增 IPC/窗口角色）。
 */
export function showPetContextMenu(_source?: 'pet' | 'bubble'): void {
  const win = getPetWindow()
  if (win === null) return
  const menu = Menu.buildFromTemplate([
    {
      label: win.isVisible() ? '隐藏鲸鱼娘' : '显示鲸鱼娘',
      click: () => {
        setVisible(!win.isVisible())
      },
    },
    {
      label: '重置窗口位置',
      click: () => {
        resetPosition()
      },
    },
    { type: 'separator' },
    {
      label: '设置…',
      click: () => {
        createSettingsWindow()
      },
    },
    {
      label: '任务清单…',
      click: () => {
        createTasksWindow()
      },
    },
    {
      label: '使用教程…',
      click: () => {
        createTutorialWindow()
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit()
      },
    },
  ])
  menu.popup({ window: win })
}
