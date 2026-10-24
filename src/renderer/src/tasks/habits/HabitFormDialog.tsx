/**
 * 打卡项目新建/编辑模态（0.4；docs/34 §5、docs/36 §6）
 *
 * - 名称 1–80 字；备注 ≤200；频率每天/每周（周截止为所选星期当天 04:00）
 * - 编辑频率/截止从下一周期生效：弹窗内说明“本期仍于 X 结束”
 * - 保存失败保留输入并显示错误
 */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import type { Habit, HabitSchedule, IsoWeekday } from '@shared/types'

import { formatMinuteTime } from '../format'
import {
  describeSchedule,
  formatWeekday,
  nextBoundaryAfter,
  WEEKDAY_OPTIONS,
  weeklyExplain,
} from './format'

const HABIT_NAME_MAX = 80
const HABIT_NOTE_MAX = 200

interface HabitFormDialogProps {
  /** 有值 = 编辑模式 */
  habit?: Habit
  onSubmit: (values: {
    name: string
    note: string | null
    schedule: HabitSchedule
  }) => Promise<void>
  onCancel: () => void
}

function effectiveSchedule(habit: Habit): HabitSchedule {
  return habit.pendingSchedule?.schedule ?? habit.currentCycle.schedule
}

function sameSchedule(a: HabitSchedule, b: HabitSchedule): boolean {
  if (a.frequency !== b.frequency) return false
  if (a.frequency === 'daily' || b.frequency === 'daily') return true
  return a.deadlineWeekday === b.deadlineWeekday
}

export default function HabitFormDialog({ habit, onSubmit, onCancel }: HabitFormDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const initialSchedule = habit === undefined ? null : effectiveSchedule(habit)
  const [name, setName] = useState(habit?.name ?? '')
  const [note, setNote] = useState(habit?.note ?? '')
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>(
    initialSchedule?.frequency ?? 'daily',
  )
  const [weekday, setWeekday] = useState<IsoWeekday>(
    initialSchedule?.frequency === 'weekly' ? initialSchedule.deadlineWeekday : 7,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  const schedule: HabitSchedule =
    frequency === 'daily'
      ? { frequency: 'daily', deadlineWeekday: null }
      : { frequency: 'weekly', deadlineWeekday: weekday }

  const scheduleChanged =
    habit !== undefined && initialSchedule !== null && !sameSchedule(initialSchedule, schedule)

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy) return
    const trimmedName = name.trim()
    if (trimmedName.length === 0) {
      setError('请先输入打卡项目名称')
      return
    }
    if (trimmedName.length > HABIT_NAME_MAX) {
      setError(`名称不能超过 ${HABIT_NAME_MAX} 字`)
      return
    }
    const trimmedNote = note.trim()
    if (trimmedNote.length > HABIT_NOTE_MAX) {
      setError(`备注不能超过 ${HABIT_NOTE_MAX} 字`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit({ name: trimmedName, note: trimmedNote === '' ? null : trimmedNote, schedule })
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      className="modal habit-modal"
      aria-labelledby="habit-form-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onCancel()
      }}
    >
      <form className="modal__body" onSubmit={(event) => void submit(event)}>
        <h2 id="habit-form-title" className="modal__title">
          {habit === undefined ? '新建打卡项目' : '编辑打卡项目'}
        </h2>
        <label className="field">
          <span className="field__label">名称</span>
          <input
            autoFocus
            value={name}
            maxLength={HABIT_NAME_MAX}
            placeholder="例如：每天背英语单词"
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value)
              if (error !== null) setError(null)
            }}
          />
        </label>
        <label className="field">
          <span className="field__label">备注（可选）</span>
          <textarea
            rows={2}
            value={note}
            maxLength={HABIT_NOTE_MAX}
            placeholder="目标或提醒自己的话"
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span className="field__label">频率</span>
            <select
              aria-label="频率"
              value={frequency}
              disabled={busy}
              onChange={(event) =>
                setFrequency(event.target.value === 'weekly' ? 'weekly' : 'daily')
              }
            >
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
            </select>
          </label>
          {frequency === 'weekly' ? (
            <label className="field">
              <span className="field__label">每周截止（04:00）</span>
              <select
                aria-label="每周截止星期"
                value={weekday}
                disabled={busy}
                onChange={(event) => setWeekday(Number(event.target.value) as IsoWeekday)}
              >
                {WEEKDAY_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {formatWeekday(value)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <p className="modal__hint">
          {frequency === 'daily'
            ? '每天本地 04:00 换周期，每个周期最多打卡一次。'
            : weeklyExplain(weekday)}
        </p>
        {habit !== undefined ? (
          <>
            <p className="modal__hint">
              本期仍于 {formatMinuteTime(habit.currentCycle.endAt)} 结束
              {scheduleChanged
                ? '；频率/截止修改从下一周期生效。'
                : '；未修改频率时仅名称/备注立即生效。'}
            </p>
            {scheduleChanged ? (
              <p className="modal__hint">
                下期预览：{formatMinuteTime(habit.currentCycle.endAt)} →{' '}
                {formatMinuteTime(nextBoundaryAfter(habit.currentCycle.endAt, schedule))}（
                {describeSchedule(schedule)}）；此后按完整周期运行。
              </p>
            ) : null}
          </>
        ) : null}
        <p className="modal__hint">
          名称最多 {HABIT_NAME_MAX} 字；备注最多 {HABIT_NOTE_MAX} 字；不提供连续天数统计。
          周期按本机本地时间 04:00 解释，不保存时区、不补卡。
        </p>
        {error !== null ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal__actions">
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? '保存中…' : habit === undefined ? '创建打卡项目' : '保存修改'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
