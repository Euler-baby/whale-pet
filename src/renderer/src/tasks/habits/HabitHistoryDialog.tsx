/**
 * 打卡历史（只读；0.4；docs/34 §5.4、docs/36 §6）
 *
 * - 只读新 Habit 历史：周期起止 + 打卡时间；无补卡/改历史/streak
 * - 分页 cursor 来自 main；加载失败显示错误与重试，不伪造记录
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import type { Habit, HabitCheckin } from '@shared/types'

import { describeError } from '../format'
import { formatCheckedAt, formatCycle } from './format'

interface HabitHistoryDialogProps {
  habit: Habit
  onClose: () => void
}

const PAGE_SIZE = 50

export default function HabitHistoryDialog({ habit, onClose }: HabitHistoryDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [records, setRecords] = useState<HabitCheckin[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadPage = useCallback(
    async (cursor: string | undefined, append: boolean): Promise<void> => {
      const pet = window.pet
      if (!pet) {
        setError('window.pet 未注入（preload 未生效）')
        setLoading(false)
        return
      }
      if (append) setLoadingMore(true)
      else setLoading(true)
      setError(null)
      try {
        const page = await pet.listHabitHistory(
          cursor === undefined
            ? { habitId: habit.id, limit: PAGE_SIZE }
            : { habitId: habit.id, limit: PAGE_SIZE, cursor },
        )
        setRecords((current) => (append ? [...current, ...page.records] : page.records))
        setNextCursor(page.nextCursor)
      } catch (cause: unknown) {
        setError(`加载历史失败：${describeError(cause)}`)
      } finally {
        setLoadingMore(false)
        setLoading(false)
      }
    },
    [habit.id],
  )

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  useEffect(() => {
    void loadPage(undefined, false)
  }, [loadPage])

  return (
    <dialog
      ref={dialog}
      className="modal habit-history"
      aria-labelledby="habit-history-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="modal__body">
        <h2 id="habit-history-title" className="modal__title">
          「{habit.name}」打卡历史（只读）
        </h2>
        <p className="modal__hint">按周期倒序；只显示已写入的新习惯记录，无补卡。</p>
        {loading ? (
          <p className="tasks__state">正在加载历史…</p>
        ) : error !== null ? (
          <div className="tasks__state tasks__state--error" role="alert">
            <p className="tasks__state-title">历史加载失败</p>
            <p>{error}</p>
            <button type="button" className="btn" onClick={() => void loadPage(undefined, false)}>
              重试
            </button>
          </div>
        ) : records.length === 0 ? (
          <p className="tasks__state">暂无打卡记录</p>
        ) : (
          <ul className="habit-history__list">
            {records.map((record) => (
              <li key={record.id} className="habit-history__item">
                <span className="habit-history__cycle">{formatCycle(record.cycle)}</span>
                <span className="habit-history__checked">
                  已打卡 {formatCheckedAt(record.checkedAt)}
                </span>
                {record.note !== null ? <p className="habit-history__note">{record.note}</p> : null}
              </li>
            ))}
          </ul>
        )}
        {nextCursor !== null && !loading ? (
          <button
            type="button"
            className="btn"
            disabled={loadingMore}
            onClick={() => void loadPage(nextCursor, true)}
          >
            {loadingMore ? '加载中…' : '加载更多'}
          </button>
        ) : null}
        <div className="modal__actions">
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </dialog>
  )
}
