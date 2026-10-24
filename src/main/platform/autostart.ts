/**
 * 开机自启（v1 设置项；默认关闭）· Agent-Main
 *
 * 口径（docs/05 §2/§3 实验 #10、AGENTS 常见坑 5）：
 * - 仅 NSIS 安装版支持：portable 每次解压到 `%TEMP%`，exe 路径会变，不能写自启；
 * - 写 HKCU Run（`setLoginItemSettings`），可被任务管理器禁用；
 * - 卸载时由 NSIS `installer.nsh` 的 `customUnInstall` 清 Run 项（阶段 2 落）。
 */
import { app } from 'electron'

/** 与 build/installer.nsh 同步：卸载只清理本应用的启动项。 */
const AUTOSTART_ENTRY_NAME = 'com.deepseek.whalepet'

/** 当前运行形态是否支持自启（portable 通过 PORTABLE_EXECUTABLE_DIR 识别） */
export function isAutostartSupported(): boolean {
  return app.isPackaged && process.env['PORTABLE_EXECUTABLE_DIR'] === undefined
}

/**
 * 应用自启开关。返回是否真正生效：
 * - dev / portable → 返回 false（设置仍会持久化，UI 应置灰说明）
 * - NSIS 安装版 → 写注册表后返回 true
 */
export function applyAutostart(enabled: boolean): boolean {
  if (!isAutostartSupported()) return false
  app.setLoginItemSettings({
    name: AUTOSTART_ENTRY_NAME,
    openAtLogin: enabled,
    // 自启时静默进托盘，不弹窗（阶段 1 接入启动参数分支）
    args: ['--hidden'],
  })
  return true
}
