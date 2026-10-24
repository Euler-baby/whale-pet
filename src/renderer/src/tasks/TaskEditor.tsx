/**
 * 任务编辑模态（0.4；docs/34 §4/§6）
 *
 * - 归属只读：本版不支持任务在分类/项目之间移动，编辑不发送 category
 * - 提醒提前量：跟随全局默认（当前 X 分钟）或自定义 1–1440 整数分钟
 * - 保存失败保留输入并显示错误；取消不写入
 */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import {
  TASK_IMPORTANCE_LABELS,
  TASK_IMPORTANCES,
  TASK_NOTE_MAX,
  TASK_TITLE_MAX,
} from '@shared/tasks'
import type { Task, TaskImportance, TaskPatch } from '@shared/types'

import { datetimeLocalToTimestamp, timestampToDatetimeLocal } from './date-input'
import {
  formatMinuteTime,
  isValidReminderLead,
  REMINDER_LEAD_MAX,
  REMINDER_LEAD_MIN,
  taskAttributionLabel,
} from './format'

interface TaskEditorProps {
  task: Task
  /** 项目任务显示项目名；普通任务忽略 */
  projectName?: string | null
  /** 全局默认提前量（“跟随默认”显示当前值） */
  defaultReminderLeadMin: number
  onSave: (patch: TaskPatch) => Promise<void>
  onCancel: () => void
}

export default function TaskEditor({
  task,
  projectName = null,
  defaultReminderLeadMin,
  onSave,
  onCancel,
}: TaskEditorProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const saving = useRef(false)
  const composing = useRef(false)
  const [title, setTitle] = useState(task.title)
  const [importance, setImportance] = useState<TaskImportance>(task.importance)
  const [due, setDue] = useState(() => timestampToDatetimeLocal(task.dueAt))
  const [reminderMode, setReminderMode] = useState<'default' | 'custom'>(
    task.reminderLeadMinOverride === null ? 'default' : 'custom',
  )
  const [customLead, setCustomLead] = useState(
    task.reminderLeadMinOverride === null ? '45' : String(task.reminderLeadMinOverride),
  )
  const [note, setNote] = useState(task.note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (saving.current || composing.current) return
    if (title.trim() === '') {
      setError('请先输入任务标题')
      return
    }
    const dueAt = due === '' ? null : datetimeLocalToTimestamp(due)
    if (due !== '' && dueAt === null) {
      setError('到期时间无效，请重新选择')
      return
    }
    let reminderLeadMinOverride: number | null = null
    if (reminderMode === 'custom') {
      const value = Number(customLead)
      if (!isValidReminderLead(value)) {
        setError(`自定义提醒需为 ${REMINDER_LEAD_MIN}–${REMINDER_LEAD_MAX} 的整数分钟`)
        return
      }
      reminderLeadMinOverride = value
    }
    saving.current = true
    setBusy(true)
    setError(null)
    try {
      // 未改时间则保留原时间戳的秒/毫秒；不发送 category（本版不支持移动归属）。
      await onSave({
        title: title.trim(),
        importance,
        dueAt: due === timestampToDatetimeLocal(task.dueAt) ? task.dueAt : dueAt,
        note: note.trim() || null,
        reminderLeadMinOverride,
      })
    } catch (cause: unknown) {
      setError(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      className="modal task-editor"
      aria-labelledby="task-editor-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!saving.current) onCancel()
      }}
    >
      <form
        className="modal__body"
        onSubmit={(event) => void submit(event)}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={() => {
          composing.current = false
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.nativeEvent.isComposing || composing.current))
            event.preventDefault()
        }}
      >
        <h2 id="task-editor-title" className="modal__title">
          编辑任务
        </h2>
        <p className="modal__hint">
          归属：{taskAttributionLabel(task, projectName)}（本版不支持在分类/项目间移动）
        </p>
        <fieldset className="modal__fields" disabled={busy}>
          <label className="field">
            <span className="field__label">编辑标题</span>
            <input
              autoFocus
              value={title}
              maxLength={TASK_TITLE_MAX}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <div className="field-row">
            <label className="field">
              <span className="field__label">编辑重要性</span>
              <select
                aria-label="编辑重要性"
                value={importance}
                onChange={(event) => setImportance(event.target.value as TaskImportance)}
              >
                {TASK_IMPORTANCES.map((value) => (
                  <option key={value} value={value}>
                    {TASK_IMPORTANCE_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">编辑到期时间</span>
              <input
                type="datetime-local"
                step={60}
                value={due}
                onChange={(event) => setDue(event.target.value)}
              />
            </label>
          </div>
          <button type="button" className="btn modal__inline-button" onClick={() => setDue('')}>
            清除到期时间
          </button>
          <div className="field-row">
            <label className="field">
              <span className="field__label">提醒提前量</span>
              <select
                aria-label="编辑提醒提前量"
                value={reminderMode}
                onChange={(event) =>
                  setReminderMode(event.target.value === 'custom' ? 'custom' : 'default')
                }
              >
                <option value="default">跟随默认（{defaultReminderLeadMin} 分钟）</option>
                <option value="custom">自定义</option>
              </select>
            </label>
            {reminderMode === 'custom' ? (
              <label className="field">
                <span className="field__label">自定义（分钟）</span>
                <input
                  type="number"
                  aria-label="编辑自定义提前量（分钟）"
                  min={REMINDER_LEAD_MIN}
                  max={REMINDER_LEAD_MAX}
                  step={1}
                  value={customLead}
                  onChange={(event) => setCustomLead(event.target.value)}
                />
              </label>
            ) : null}
          </div>
          <p className="modal__hint">
            当前截止：
            {task.dueAt === null ? '无（设置到期时间后才提醒）' : formatMinuteTime(task.dueAt)}
            ；提前量 {REMINDER_LEAD_MIN}–{REMINDER_LEAD_MAX} 整数分钟。
          </p>
          <label className="field">
            <span className="field__label">备注</span>
            <textarea
              aria-label="备注"
              rows={4}
              value={note}
              maxLength={TASK_NOTE_MAX}
              placeholder="补充步骤、资料或需要注意的事"
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
        </fieldset>
        {error !== null ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}
        <div className="modal__actions">
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? '保存中…' : '保存修改'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
