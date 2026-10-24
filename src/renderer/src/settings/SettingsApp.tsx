/**
 * 设置窗口 UI（0.4.0；docs/34 §6/§7、docs/36 §7）
 *
 * - 即时保存（无保存按钮）：updateSettings patch；
 * - 默认提醒时间：预设 5/15/30/60 保留，另支持自定义 1–1440 整数分钟；
 *   选预设时同次写 reminderLeadMin + customReminderLeadMin=null；选自定义时只写 custom；
 * - HUD 显示范围、自启、窗口重置等保持原状；设置窗仍为独立普通窗。
 */
import { useCallback, useEffect, useState } from 'react'

import type { Bootstrap, HudScope, ReminderLeadMin, Settings, SettingsPatch } from '@shared/types'

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; bootstrap: Bootstrap }
  | { phase: 'error'; message: string }

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 预设提前量（旧字段值域保持 5/15/30/60） */
const REMINDER_LEAD_OPTIONS: readonly ReminderLeadMin[] = [5, 15, 30, 60]
const REMINDER_LEAD_MIN = 1
const REMINDER_LEAD_MAX = 1440

function isReminderLeadMin(value: number): value is ReminderLeadMin {
  return (REMINDER_LEAD_OPTIONS as readonly number[]).includes(value)
}

/** HUD 显示范围（契约 1.9）：仅紧急（默认）/ 紧急+今日到期 */
const HUD_SCOPE_OPTIONS: readonly { value: HudScope; label: string }[] = [
  { value: 'urgent', label: '仅紧急（默认）' },
  { value: 'urgent-due', label: '紧急 + 今日到期' },
]

function isHudScope(value: string): value is HudScope {
  return HUD_SCOPE_OPTIONS.some((option) => option.value === value)
}

/** 旧 settings 缺字段回退：hudScope=urgent、customReminderLeadMin=null */
function normalizeSettings(settings: Settings): Settings {
  return {
    ...settings,
    hudScope: settings.hudScope ?? 'urgent',
    customReminderLeadMin: settings.customReminderLeadMin ?? null,
  }
}

export default function SettingsApp() {
  const [load, setLoad] = useState<LoadState>({ phase: 'loading' })
  const [settings, setSettings] = useState<Settings>({
    autostart: false,
    muted: false,
    reminderLeadMin: 15,
    customReminderLeadMin: null,
    hudScope: 'urgent',
  })
  const [autostartSupported, setAutostartSupported] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [customDraft, setCustomDraft] = useState('')
  const [leadError, setLeadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const pet = window.pet
    if (!pet) {
      setLoad({ phase: 'error', message: 'window.pet 未注入（preload 未生效）' })
      return
    }
    pet
      .bootstrap()
      .then((bootstrap) => {
        if (cancelled) return
        setSettings(normalizeSettings(bootstrap.settings))
        setAutostartSupported(bootstrap.autostartSupported)
        setLoad({ phase: 'ready', bootstrap })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoad({ phase: 'error', message: describeError(error) })
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 托盘/其他入口修改设置时 main 广播 pet:event.settings；设置窗保持打开也要即时同步（docs/16）
  useEffect(() => {
    const pet = window.pet
    if (!pet) return
    return pet.onEvent((event) => {
      if (event.type === 'settings') setSettings(normalizeSettings(event.settings))
    })
  }, [])

  // 自定义值以 main 为准回填输入框（bootstrap/事件同步后保持显示一致）
  useEffect(() => {
    if (settings.customReminderLeadMin !== null) {
      setCustomDraft(String(settings.customReminderLeadMin))
    }
  }, [settings.customReminderLeadMin])

  const apply = useCallback(async (patch: SettingsPatch) => {
    const pet = window.pet
    if (!pet) return
    setBusy(true)
    setNotice(null)
    try {
      const next = await pet.updateSettings(patch)
      setSettings(normalizeSettings(next))
      setNotice('已保存')
    } catch (error: unknown) {
      setNotice(`保存失败：${describeError(error)}`)
    } finally {
      setBusy(false)
    }
  }, [])

  const resetPosition = useCallback(async () => {
    const pet = window.pet
    if (!pet) return
    setBusy(true)
    setNotice(null)
    try {
      await pet.resetPosition()
      setNotice('窗口位置已重置')
    } catch (error: unknown) {
      setNotice(`重置失败：${describeError(error)}`)
    } finally {
      setBusy(false)
    }
  }, [])

  const closeWindow = useCallback(() => {
    window.close()
  }, [])

  const version = load.phase === 'ready' ? load.bootstrap.ipcVersion : '—'
  const customMode = settings.customReminderLeadMin !== null
  const effectiveLead = settings.customReminderLeadMin ?? settings.reminderLeadMin

  const commitCustomLead = (): void => {
    const value = Number(customDraft)
    if (!Number.isInteger(value) || value < REMINDER_LEAD_MIN || value > REMINDER_LEAD_MAX) {
      setLeadError(`请输入 ${REMINDER_LEAD_MIN}–${REMINDER_LEAD_MAX} 的整数分钟`)
      return
    }
    setLeadError(null)
    if (value !== settings.customReminderLeadMin) {
      void apply({ customReminderLeadMin: value })
    }
  }

  return (
    <main className="settings">
      <header>
        <h1>鲸鱼娘 · 设置</h1>
        <p className="hint">设置即时保存，无需点“确定”。</p>
      </header>

      {load.phase === 'error' ? (
        <p className="error" role="alert">
          {load.message}
        </p>
      ) : null}

      <section className="card">
        <label className="row">
          <span className="row__text">
            <strong>开机自启</strong>
            <small>
              {autostartSupported
                ? '开机后静默进入托盘（不弹窗）'
                : '仅安装版支持；开发版与便携版无法开机自启'}
            </small>
          </span>
          <input
            type="checkbox"
            checked={settings.autostart}
            disabled={busy || load.phase !== 'ready' || !autostartSupported}
            onChange={(event) => {
              void apply({ autostart: event.target.checked })
            }}
          />
        </label>

        <label className="row">
          <span className="row__text">
            <strong>音效（开发中）</strong>
            <small>v1 暂未接入音效，此开关暂不可用；接入后才会生效</small>
          </span>
          <input
            type="checkbox"
            checked={settings.muted}
            disabled
            aria-label="音效（开发中，暂不可用）"
          />
        </label>
      </section>

      <section className="card">
        <div className="row row--stack">
          <span className="row__text">
            <strong>默认提醒时间</strong>
            <small>
              任务到期前多少分钟提醒，{REMINDER_LEAD_MIN}–{REMINDER_LEAD_MAX} 整数分钟；
              单任务可单独指定覆盖。当前有效值：{effectiveLead} 分钟。
            </small>
            <small>跟随默认的任务使用此值；已提醒或已排队的阶段不会重复触发。</small>
          </span>
          <div className="row__controls">
            <select
              className="select"
              aria-label="默认提醒时间"
              value={customMode ? 'custom' : String(settings.reminderLeadMin)}
              disabled={busy || load.phase !== 'ready'}
              onChange={(event) => {
                const next = event.target.value
                if (next === 'custom') {
                  const initial = settings.customReminderLeadMin ?? effectiveLead
                  setCustomDraft(String(initial))
                  setLeadError(null)
                  void apply({ customReminderLeadMin: initial })
                  return
                }
                const minutes = Number(next)
                if (!isReminderLeadMin(minutes)) return
                setLeadError(null)
                // 选预设时同次写旧字段 + custom=null（docs/35 §1.2）
                void apply({ reminderLeadMin: minutes, customReminderLeadMin: null })
              }}
            >
              {REMINDER_LEAD_OPTIONS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} 分钟
                </option>
              ))}
              <option value="custom">自定义</option>
            </select>
            {customMode ? (
              <span className="reminder-custom">
                <input
                  type="number"
                  className="reminder-custom__input"
                  aria-label="自定义默认提醒时间（分钟）"
                  min={REMINDER_LEAD_MIN}
                  max={REMINDER_LEAD_MAX}
                  step={1}
                  value={customDraft}
                  disabled={busy || load.phase !== 'ready'}
                  onChange={(event) => {
                    setCustomDraft(event.target.value)
                    if (leadError !== null) setLeadError(null)
                  }}
                  onBlur={commitCustomLead}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitCustomLead()
                    }
                  }}
                />
                <span className="reminder-custom__unit">分钟前</span>
                <button
                  type="button"
                  className="btn"
                  aria-label="保存自定义提醒时间"
                  disabled={busy || load.phase !== 'ready'}
                  onClick={commitCustomLead}
                >
                  保存
                </button>
              </span>
            ) : null}
          </div>
          {leadError !== null ? (
            <p className="error error--inline" role="alert">
              {leadError}
            </p>
          ) : null}
        </div>
      </section>

      <section className="card">
        <label className="row">
          <span className="row__text">
            <strong>HUD 显示范围</strong>
            <small>桌宠上常驻的紧急任务卡片范围；默认仅紧急</small>
          </span>
          <select
            className="select"
            value={settings.hudScope}
            disabled={busy || load.phase !== 'ready'}
            aria-label="HUD 显示范围"
            onChange={(event) => {
              const next = event.target.value
              if (!isHudScope(next)) return
              void apply({ hudScope: next })
            }}
          >
            {HUD_SCOPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="card">
        <div className="row">
          <span className="row__text">
            <strong>窗口位置</strong>
            <small>把鲸鱼娘移回主屏右下角</small>
          </span>
          <button type="button" onClick={() => void resetPosition()} disabled={busy}>
            重置位置
          </button>
        </div>
        <div className="row">
          <span className="row__text">
            <strong>数据与隐私</strong>
            <small>设置保存在 userData/settings.json；v1 无数据库、无联网、无账号。</small>
          </span>
        </div>
      </section>

      <footer>
        <span className="meta">{notice ?? `契约 ${version}`}</span>
        <button type="button" onClick={closeWindow}>
          关闭
        </button>
      </footer>
    </main>
  )
}
