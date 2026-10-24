/**
 * 设置存储：纯函数 + 文件保护单测（不加载 Electron；store 用例用临时目录）
 *
 * 对应 docs/05 §4、docs/25 §5.1/§7.1、docs/35 §1.2/§5.2：
 * version + 校验、未知字段保留、损坏时**保护原文件**（不 rename/.bad/不覆盖）、patch 合并；
 * 0.3.1a（契约 1.7）新增 reminderLeadMin（5/15/30/60，默认 15，旧文件缺字段回退默认）；
 * 0.3.2（契约 1.9）新增 hudScope（'urgent' 默认 / 'urgent-due'，旧文件缺字段回退默认）；
 * 0.4.0（契约 2.0）新增 customReminderLeadMin（1–1440 整数或 null，缺省/null 回退 null），
 * 读取允许缺 version（视为 v1），每次新写入仍写 version=1；缺失文件默认可写。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createSettingsStore,
  CUSTOM_REMINDER_LEAD_MIN_MAX,
  CUSTOM_REMINDER_LEAD_MIN_MIN,
  DEFAULT_SETTINGS,
  isCustomReminderLeadMin,
  mergeSettings,
  parseSettingsFile,
  REMINDER_LEAD_MIN_VALUES,
  SETTINGS_FILE_VERSION,
  SETTINGS_PROTECTED_MESSAGE,
} from '../../src/main/services/settings-store'
import type { Settings } from '@shared/types'

/** 以默认值为底构造合法 Settings，避免每个用例重复写全字段 */
function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

describe('DEFAULT_SETTINGS', () => {
  it('默认值：autostart/muted 关闭、提前量 15 分钟、自定义提前量 null、HUD 仅紧急', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      autostart: false,
      muted: false,
      reminderLeadMin: 15,
      customReminderLeadMin: null,
      hudScope: 'urgent',
    })
  })

  it('允许值只有 5 / 15 / 30 / 60；自定义范围 1–1440', () => {
    expect(REMINDER_LEAD_MIN_VALUES).toEqual([5, 15, 30, 60])
    expect(CUSTOM_REMINDER_LEAD_MIN_MIN).toBe(1)
    expect(CUSTOM_REMINDER_LEAD_MIN_MAX).toBe(1440)
    expect(isCustomReminderLeadMin(1)).toBe(true)
    expect(isCustomReminderLeadMin(1440)).toBe(true)
    expect(isCustomReminderLeadMin(0)).toBe(false)
    expect(isCustomReminderLeadMin(1441)).toBe(false)
    expect(isCustomReminderLeadMin(1.5)).toBe(false)
    expect(isCustomReminderLeadMin(null)).toBe(false)
  })
})

describe('parseSettingsFile', () => {
  it('文件不存在 → 默认值（含 reminderLeadMin=15/custom=null/hudScope=urgent），reason=missing', () => {
    const result = parseSettingsFile(null)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('missing')
    expect(result.settings).toEqual(DEFAULT_SETTINGS)
  })

  it('合法文件 → 读取已知字段，未知字段进入 extras', () => {
    const text = JSON.stringify({
      version: SETTINGS_FILE_VERSION,
      autostart: true,
      muted: true,
      reminderLeadMin: 30,
      customReminderLeadMin: 45,
      hudScope: 'urgent-due',
      futureFlag: 'keep-me',
    })
    const result = parseSettingsFile(text)
    expect(result.ok).toBe(true)
    expect(result.reason).toBeNull()
    expect(result.settings).toEqual({
      autostart: true,
      muted: true,
      reminderLeadMin: 30,
      customReminderLeadMin: 45,
      hudScope: 'urgent-due',
    })
    // 已知识别字段不进入 extras
    expect(result.extras).toEqual({ futureFlag: 'keep-me' })
  })

  it('旧设置文件缺 reminderLeadMin/custom/hudScope → 回退默认，不失败', () => {
    const result = parseSettingsFile(
      JSON.stringify({ version: SETTINGS_FILE_VERSION, autostart: true, muted: false }),
    )
    expect(result.ok).toBe(true)
    expect(result.reason).toBeNull()
    expect(result.settings).toEqual({
      autostart: true,
      muted: false,
      reminderLeadMin: 15,
      customReminderLeadMin: null,
      hudScope: 'urgent',
    })
    expect(result.extras).toEqual({})
  })

  it('旧设置文件缺 version 视为 v1，仍可读（不因缺 version 判坏）', () => {
    const result = parseSettingsFile(
      JSON.stringify({
        autostart: true,
        muted: true,
        reminderLeadMin: 5,
        customReminderLeadMin: 1440,
      }),
    )
    expect(result.ok).toBe(true)
    expect(result.reason).toBeNull()
    expect(result.settings).toEqual({
      autostart: true,
      muted: true,
      reminderLeadMin: 5,
      customReminderLeadMin: 1440,
      hudScope: 'urgent',
    })
  })

  it('reminderLeadMin 四档合法值都能读取', () => {
    for (const lead of REMINDER_LEAD_MIN_VALUES) {
      const result = parseSettingsFile(
        JSON.stringify({ version: SETTINGS_FILE_VERSION, reminderLeadMin: lead }),
      )
      expect(result.ok).toBe(true)
      expect(result.settings.reminderLeadMin).toBe(lead)
    }
  })

  it('hudScope 两档合法值都能读取', () => {
    for (const scope of ['urgent', 'urgent-due'] as const) {
      const result = parseSettingsFile(
        JSON.stringify({ version: SETTINGS_FILE_VERSION, hudScope: scope }),
      )
      expect(result.ok).toBe(true)
      expect(result.settings.hudScope).toBe(scope)
      expect(result.extras).toEqual({})
    }
  })

  it('customReminderLeadMin 合法边界值与 null 都能读取', () => {
    for (const custom of [1, 45, 1440]) {
      const result = parseSettingsFile(
        JSON.stringify({ version: SETTINGS_FILE_VERSION, customReminderLeadMin: custom }),
      )
      expect(result.ok).toBe(true)
      expect(result.settings.customReminderLeadMin).toBe(custom)
      expect(result.extras).toEqual({})
    }
    // null 表示“使用 reminderLeadMin”，不是坏文件
    const nullable = parseSettingsFile(
      JSON.stringify({ version: SETTINGS_FILE_VERSION, customReminderLeadMin: null }),
    )
    expect(nullable.ok).toBe(true)
    expect(nullable.settings.customReminderLeadMin).toBeNull()
  })

  it('缺全部已知识别字段 → 全默认值（不因缺字段失败）', () => {
    const result = parseSettingsFile(JSON.stringify({ version: SETTINGS_FILE_VERSION }))
    expect(result.ok).toBe(true)
    expect(result.settings).toEqual(DEFAULT_SETTINGS)
  })

  it('reminderLeadMin 非法值 → 默认值，reason=invalid-shape', () => {
    for (const bad of [7, 0, 20, 60 * 24, '15', true, null]) {
      const result = parseSettingsFile(
        JSON.stringify({ version: SETTINGS_FILE_VERSION, reminderLeadMin: bad }),
      )
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('invalid-shape')
      expect(result.settings).toEqual(DEFAULT_SETTINGS)
      expect(result.extras).toEqual({})
    }
  })

  it('customReminderLeadMin 非法值（0/1441/小数/字符串/布尔）→ invalid-shape', () => {
    for (const bad of [0, -1, 1441, 1.5, '45', true, []]) {
      const result = parseSettingsFile(
        JSON.stringify({ version: SETTINGS_FILE_VERSION, customReminderLeadMin: bad }),
      )
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('invalid-shape')
      expect(result.settings).toEqual(DEFAULT_SETTINGS)
      expect(result.extras).toEqual({})
    }
  })

  it('hudScope 非法值 → 默认值，reason=invalid-shape', () => {
    for (const bad of ['urgent_due', 'URGENT', 'all', '', 1, true, null]) {
      const result = parseSettingsFile(
        JSON.stringify({ version: SETTINGS_FILE_VERSION, hudScope: bad }),
      )
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('invalid-shape')
      expect(result.settings).toEqual(DEFAULT_SETTINGS)
      expect(result.extras).toEqual({})
    }
  })

  it('坏 JSON → 默认值，reason=invalid-json', () => {
    const result = parseSettingsFile('{ not json')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('invalid-json')
    expect(result.settings).toEqual(DEFAULT_SETTINGS)
  })

  it('非对象 → 默认值，reason=invalid-shape', () => {
    const result = parseSettingsFile('[]')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('invalid-shape')
  })

  it('布尔字段类型错误 → 默认值，reason=invalid-shape', () => {
    const result = parseSettingsFile(JSON.stringify({ version: 1, autostart: 'yes' }))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('invalid-shape')
  })

  it('未知版本 → 默认值，reason=unknown-version', () => {
    const result = parseSettingsFile(JSON.stringify({ version: 99, autostart: true }))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unknown-version')
    expect(result.settings).toEqual(DEFAULT_SETTINGS)
  })
})

describe('mergeSettings', () => {
  it('空 patch 不改动', () => {
    expect(mergeSettings(baseSettings({ autostart: true }), {})).toEqual(
      baseSettings({ autostart: true }),
    )
  })

  it('只改 patch 中出现的字段', () => {
    expect(mergeSettings(baseSettings({ autostart: true }), { muted: true })).toEqual(
      baseSettings({ autostart: true, muted: true }),
    )
  })

  it('reminderLeadMin 可被 patch 更新，patch 中 undefined 表示不改', () => {
    expect(mergeSettings(baseSettings(), { reminderLeadMin: 60 })).toEqual(
      baseSettings({ reminderLeadMin: 60 }),
    )
    expect(
      mergeSettings(baseSettings({ reminderLeadMin: 30 }), { reminderLeadMin: undefined }),
    ).toEqual(baseSettings({ reminderLeadMin: 30 }))
  })

  it('customReminderLeadMin：数字写入、null 表示跟随默认、undefined 不改', () => {
    expect(mergeSettings(baseSettings(), { customReminderLeadMin: 45 })).toEqual(
      baseSettings({ customReminderLeadMin: 45 }),
    )
    // null 是有效值，不能像旧字段一样用 ?? 吃掉
    expect(
      mergeSettings(baseSettings({ customReminderLeadMin: 45 }), { customReminderLeadMin: null }),
    ).toEqual(baseSettings({ customReminderLeadMin: null }))
    expect(
      mergeSettings(baseSettings({ customReminderLeadMin: 45 }), {
        customReminderLeadMin: undefined,
      }),
    ).toEqual(baseSettings({ customReminderLeadMin: 45 }))
  })

  it('hudScope 可被 patch 更新，patch 中 undefined 表示不改', () => {
    expect(mergeSettings(baseSettings(), { hudScope: 'urgent-due' })).toEqual(
      baseSettings({ hudScope: 'urgent-due' }),
    )
    expect(
      mergeSettings(baseSettings({ hudScope: 'urgent-due' }), { hudScope: undefined }),
    ).toEqual(baseSettings({ hudScope: 'urgent-due' }))
  })

  it('返回新对象，不修改入参', () => {
    const current = baseSettings()
    const next = mergeSettings(current, { autostart: true })
    expect(next).not.toBe(current)
    expect(current.autostart).toBe(false)
    expect(next).toEqual(baseSettings({ autostart: true }))
  })
})

// ---------------------------------------------------------------------------
// 文件保护与原子写（docs/35 §5.2：损坏 settings 不 rename/不覆盖）
// ---------------------------------------------------------------------------

describe('createSettingsStore 文件保护', () => {
  let dir: string

  const filePath = (root: string): string => join(root, 'settings.json')
  const readText = (path: string): string => readFileSync(path, 'utf8')
  const listNames = (root: string): string[] => readdirSync(root)

  /** 目录里只有 settings.json（不含 .bad/.tmp），用于断言保护时未产生副作用 */
  const expectOnlyOriginal = (root: string, original: string): void => {
    const names = listNames(root)
    expect(names).toEqual(['settings.json'])
    expect(readText(filePath(root))).toBe(original)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'whale-settings-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('文件不存在 → 默认值、可写；update 立即原子写 version=1', () => {
    const path = filePath(dir)
    const store = createSettingsStore(path)
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect(store.getLoadError()).toBeNull()

    const next = store.update({ muted: true })
    expect(next).toEqual(baseSettings({ muted: true }))
    expect(store.get()).toEqual(baseSettings({ muted: true }))
    const written = JSON.parse(readText(path)) as Record<string, unknown>
    expect(written).toEqual({ version: 1, ...baseSettings({ muted: true }) })
  })

  it('文件不存在 → flush 也能创建默认设置文件', () => {
    const path = filePath(dir)
    const store = createSettingsStore(path)
    store.flush()
    const written = JSON.parse(readText(path)) as Record<string, unknown>
    expect(written).toEqual({ version: 1, ...DEFAULT_SETTINGS })
  })

  it('旧 settings 缺 version 视为 v1 可读；保存时写 version=1 并保留未知字段', () => {
    const path = filePath(dir)
    const original = `${JSON.stringify({ autostart: true, futureFlag: 'keep-me' }, null, 2)}\n`
    writeFileSync(path, original, 'utf8')

    const store = createSettingsStore(path)
    expect(store.getLoadError()).toBeNull()
    expect(store.get()).toEqual(
      baseSettings({ autostart: true, reminderLeadMin: 15, customReminderLeadMin: null }),
    )

    store.update({ muted: true })
    const written = JSON.parse(readText(path)) as Record<string, unknown>
    expect(written).toEqual({
      version: 1,
      ...baseSettings({ autostart: true, muted: true }),
      futureFlag: 'keep-me',
    })
  })

  it('坏 JSON → 保护原文件：不改名/不建 .bad/不写，update/flush 拒绝覆盖', () => {
    const path = filePath(dir)
    const original = '{ not json'
    writeFileSync(path, original, 'utf8')

    const store = createSettingsStore(path)
    // 运行期默认值可用，但处于保护错误态
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect(store.getLoadError()?.message).toBe(SETTINGS_PROTECTED_MESSAGE)

    expect(() => store.update({ muted: true })).toThrow(SETTINGS_PROTECTED_MESSAGE)
    expect(() => store.flush()).toThrow(SETTINGS_PROTECTED_MESSAGE)
    expectOnlyOriginal(dir, original)
    // 内存也没有变成“半成功”的新值
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
  })

  it('非法结构 / 未知版本 → 同样保护原文件，不产生 .bad', () => {
    for (const original of [
      `${JSON.stringify({ version: 1, reminderLeadMin: 7 }, null, 2)}\n`,
      `${JSON.stringify({ version: 99, autostart: true }, null, 2)}\n`,
      '[]',
    ]) {
      const caseDir = mkdtempSync(join(dir, 'case-'))
      const path = filePath(caseDir)
      writeFileSync(path, original, 'utf8')

      const store = createSettingsStore(path)
      expect(store.get()).toEqual(DEFAULT_SETTINGS)
      expect(store.getLoadError()?.message).toBe(SETTINGS_PROTECTED_MESSAGE)
      expect(() => store.update({ muted: true })).toThrow(SETTINGS_PROTECTED_MESSAGE)
      expect(() => store.flush()).toThrow(SETTINGS_PROTECTED_MESSAGE)
      expectOnlyOriginal(caseDir, original)
    }
  })

  it('读取非 ENOENT 错误（路径是目录）→ 保护、不写、不建 .bad', () => {
    const path = filePath(dir)
    mkdirSync(path)

    const store = createSettingsStore(path)
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect(store.getLoadError()).not.toBeNull()
    expect(store.getLoadError()?.message).toContain('保护原文件')
    expect(() => store.update({ muted: true })).toThrow(/保护原文件/)
    expect(() => store.flush()).toThrow(/保护原文件/)
    // 目录保持原样，没有 .bad/.tmp
    expect(listNames(dir)).toEqual(['settings.json'])
    expect(readdirSync(path)).toEqual([])
  })

  it('缺失文件但写盘失败 → update 抛可读错误且内存不更新', () => {
    // 先按“文件不存在”装载（默认值可写），再把父路径变成文件使写入失败
    const nestedPath = join(dir, 'nested', 'settings.json')
    const store = createSettingsStore(nestedPath)
    const before = store.get()
    writeFileSync(join(dir, 'nested'), 'blocker', 'utf8')

    expect(() => store.update({ muted: true })).toThrow('设置保存失败')
    expect(store.get()).toEqual(before)
  })
})
