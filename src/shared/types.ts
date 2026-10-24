/**
 * 领域类型 · 契约 v0（Lead 维护）
 *
 * 口径唯一事实源：PLAN.md §6 / §6.1。
 * - 所有时间戳统一 epoch ms（SQLite INTEGER），字段名以 `At` 结尾；`event_log` 用 `ts`
 * - 业务日 `day_key` =（本地时间 − 4h）的日期，格式 `YYYY-MM-DD`
 * - P0 只做 Windows、单用户、本地优先；不设 exp / affection / sort_order / snooze_until
 *
 * 契约规则（A13）：**只加不改**。新增字段/通道 = minor 版本 +1；删除/修改语义 = major。
 * 修改本文件必须 Lead 评审（CODEOWNERS）。
 */

/** 业务日键：`YYYY-MM-DD`（day_key = 本地时间 −4h 的日期，PLAN §5） */
export type DayKey = string

/** 时间戳：epoch 毫秒 */
export type Timestamp = number

/** 气泡级别：L1 轻 / L2 中 / L3 强（PLAN §5） */
export type BubbleLevel = 1 | 2 | 3

/** v1 三个精灵状态（focus/remind/celebrate 等 P2 状态见 docs/05 §2；素材文件可保留） */
export type SpriteState = 'idle' | 'happy' | 'sleepy'

/** 0.3.3：瞬时角色动作，不改变基础时段态。 */
export type PetAction = 'pat' | 'celebrate' | 'concern' | 'idle-look'

/** 互动类型；P0 实际生效 5 个（click/pet/drag/feed/focus），talk 为 P1 预留 */
export type InteractionKind = 'click' | 'pet' | 'drag' | 'feed' | 'talk' | 'focus'

export type PlanCategory = 'study' | 'sport' | 'life'
export type PlanStatus = 'todo' | 'done' | 'deferred' | 'dropped'
export type PlanSource = 'manual' | 'ai' | 'carry'
export type CheckinSource = 'manual' | 'auto' | 'makeup'

export type ReminderKind = 'pomodoro' | 'water' | 'eye' | 'custom' | 'plan' | 'review'
export type ScheduleType = 'once' | 'daily' | 'weekly' | 'interval'

export type PomodoroPhase = 'focus' | 'break'
/** 启动时按墙钟判定：running 进程存活；completed 走满；partial 重启/中断后补记 */
export type PomodoroStatus = 'running' | 'completed' | 'partial'

export type BubbleKind = 'reminder' | 'line' | 'system' | 'summary'
export type BubbleActionId = 'ack' | 'snooze-5' | 'snooze-10' | 'done'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 多屏/DPI 持久化口径（PLAN §6）：不依赖 display.id；
 * 恢复时用矩形交集校验 + clamp（02-arch §9 display.ts）。
 */
export interface WindowPlacement {
  bounds: Rect
  workArea: Rect
  /** bounds 相对 workArea 左上角的偏移比例（0–1），分辨率变化后按比例还原 */
  rel: { x: number; y: number }
  /** DIP 缩放系数（P1 开放 0.6–1.5；P0 固定 1） */
  scale: number
}

export interface PetState {
  name: string
  /** 由 intimacy 阈值派生，可缓存；不存 exp */
  level: number
  /** 累计亲密度，不衰减；等级与台词档位由它派生 */
  intimacy: number
  /** 0–100，存储列，04:00 写衰减（PLAN §6） */
  mood: number
  /** 0–100，每天 04:00 衰减 */
  satiety: number
  spriteState: SpriteState
  /** 连续打卡天数（含补卡） */
  streak: number
  maxStreak: number
  /** 真实打卡天数（补卡不计） */
  realDays: number
  /** 累计专注分钟 */
  focusMinutes: number
  /** 称号文本，由 realDays 推导后缓存 */
  title: string
  window: WindowPlacement | null
  lastFedAt: Timestamp | null
  lastInteractionAt: Timestamp | null
  updatedAt: Timestamp
}

export interface PlanItem {
  id: number
  dayKey: DayKey
  /** 1..3；UNIQUE(day_key, slot) 挡第 4 项 */
  slot: number
  title: string
  category: PlanCategory
  estMinutes: number | null
  status: PlanStatus
  doneAt: Timestamp | null
  /** 顺延来源项 id */
  carryFromId: number | null
  source: PlanSource
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface Checkin {
  id: number
  dayKey: DayKey
  source: CheckinSource
  makeup: boolean
  /** 1..5，复盘可选 */
  mood: number | null
  note: string | null
  streakAfter: number | null
  realDaysAfter: number | null
  /** 打卡发生时刻（03 回改：必填） */
  checkedAt: Timestamp
  createdAt: Timestamp
}

export interface ReminderScheduleOnce {
  type: 'once'
  /** 绝对触发时刻（epoch ms） */
  at: Timestamp
}

export interface ReminderScheduleDaily {
  type: 'daily'
  /** `HH:mm` 本地时间 */
  time: string
}

export interface ReminderScheduleWeekly {
  type: 'weekly'
  /** ISO 1=周一 … 7=周日 */
  weekdays: number[]
  time: string
}

export interface ReminderScheduleInterval {
  type: 'interval'
  everyMin: number
  /** 活动时段，`HH:mm`；缺省表示全天 */
  start?: string
  end?: string
}

export type ReminderSchedule =
  ReminderScheduleOnce | ReminderScheduleDaily | ReminderScheduleWeekly | ReminderScheduleInterval

export interface Reminder {
  id: number
  kind: ReminderKind
  title: string
  body: string | null
  schedule: ReminderSchedule
  level: BubbleLevel
  enabled: boolean
  dndOverride: boolean
  /** 稍后提醒分钟数（A13：用 snooze_min，不用 snooze_until） */
  snoozeMin: number | null
  fireCount: number
  nextFireAt: Timestamp | null
  lastFiredAt: Timestamp | null
  createdAt: Timestamp
}

export interface PomodoroSession {
  id: number
  planItemId: number | null
  phase: PomodoroPhase
  /** 第几轮（1 起） */
  round: number
  startAt: Timestamp
  endedAt: Timestamp | null
  status: PomodoroStatus
}

export interface PomodoroState {
  session: PomodoroSession
  /** 墙钟剩余毫秒（暂停 P1 前只有 running） */
  remainingMs: number
  totalMs: number
}

export interface DndSettings {
  enabled: boolean
  /** `HH:mm` */
  start: string
  /** `HH:mm`，可小于 start（跨零点） */
  end: string
}

export interface NotificationSettings {
  enabled: boolean
  volume: number
  soundEnabled: boolean
  /** Windows Toast 为 best-effort（A15）；P0 只承诺应用内气泡 */
  toastEnabled: boolean
}

export interface PlanReminderSettings {
  enabled: boolean
  /** 默认 08:30 */
  morning: string
  /** 默认 21:30（内含打卡） */
  review: string
}

export interface PomodoroSettings {
  enabled: boolean
  focusMin: number
  breakMin: number
  longBreakMin: number
  roundsBeforeLongBreak: number
}

/**
 * A11 补卡券账本（累计库存语义，惰性结算）：
 * - `granted` / `used` 为**累计**发放/使用次数
 * - 可用券 = clamp(granted − used, 0, 3)；每周一 04:00 惰性结算：若可用 <3 则 granted+1（不回溯补发）
 */
export interface MakeupLedger {
  /** 最近一次发放结算的周键（该周周一日期） */
  weekKey: DayKey
  /** 累计已发放 */
  granted: number
  /** 累计已使用 */
  used: number
}

/**
 * v1 设置（唯一持久化对象，JSON：`userData/settings.json`，见 docs/05 §4）。
 * 只放"首版真能用上"的开关；P2 学习设置见下方 P2 区。
 * 0.3.1a（契约 1.7）：新增提醒提前量 `reminderLeadMin`（可选字段，旧 settings 缺字段回退默认）。
 * 0.3.2（契约 1.9）：新增 HUD 显示范围 `hudScope`（可选字段，旧 settings 缺字段回退默认）。
 */
export interface Settings {
  /** 开机自启；默认 false，仅 NSIS 安装版生效（portable 置灰） */
  autostart: boolean
  /** 全局静音（v1 无音效也可先占位） */
  muted: boolean
  /** 任务到期提醒提前量（分钟）；默认 15，仅允许 5/15/30/60；实际触发在 0.3.2 */
  reminderLeadMin: ReminderLeadMin
  /** 自定义全局提前量（1–1440）；null = 使用 reminderLeadMin；0.4 新增 */
  customReminderLeadMin: number | null
  /** HUD 常驻卡片范围：仅紧急（默认）/ 紧急+今日到期 */
  hudScope: HudScope
}

export type SettingsPatch = Partial<
  Pick<Settings, 'autostart' | 'muted' | 'reminderLeadMin' | 'hudScope'> & {
    customReminderLeadMin: number | null
  }
>

/** P2：学习闭环设置的完整形状（v1 不通过 IPC 暴露，保留供 P2） */
export interface LearningSettings {
  /** A12 首启 3 步引导完成标记 */
  onboarded: boolean
  /** A12 自启询问结果（portable 版置灰） */
  autostart: boolean
  dnd: DndSettings
  notify: NotificationSettings
  plan: PlanReminderSettings
  pomodoro: PomodoroSettings
  makeup: MakeupLedger
}

/** P2：学习设置 patch（v1 不暴露） */
export type LearningSettingsPatch = {
  onboarded?: boolean
  autostart?: boolean
  dnd?: Partial<DndSettings>
  notify?: Partial<NotificationSettings>
  plan?: Partial<PlanReminderSettings>
  pomodoro?: Partial<PomodoroSettings>
}

export interface DndState {
  enabled: boolean
  start: string
  end: string
  /** 当前是否处于免打扰 */
  active: boolean
  /** 本次免打扰结束时刻；未激活为 null */
  until: Timestamp | null
}

export interface MakeupInfo {
  /** 可用补卡券 = granted − used（0..3） */
  available: number
  weekKey: DayKey
  granted: number
  used: number
  /** 是否存在可补卡的 D−1/D−2 断签 */
  canMakeup: boolean
}

export interface BubbleAction {
  id: BubbleActionId
  label: string
}

/** v1 气泡（应用内唯一通知形态；无 ack 动作，P2 再扩展） */
export interface Bubble {
  /** 任务提醒提供显式入口；普通台词不带动作。 */
  action?: 'open-tasks'
  id: string
  text: string
  createdAt: Timestamp
  /** 自动消失毫秒；null = 直到用户关闭 */
  durationMs: number | null
}

export interface RewardSummary {
  intimacyGained: number
  /** 本次解锁称号；未解锁为 null */
  milestone: string | null
  levelUp: boolean
  titleChanged: boolean
  /** 撞到每日亲密度上限 60（P0） */
  dailyCapReached: boolean
}

export interface CheckinResult {
  checkin: Checkin
  pet: PetState
  rewards: RewardSummary
  /** 幂等：重复打卡返回既有记录时为 false */
  isNew: boolean
}

export type ReviewDecision = 'done' | 'defer' | 'drop'

export interface ReviewItemDecision {
  planItemId: number
  decision: ReviewDecision
}

export interface ReviewResult {
  /** 复盘可选；未打卡时仍可提交复盘，checkin 为 null */
  checkin: Checkin | null
  plan: PlanItem[]
  /** 已顺延到次日（当天有空槽） */
  deferred: PlanItem[]
  /** 次日已满 → 进入「顺延待办」只读列表 */
  overflow: PlanItem[]
  pet: PetState
  rewards: RewardSummary
}

export interface InteractionResult {
  kind: InteractionKind
  accepted: boolean
  intimacyGained: number
  pet: PetState
  line: string
  cooldownRemainingMs: number
  dailyCapReached: boolean
  /** 喂食专用：饱食 100 拒食 */
  refused: boolean
}

export interface PomodoroStopResult {
  session: PomodoroSession
  focusMinutes: number
  completed: boolean
  partial: boolean
  pet: PetState
}

export interface ExportResult {
  /** 用户取消保存对话框时为 true */
  canceled: boolean
  format: 'json' | 'csv'
  filePath: string | null
  bytes: number
  rows: number
}

export interface BackupResult {
  filePath: string
  bytes: number
  /** 当前保留的备份份数（P0：7） */
  kept: number
}

export interface ClearResult {
  cleared: boolean
  /** 被删除的文件数（DB + -wal + -shm + 备份 + 导出） */
  filesDeleted: number
}

/** v1 bootstrap：窗口壳 + 设置，不含任何学习数据 */
export interface Bootstrap {
  ipcVersion: string
  now: Timestamp
  spriteState: SpriteState
  settings: Settings
  /** 当前运行形态是否支持开机自启（NSIS 安装版 true；dev/portable false） */
  autostartSupported: boolean
  /** 原生宠物窗口当前是否显示；页面可见性可能与此不同 */
  windowVisible: boolean
  clickThrough: boolean
  placement: WindowPlacement | null
  /** 0.3.2（契约 1.9）：HUD 当前状态（最多 3 条 + 总数 + 普通提醒排队角标） */
  urgentTasks: UrgentTasksState
}

/** main → renderer 推送事件（单通道 `pet:event`，preload 只订阅一次） */
export type PetEvent =
  | { type: 'bubble'; bubble: Bubble }
  | { type: 'bubble-dismiss'; bubbleId: string }
  | { type: 'pet-state'; spriteState: SpriteState }
  | { type: 'pet-action'; action: PetAction }
  | { type: 'settings'; settings: Settings }
  | { type: 'window-visibility'; visible: boolean }
  | { type: 'tasks-changed' }
  /** HUD 状态变化（紧急任务集合/总数/排队角标）；仅在变化时推送 */
  | { type: 'tasks-urgent'; urgentTasks: UrgentTasksState }
  /** 独立打卡数据变化（0.4）；任务窗重新拉取 habit 快照，不触发任务刷新 */
  | { type: 'habits-changed' }

// ---------------------------------------------------------------------------
// 任务清单（契约 1.5；自用 MVP，设计见 docs/23-tasklist-mvp.md）
// ---------------------------------------------------------------------------

/**
 * 任务分类：生活 / 运动 / 学习（固定三分类，0.3.1a 起）。
 * 项目任务 `category=null` + `projectId` 非空（0.3.1b 启用；本版 UI 不展示项目任务）。
 */
export type TaskCategory = 'life' | 'sport' | 'study'

/** 重要性：紧急 / 重要 / 普通 / 次要（只影响排序与颜色，不做成长数值） */
export type TaskImportance = 'urgent' | 'high' | 'normal' | 'low'

/** 到期提醒提前量（分钟）；0.3.1a 只做设置读写，实际触发在 0.3.2 */
export type ReminderLeadMin = 5 | 15 | 30 | 60

/** HUD 常驻卡片显示范围（0.3.2，契约 1.9）：仅紧急 / 紧急+今日到期 */
export type HudScope = 'urgent' | 'urgent-due'

/** 倒计时分级：无截止 / >1 天 / <1 天 / <1 小时 / 已过期（docs/25 §5.1；颜色由 UI 映射） */
export type TaskCountdownLevel = 'none' | 'far' | 'soon' | 'imminent' | 'overdue'

export type TaskStatus = 'todo' | 'done'

/** 清单状态视图（0.4，contract 2.0） */
export type TaskView = 'active' | 'completed' | 'archived'

/** 清单状态计数；在 scope + 分类/项目过滤后、应用 view 前计算 */
export interface TaskViewCounts {
  active: number
  completed: number
  archived: number
  overdue: number
}

/** 双阶段提醒消费标记（0.4）；dueAt 必须与 Task.dueAt 一致 */
export interface TaskReminderState {
  dueAt: Timestamp | null
  soonConsumedAt: Timestamp | null
  dueConsumedAt: Timestamp | null
}

/** 任务范围：今日 / 全部 / 单个项目（0.3.1b 起） */
export type TaskScope = 'today' | 'all' | 'project'

/** 列表分类选择：具体分类、项目分类或 null（null = 全部分类混排） */
export type TaskCategorySelection = TaskCategory | 'project' | null

/**
 * 单条任务；时间戳统一 epoch ms，业务日口径沿用 rules.ts（本地 −4h）。
 * 0.3.1a（tasks.json v2）新增字段：
 * - `category` 可为 null（项目任务）；`projectId` 与 `category` 构成 XOR 不变量（docs/25 §2.3）
 * - `todayPinnedDayKey` 0.4 启用，0.3.1 恒 null（保留字段避免 0.4 再改格式）
 */
export interface Task {
  id: string
  title: string
  /** 生活/运动/学习；项目任务为 null（与 projectId 二选一） */
  category: TaskCategory | null
  /** 所属项目 id；非项目任务为 null（0.3.1b 起可创建项目任务） */
  projectId: string | null
  importance: TaskImportance
  status: TaskStatus
  /** 到期时刻；null = 没有具体时间 */
  dueAt: Timestamp | null
  /** 最近一次「即将到期/已到期」提醒时间（防重复；改 dueAt 时清空） */
  remindedAt: Timestamp | null
  note: string | null
  createdAt: Timestamp
  updatedAt: Timestamp
  completedAt: Timestamp | null
  /** 0.3.1 手动 pin 今日保留字段；0.4 不写入、不用于筛选 */
  todayPinnedDayKey: DayKey | null
  /** 0.4：搁置时间；仅 status=todo 可非空 */
  archivedAt: Timestamp | null
  /** 0.4：任务级提醒提前量；null = 跟随全局 */
  reminderLeadMinOverride: number | null
  /** 0.4：两阶段提醒消费状态 */
  reminderState: TaskReminderState
}

/** 每日打卡记录历史类型（0.2 旧功能；v3 起不再持久化/暴露，仅迁移模块内部使用） */
export interface CheckinRecord {
  dayKey: DayKey
  checkedAt: Timestamp
  /** 打卡时当天已完成任务数 */
  doneCount: number
  /** 打卡时当天任务总数 */
  totalCount: number
  note: string | null
}

export interface TaskStats {
  todayKey: DayKey
  /** 今天视图里未完成 + 今天已完成的任务数 */
  todayTotal: number
  /** 今天已完成的任务数 */
  todayDone: number
  /** 未完成且已过期的任务数（全局，含搁置，兼容旧口径） */
  overdue: number
  /** 全部未完成任务数（全局，含搁置，兼容旧口径） */
  totalTodo: number
}

export interface TaskCreateInput {
  title: string
  category?: TaskCategory | null
  /** 0.3.1b：在项目内创建任务（category 必须缺省/null，二选一） */
  projectId?: string | null
  importance?: TaskImportance
  dueAt?: Timestamp | null
  note?: string | null
  /** 0.4：任务级提醒提前量；缺省/null = 跟随全局 */
  reminderLeadMinOverride?: number | null
}

export interface TaskPatch {
  title?: string
  category?: TaskCategory
  importance?: TaskImportance
  /** null 表示清空到期时间 */
  dueAt?: Timestamp | null
  note?: string | null
  /** 0.4：任务级提醒提前量；null = 跟随全局 */
  reminderLeadMinOverride?: number | null
}

export interface TaskUpdateInput {
  id: string
  patch: TaskPatch
}

export interface TaskToggleInput {
  id: string
  /** 缺省 = 在 todo/done 之间切换 */
  done?: boolean
}

export interface TasksListInput {
  scope: TaskScope
  /** scope='project' 时必填；其他 scope 不允许携带（zod 校验） */
  projectId?: string
  /** 0.4：状态视图；缺省 = 不加状态过滤（旧调用兼容） */
  view?: TaskView
  /** 0.4：分类/项目筛选；null = 全部分类混排；缺省 = 不加分类过滤 */
  category?: TaskCategorySelection
  /** 0.4：仅 scope='project' 时可用，对项目任务再应用今日/全部 */
  viewScope?: 'today' | 'all'
}

export interface TasksSnapshot {
  tasks: Task[]
  stats: TaskStats
  /** 0.4：仅在请求带 view 时返回；当前 scope + 分类/项目过滤、应用 view 前计数 */
  viewCounts?: TaskViewCounts
}

// ---------------------------------------------------------------------------
// HUD 紧急任务（0.3.2，契约 1.9；main 计算并推送到宠物窗）
// ---------------------------------------------------------------------------

/** HUD 单条任务（renderer 只读展示；按 dueAt/重要性排序后最多 3 条） */
export interface HudTask {
  id: string
  title: string
  dueAt: Timestamp | null
  importance: TaskImportance
  category: TaskCategory | null
  /** 项目任务的项目名；非项目任务为 null */
  projectName: string | null
}

/** HUD 状态：main 裁剪（最多 3 条）+ 总数 + HUD 活跃时普通提醒排队角标 */
export interface UrgentTasksState {
  tasks: HudTask[]
  /** 当前 HUD 范围（仅紧急 / 紧急+今日到期）下符合条件的任务总数 */
  total: number
  /** HUD 活跃时排队等待汇总的普通提醒数量（队列上限 5、TTL 10 分钟、内存态） */
  queued: number
}

/** HUD 显示范围设置值（同 Settings.hudScope，单独导出供 UI 复用） */
export const HUD_SCOPES = ['urgent', 'urgent-due'] as const

// ---------------------------------------------------------------------------
// 项目（0.3.1b，契约 1.8；数据仍在 tasks.json v2 内，不新增迁移）
// ---------------------------------------------------------------------------

/**
 * 项目：任务的第二级容器（docs/25 §1 D1–D3）。
 * - 项目任务 `category=null` + `projectId` 非空；非项目任务反之（XOR）
 * - 项目任务不计入生活/运动/学习列表与计数
 * - 0.3.1b 不设 `status/archivedAt`（0.4 归档再加，加法）
 */
export interface Project {
  id: string
  /** 去空白 1–40 字；同层级不区分大小写去重 */
  name: string
  /** 可空，≤200 字 */
  note: string | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface ProjectCreateInput {
  name: string
  note?: string | null
}

/** 0.3.1b：只允许改名/备注；不支持移动任务、不设状态 */
export interface ProjectPatch {
  name?: string
  note?: string | null
}

export interface ProjectUpdateInput {
  id: string
  patch: ProjectPatch
}

export interface ProjectDeleteInput {
  id: string
}

// ---------------------------------------------------------------------------
// 独立打卡（0.4.0，IPC 2.0；完全独立于任务/项目，无 streak）
// ---------------------------------------------------------------------------

export type HabitFrequency = 'daily' | 'weekly'

/** ISO 星期：1=周一 … 7=周日；周截止总是该星期当天 04:00 */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7

export type HabitSchedule =
  | { frequency: 'daily'; deadlineWeekday: null }
  | { frequency: 'weekly'; deadlineWeekday: IsoWeekday }

export interface HabitScheduleRevision {
  revision: number
  schedule: HabitSchedule
  effectiveAt: Timestamp
}

export interface HabitCycleSnapshot {
  /** `${habitId}:${revision}:${startAt}`，main 构造 */
  key: string
  revision: number
  schedule: HabitSchedule
  startAt: Timestamp
  /** 结束不包含；startAt < endAt */
  endAt: Timestamp
}

export interface HabitPendingSchedule {
  schedule: HabitSchedule
  requestedAt: Timestamp
  /** 必须是安排修改时的 currentCycle.endAt */
  effectiveAt: Timestamp
}

export interface Habit {
  id: string
  name: string
  note: string | null
  createdAt: Timestamp
  updatedAt: Timestamp
  scheduleRevisions: HabitScheduleRevision[]
  currentCycle: HabitCycleSnapshot
  pendingSchedule: HabitPendingSchedule | null
}

export interface HabitCheckin {
  id: string
  habitId: string
  cycleKey: string
  /** 写入时完整周期快照；历史不随规则修改重算 */
  cycle: HabitCycleSnapshot
  checkedAt: Timestamp
  note: string | null
}

export interface HabitSnapshot {
  habit: Habit
  /** 当前周期已打卡记录；无则 null */
  currentCheckin: HabitCheckin | null
}

export interface HabitCreateInput {
  name: string
  note?: string | null
  schedule: HabitSchedule
}

export interface HabitPatch {
  name?: string
  note?: string | null
  schedule?: HabitSchedule
}

export interface HabitUpdateInput {
  id: string
  patch: HabitPatch
}

export interface HabitCheckinInput {
  habitId: string
  cycleKey: string
  note?: string | null
}

export interface HabitCheckinResult {
  record: HabitCheckin
  habit: HabitSnapshot
  isNew: boolean
}

export interface HabitHistoryInput {
  habitId: string
  limit?: number
  cursor?: string
}

export interface HabitHistoryPage {
  records: HabitCheckin[]
  nextCursor: string | null
}
