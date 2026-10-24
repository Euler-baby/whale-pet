/**
 * 单实例锁 · Agent-Main
 *
 * 口径：02-arch §2.2「锁必须在 whenReady 前获取；失败 app.quit()；second-instance 里 showInactive」。
 */
import { app } from 'electron'

/**
 * 获取单实例锁（**必须在 app.whenReady 之前调用**，AGENTS 常见坑 6）。
 * @returns true = 当前进程是唯一实例；false = 已有实例，调用方应 app.quit()
 */
export function acquireSingleInstanceLock(): boolean {
  return app.requestSingleInstanceLock()
}

/**
 * 注册第二次启动的回调（另一个进程启动时，由第一个实例处理）。
 * M1 可在此处理 `--open-settings` 等参数，M0 只把主窗口显示出来。
 */
export function installSecondInstanceHandler(handler: () => void): void {
  app.on('second-instance', () => {
    handler()
  })
}

/** 主动释放单实例锁（仅测试/特殊退出路径需要；正常退出由 Electron 处理） */
export function releaseSingleInstanceLock(): void {
  app.releaseSingleInstanceLock()
}
