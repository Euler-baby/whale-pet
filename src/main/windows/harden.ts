/**
 * BrowserWindow 安全基线（pet / settings 共用）· Agent-Main
 *
 * 02-arch §2.3：页面内导航与新窗口一律 deny；CSP 由 HTML 提供，main 侧再兜底。
 */
import type { BrowserWindow } from 'electron'

export function hardenWebContents(win: BrowserWindow): void {
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    console.warn('[window] 已拒绝页面导航:', url)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    console.warn('[window] 已拒绝新窗口:', url)
    return { action: 'deny' }
  })
}
