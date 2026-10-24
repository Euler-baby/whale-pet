/**
 * 快速录入（0.4；docs/34 §4.1、docs/36 §3）
 *
 * - 收起时只有标题 + 添加；点「详情」展开三行：归属、重要性、到期时间 + 提醒提前量
 * - 列表筛选与新增归属分离：混排/分类筛选下仍可显式选择归属；项目详情内固定归属当前项目
 * - 提醒提前量：跟随全局默认或自定义 1–1440 整数分钟；无截止时不调度提醒
 */
import { useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import {
  TASK_CATEGORIES,
  TASK_CATEGORY_LABELS,
  TASK_IMPORTANCES,
  TASK_IMPORTANCE_COLORS,
  TASK_IMPORTANCE_LABELS,
  TASK_TITLE_MAX,
} from '@shared/tasks'
import type { TaskCategory, TaskCreateInput, TaskImportance } from '@shared/types'

import { datetimeLocalToTimestamp } from './date-input'
import { isValidReminderLead, REMINDER_LEAD_MAX, REMINDER_LEAD_MIN } from './format'

export type QuickAddAttribution =
  | { kind: 'category'; category: TaskCategory }
  | { kind: 'project'; projectId: string; projectName: string }

interface QuickAddProps {
  attribution: QuickAddAttribution
  /** 分类模式是否允许改归属；项目详情固定当前项目 */
  allowCategoryChange: boolean
  /** 全局默认提醒提前量（“跟随默认”显示当前值） */
  defaultReminderLeadMin: number
  /** 额外说明（项目详情等） */
  hint?: string
  onCreate: (input: TaskCreateInput) => Promise<boolean>
}

export default function QuickAdd({
  attribution,
  allowCategoryChange,
  defaultReminderLeadMin,
  hint,
  onCreate,
}: QuickAddProps) {
  const [title, setTitle] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [category, setCategory] = useState<TaskCategory>(
    attribution.kind === 'category' ? attribution.category : 'life',
  )
  const [importance, setImportance] = useState<TaskImportance>('normal')
  const [dueInput, setDueInput] = useState('')
  const [reminderMode, setReminderMode] = useState<'default' | 'custom'>('default')
  const [customLead, setCustomLead] = useState('45')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const composing = useRef(false)
  const saving = useRef(false)
  const titleId = useId()
  const dueId = useId()
  const hintId = useId()
  const errorId = useId()

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (saving.current || composing.current) return
    const trimmed = title.trim()
    if (trimmed.length === 0) {
      setError('请先输入任务标题')
      titleRef.current?.focus()
      return
    }
    const dueAt = dueInput === '' ? null : datetimeLocalToTimestamp(dueInput)
    if (dueInput !== '' && dueAt === null) {
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
    setSubmitting(true)
    setError(null)
    const input: TaskCreateInput =
      attribution.kind === 'project'
        ? {
            title: trimmed,
            projectId: attribution.projectId,
            importance,
            dueAt,
            reminderLeadMinOverride,
          }
        : {
            title: trimmed,
            category,
            importance,
            dueAt,
            reminderLeadMinOverride,
          }
    const saved = await onCreate(input)
    saving.current = false
    setSubmitting(false)
    if (!saved) return
    setTitle('')
    setDueInput('')
    titleRef.current?.focus()
  }

  const clearTitle = (): void => {
    setTitle('')
    setError(null)
    titleRef.current?.focus()
  }

  return (
    <form className="quick-add" onSubmit={(event) => void handleSubmit(event)}>
      <div className="quick-add__row">
        <label className="sr-only" htmlFor={titleId}>
          任务标题
        </label>
        <input
          id={titleId}
          ref={titleRef}
          className="quick-add__title"
          type="text"
          value={title}
          maxLength={TASK_TITLE_MAX}
          placeholder="添加任务，回车保存"
          autoComplete="off"
          autoFocus
          disabled={submitting}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={() => {
            composing.current = false
          }}
          aria-invalid={error !== null}
          aria-describedby={error !== null ? errorId : hintId}
          onChange={(event) => {
            setTitle(event.target.value)
            if (error !== null) setError(null)
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || composing.current) {
              if (event.key === 'Enter') event.preventDefault()
              return
            }
            if (event.key === 'Escape') clearTitle()
          }}
        />
        <span className="quick-add__attribution-hint" title="当前归属；点「详情」可修改">
          归属：
          {attribution.kind === 'project'
            ? `项目：${attribution.projectName}`
            : TASK_CATEGORY_LABELS[category]}
        </span>
        <button
          type="button"
          className="btn quick-add__details-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? '收起详情' : '详情'}
        </button>
        <button
          type="submit"
          className="btn btn--primary"
          disabled={submitting}
          aria-label="添加任务"
        >
          {submitting ? '添加中…' : '添加'}
        </button>
      </div>

      {expanded ? (
        <div className="quick-add__details">
          <div className="quick-add__field">
            <span className="quick-add__field-label">归属</span>
            {attribution.kind === 'project' ? (
              <span className="quick-add__fixed-value">项目：{attribution.projectName}</span>
            ) : allowCategoryChange ? (
              <select
                className="select"
                aria-label="任务归属"
                value={category}
                disabled={submitting}
                onChange={(event) => setCategory(event.target.value as TaskCategory)}
              >
                {TASK_CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {TASK_CATEGORY_LABELS[value]}
                  </option>
                ))}
              </select>
            ) : (
              <span className="quick-add__fixed-value">{TASK_CATEGORY_LABELS[category]}</span>
            )}
          </div>

          <div className="quick-add__field">
            <span className="quick-add__field-label">重要性</span>
            <div className="chips" role="group" aria-label="任务重要性">
              {TASK_IMPORTANCES.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={value === 'urgent' ? 'chip chip--urgent' : 'chip'}
                  aria-pressed={importance === value}
                  disabled={submitting}
                  onClick={() => setImportance(value)}
                >
                  <span
                    className="chip__dot"
                    style={{ backgroundColor: TASK_IMPORTANCE_COLORS[value] }}
                    aria-hidden="true"
                  />
                  {TASK_IMPORTANCE_LABELS[value]}
                </button>
              ))}
            </div>
          </div>

          <div className="quick-add__field quick-add__field--due">
            <label className="quick-add__field-label" htmlFor={dueId}>
              到期时间
            </label>
            <input
              id={dueId}
              className="quick-add__due"
              type="datetime-local"
              value={dueInput}
              step={60}
              aria-label="到期时间"
              disabled={submitting}
              onChange={(event) => {
                setDueInput(event.target.value)
                if (error !== null) setError(null)
              }}
            />
            <span className="quick-add__field-label">提醒</span>
            <select
              className="select"
              aria-label="提醒提前量"
              value={reminderMode}
              disabled={submitting}
              onChange={(event) => {
                setReminderMode(event.target.value === 'custom' ? 'custom' : 'default')
                if (error !== null) setError(null)
              }}
            >
              <option value="default">跟随默认（{defaultReminderLeadMin} 分钟）</option>
              <option value="custom">自定义</option>
            </select>
            {reminderMode === 'custom' ? (
              <span className="quick-add__custom-lead">
                <input
                  type="number"
                  className="quick-add__number"
                  aria-label="自定义提前量（分钟）"
                  min={REMINDER_LEAD_MIN}
                  max={REMINDER_LEAD_MAX}
                  step={1}
                  value={customLead}
                  disabled={submitting}
                  onChange={(event) => {
                    setCustomLead(event.target.value)
                    if (error !== null) setError(null)
                  }}
                />
                <span className="quick-add__field-label">分钟前</span>
              </span>
            ) : null}
          </div>
          {dueInput === '' ? (
            <p className="quick-add__inline-hint">设置到期时间后才会提醒。</p>
          ) : null}
        </div>
      ) : null}

      {error !== null ? (
        <p id={errorId} className="quick-add__message quick-add__message--error" role="alert">
          {error}
        </p>
      ) : (
        <p id={hintId} className="quick-add__message">
          {hint ??
            (expanded
              ? '归属与筛选独立；取消分类筛选不会改变任务类别。'
              : '回车保存 · Esc 清空标题 · 「详情」可设置归属/重要性/到期与提醒')}
        </p>
      )}
    </form>
  )
}
