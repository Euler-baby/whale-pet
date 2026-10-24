/**
 * IPC 契约版本（Lead 维护）
 *
 * A13：契约「只加不改」。
 * - 新增通道 / 新增可选字段 / 新增响应字段 → minor +1（向后兼容）
 * - 删除、重命名、修改字段语义或必填性 → major +1（需要同步迁移 renderer 与 preload）
 *
 * 版本不一致时：renderer 必须显示「客户端版本过旧/过新」并禁止调用业务 IPC，
 * 不能静默降级（避免半写入）。
 *
 * 2.0.0（0.4.0）：删除旧整体打卡 `tasks:checkin` 与 TaskStats 旧打卡字段（major）；
 * tasks 新增 set-archived；新增 habits list/create/update/delete/checkin/history；
 * 共 31 invoke + 1 event。
 *
 * 1.10.0（0.3.3）：pet:event 追加 pet-action 瞬时动作；无新增 invoke、数据变更。
 *
 * 1.9.0（0.3.2）：Bootstrap.urgentTasks + `pet:event.tasks-urgent`（HUD）；settings 新增可选
 * `hudScope`（仅紧急 / 紧急+今日到期）。无新增 invoke 通道（25 invoke + 1 event）。
 *
 * 1.8.0（0.3.1b）：新增 projects:list/create/update/delete（4 个 invoke）；`tasks:list` 增加
 * project scope；`tasks:create` 增加可选 projectId；Task/Project 的 XOR 校验由 store 保证。
 *
 * 1.7.0（0.3.1a）：settings 新增可选字段 `reminderLeadMin`；任务模型切 tasks.json v2
 * （三分类、importance=urgent、Task.projectId/todayPinnedDayKey）。
 */
export const IPC_VERSION = '2.0.0'

export const IPC_VERSION_MAJOR = 2
export const IPC_VERSION_MINOR = 0
export const IPC_VERSION_PATCH = 0

/** 契约兼容规则说明（用于 README / AGENTS / 错误提示） */
export const IPC_COMPAT_RULE =
  '契约只加不改：新增用 minor，删除/改语义用 major；跨 major 必须由 Lead 评审并同步 preload/renderer。'

/** 主进程与 renderer 的 IPC 版本是否兼容（major 相同即兼容）。 */
export function isIpcVersionCompatible(remoteVersion: string): boolean {
  const major = Number.parseInt(remoteVersion.split('.')[0] ?? '', 10)
  return Number.isInteger(major) && major === IPC_VERSION_MAJOR
}
