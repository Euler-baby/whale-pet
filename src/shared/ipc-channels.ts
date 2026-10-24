/**
 * IPC 通道常量（zod-free，Lead 维护；ADR-0004 契约 v1）
 *
 * 为什么单独一个文件：`sandbox:true` 的 preload 只能 `require('electron')`，不能加载第三方包。
 * 若 preload 从 `ipc.ts` 引入通道常量，会把 zod 一起带进运行时依赖（electron-vite 默认外置
 * dependencies，产物会出现 `require("zod")` → preload 加载失败、`window.pet` 不注入）。
 * 因此通道常量放在本文件，preload 只引这里；`ipc.ts` 负责 zod/类型，仅 main 与 renderer 类型层使用。
 *
 * v1 通道 = **31 个 invoke + 1 个推送通道**（0.4.0 契约 2.0：删除旧 tasks:checkin，
 * 新增 tasks:set-archived 与 6 个 habits 通道）。学习闭环其余部分仍在 P2 文档中。
 */
export const IPC = {
  // app
  appBootstrap: 'pet:app:bootstrap',
  // 窗口
  windowSetClickThrough: 'pet:window:set-click-through',
  windowGetClickThrough: 'pet:window:get-click-through',
  windowMoveBy: 'pet:window:move-by',
  windowSetVisible: 'pet:window:set-visible',
  windowResetPosition: 'pet:window:reset-position',
  windowGetPlacement: 'pet:window:get-placement',
  windowShowContextMenu: 'pet:window:show-context-menu',
  // v1.1（minor）：气泡可见性 → 命中区域（renderer 显示/隐藏气泡时通知 main）
  windowSetBubbleVisible: 'pet:window:set-bubble-visible',
  // v1.2（minor）：气泡实际矩形 → 精确命中区域（替代固定 300×140 近似）
  windowSetBubbleRegion: 'pet:window:set-bubble-region',
  // 设置
  settingsGet: 'pet:settings:get',
  settingsUpdate: 'pet:settings:update',
  // 任务清单（v1.5 minor；自用 MVP）
  tasksList: 'pet:tasks:list',
  tasksCreate: 'pet:tasks:create',
  tasksUpdate: 'pet:tasks:update',
  tasksToggle: 'pet:tasks:toggle',
  tasksDelete: 'pet:tasks:delete',
  tasksStats: 'pet:tasks:stats',
  tasksRestore: 'pet:tasks:restore',
  tasksOpen: 'pet:tasks:open',
  // 0.4（major 2.0）：任务搁置/恢复
  tasksSetArchived: 'pet:tasks:set-archived',
  // 0.4（major 2.0）：独立打卡（无旧 checkin 历史通道）
  habitsList: 'pet:habits:list',
  habitsCreate: 'pet:habits:create',
  habitsUpdate: 'pet:habits:update',
  habitsDelete: 'pet:habits:delete',
  habitsCheckin: 'pet:habits:checkin',
  habitsHistory: 'pet:habits:history',
  // 项目（0.3.1b，契约 1.8 minor）：项目 CRUD；项目任务仍走 tasks:*（scope='project'）
  projectsList: 'pet:projects:list',
  projectsCreate: 'pet:projects:create',
  projectsUpdate: 'pet:projects:update',
  projectsDelete: 'pet:projects:delete',
  // main → renderer 推送（唯一事件通道）
  event: 'pet:event',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** 所有 invoke 通道（排除唯一的 main→renderer 推送通道 pet:event） */
export type IpcInvokeChannel = Exclude<IpcChannel, typeof IPC.event>
