/**
 * v1 设置存储（JSON + 原子写）· Agent-Main
 *
 * 口径（docs/05 §4、docs/35 §1.2、§5.1、§5.2）：
 * - 单写者：只有 main 写，renderer 经 IPC；文件路径由 main 注入（默认 `userData/settings.json`）
 * - version + 校验；未知字段保留（保存时写回，向前兼容）；读取允许缺 `version`（视为 v1）
 * - **损坏/未知版本/不可读文件 → 保护原文件**：不重命名、不创建 `.bad-*`、不写盘；
 *   运行期仅用默认值，update/flush 拒绝覆盖并抛可读错误（用户修复后重启即可恢复）
 * - 原子写：`settings.json.tmp` → rename；update 立即写盘，成功才更新内存并返回
 * - 0.3.1a（契约 1.7）：新增 `reminderLeadMin`（5/15/30/60，默认 15）；
 *   旧 settings 缺字段回退默认（向前兼容），值非法按结构损坏处理
 * - 0.3.2（契约 1.9）：新增 `hudScope`（'urgent' 默认 / 'urgent-due'），同样缺字段回退默认
 * - 0.4.0（契约 2.0）：新增 `customReminderLeadMin`（1–1440 整数或 null＝跟随
 *   reminderLeadMin；缺字段/null 均回退 null）。读取允许缺 `version`（视为 v1），
 *   每次新写入都显式写 `version:1`；迁移本身不改写 settings（docs/35 §1.2）。
 *
 * 纯函数（`parseSettingsFile` / `mergeSettings`）导出给单测用，不依赖 Electron。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { HUD_SCOPES } from '@shared/types'
import type { Settings, SettingsPatch } from '@shared/types'

/** 当前设置文件版本（结构变更 +1；v1 固定 1） */
export const SETTINGS_FILE_VERSION = 1

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  autostart: false,
  muted: false,
  reminderLeadMin: 15,
  customReminderLeadMin: null,
  hudScope: 'urgent',
}

/** 提醒提前量允许值（分钟）：5 / 15 / 30 / 60（契约 1.7 预设，保留） */
export const REMINDER_LEAD_MIN_VALUES: readonly Settings['reminderLeadMin'][] = [5, 15, 30, 60]

/** 自定义提醒提前量范围（分钟，0.4 契约 2.0）：1–1440 整数 */
export const CUSTOM_REMINDER_LEAD_MIN_MIN = 1
export const CUSTOM_REMINDER_LEAD_MIN_MAX = 1440

function isReminderLeadMin(value: unknown): value is Settings['reminderLeadMin'] {
  return (
    typeof value === 'number' && (REMINDER_LEAD_MIN_VALUES as readonly number[]).includes(value)
  )
}

/** 自定义全局提前量：1–1440 整数（null 另行表示“跟随 reminderLeadMin”） */
export function isCustomReminderLeadMin(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= CUSTOM_REMINDER_LEAD_MIN_MIN &&
    value <= CUSTOM_REMINDER_LEAD_MIN_MAX
  )
}

/** HUD 显示范围允许值（契约 1.9）：仅紧急 / 紧急+今日到期 */
function isHudScope(value: unknown): value is Settings['hudScope'] {
  return typeof value === 'string' && (HUD_SCOPES as readonly string[]).includes(value)
}

export type SettingsParseReason =
  'missing' | 'invalid-json' | 'invalid-shape' | 'unknown-version' | null

export interface SettingsParseResult {
  settings: Settings
  /** 未知字段（保留并原样写回，避免旧/新版本互相清字段） */
  extras: Record<string, unknown>
  /** true = 文件有效；false = 已回落默认值，调用方应备份/覆盖坏文件 */
  ok: boolean
  reason: SettingsParseReason
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function defaults(): Settings {
  return { ...DEFAULT_SETTINGS }
}

/**
 * 纯函数：解析设置文件文本（null = 文件不存在）。
 * 认 `version` / `autostart` / `muted` / `reminderLeadMin` / `customReminderLeadMin` / `hudScope`，
 * 其余键原样保留在 `extras`；缺 `version` 视为 v1（读取兼容）。
 */
export function parseSettingsFile(text: string | null): SettingsParseResult {
  if (text === null) {
    return { settings: defaults(), extras: {}, ok: false, reason: 'missing' }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { settings: defaults(), extras: {}, ok: false, reason: 'invalid-json' }
  }

  if (!isPlainObject(raw)) {
    return { settings: defaults(), extras: {}, ok: false, reason: 'invalid-shape' }
  }

  if (raw['version'] !== undefined && raw['version'] !== SETTINGS_FILE_VERSION) {
    return { settings: defaults(), extras: {}, ok: false, reason: 'unknown-version' }
  }

  const settings = defaults()
  for (const key of ['autostart', 'muted'] as const) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== 'boolean') {
      return { settings: defaults(), extras: {}, ok: false, reason: 'invalid-shape' }
    }
    settings[key] = value
  }

  // 0.3.1a：旧 settings 缺字段 → 默认 15（不因缺字段失败）；值必须是 5/15/30/60
  const reminderLeadMin = raw['reminderLeadMin']
  if (reminderLeadMin !== undefined) {
    if (!isReminderLeadMin(reminderLeadMin)) {
      return { settings: defaults(), extras: {}, ok: false, reason: 'invalid-shape' }
    }
    settings.reminderLeadMin = reminderLeadMin
  }

  // 0.3.2：旧 settings 缺字段 → 默认 'urgent'；仅接受 'urgent' | 'urgent-due'
  const hudScope = raw['hudScope']
  if (hudScope !== undefined) {
    if (!isHudScope(hudScope)) {
      return { settings: defaults(), extras: {}, ok: false, reason: 'invalid-shape' }
    }
    settings.hudScope = hudScope
  }

  // 0.4（契约 2.0）：自定义全局提前量；缺字段/null → null（跟随 reminderLeadMin），
  // 出现时必须是 1–1440 整数（docs/35 §1.2）。
  const customReminderLeadMin = raw['customReminderLeadMin']
  if (customReminderLeadMin !== undefined && customReminderLeadMin !== null) {
    if (!isCustomReminderLeadMin(customReminderLeadMin)) {
      return { settings: defaults(), extras: {}, ok: false, reason: 'invalid-shape' }
    }
    settings.customReminderLeadMin = customReminderLeadMin
  }

  const extras: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'version' || key === 'autostart' || key === 'muted' || key === 'reminderLeadMin') {
      continue
    }
    if (key === 'hudScope' || key === 'customReminderLeadMin') continue
    extras[key] = value
  }

  return { settings, extras, ok: true, reason: null }
}

/** 纯函数：patch 合并（patch 中 undefined 表示不改；不会写入未知字段） */
export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  return {
    autostart: patch.autostart ?? current.autostart,
    muted: patch.muted ?? current.muted,
    reminderLeadMin: patch.reminderLeadMin ?? current.reminderLeadMin,
    // null 是有效值（跟随默认），不能用 ?? 合并；仅 undefined 表示不改
    customReminderLeadMin:
      patch.customReminderLeadMin !== undefined
        ? patch.customReminderLeadMin
        : current.customReminderLeadMin,
    hudScope: patch.hudScope ?? current.hudScope,
  }
}

export interface SettingsStore {
  get(): Settings
  /** 合并 patch 并立即原子写盘；写盘失败或原文件处于保护错误态时 throw（内存不更新） */
  update(patch: SettingsPatch): Settings
  /** 立即落盘（退出/测试用）；受保护或写失败时 throw，禁止覆盖原文件 */
  flush(): void
  /** 只读诊断：设置文件损坏/不可读时为保护错误，null = 正常可写（不新增 IPC 字段） */
  getLoadError(): Error | null
}

/** 设置文件损坏/未知版本时的统一可读错误（update/flush 拒绝覆盖） */
export const SETTINGS_PROTECTED_MESSAGE = '设置文件损坏，已保护原文件，请修复后重启'

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  )
}

export function createSettingsStore(filePath: string): SettingsStore {
  let settings = defaults()
  let extras: Record<string, unknown> = {}
  /** 非 null = 保护错误态：原文件不可动，update/flush 一律拒绝 */
  let loadError: Error | null = null

  const load = (): void => {
    let text: string | null
    try {
      text = readFileSync(filePath, 'utf8')
    } catch (error) {
      if (!isEnoent(error)) {
        // 读取权限/IO 错误：不能当“文件不存在”去写默认值（会覆盖用户原文件）
        loadError = new Error('无法读取设置文件，已保护原文件，请检查文件权限后重启', {
          cause: error,
        })
        console.error('[settings] 读取失败，已保护原文件（不写盘）:', error)
        return
      }
      text = null
    }

    const parsed = parseSettingsFile(text)
    settings = parsed.settings
    extras = parsed.extras

    if (parsed.ok || parsed.reason === 'missing') {
      loadError = null
      return
    }

    // 损坏/未知版本：仅内存用默认值，原文件字节与名称保持不变（不 rename、不建 .bad）
    loadError = new Error(SETTINGS_PROTECTED_MESSAGE, {
      cause: new Error(String(parsed.reason)),
    })
    console.error(
      `[settings] 设置文件无效（${String(parsed.reason)}），已保护原文件（不改名/不写盘），修复后重启`,
    )
  }

  const assertWritable = (): void => {
    if (loadError !== null) throw new Error(SETTINGS_PROTECTED_MESSAGE, { cause: loadError })
  }

  /** 原子写：同目录 tmp → rename；失败 throw（调用方不得更新内存） */
  const writeNow = (candidate: Settings): void => {
    const payload = { version: SETTINGS_FILE_VERSION, ...extras, ...candidate }
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      const tmpPath = `${filePath}.tmp`
      writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(tmpPath, filePath)
    } catch (error) {
      throw new Error('设置保存失败，本次修改未保存；请检查文件夹写入权限或磁盘空间后重试', {
        cause: error,
      })
    }
  }

  load()

  return {
    get: () => ({ ...settings }),
    update(patch) {
      assertWritable()
      const next = mergeSettings(settings, patch)
      // 先写盘成功，再更新内存：写失败时内存与文件都不变
      writeNow(next)
      settings = next
      return { ...settings }
    },
    flush() {
      assertWritable()
      writeNow(settings)
    },
    getLoadError: () => loadError,
  }
}
