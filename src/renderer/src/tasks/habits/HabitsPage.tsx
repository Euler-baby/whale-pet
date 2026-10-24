/**
 * 打卡页（0.4；docs/34 §5、docs/36 §6）
 *
 * 0.4.2：卡片默认收起，只显示名称/频率短语/当前状态/打卡/展开；
 * 展开后才显示本期起止、备注、下期生效、已打卡时间、编辑/历史/删除。
 * - 展开状态是纯本地 UI 状态（每卡独立），不触发任何数据请求
 * - 独立 Habit 列表：无 streak、无旧历史入口、不联动任务
 * - 每周期最多一次：已打卡时按钮禁用并显示打卡时间；重复提交由 main 幂等去重
 * - 失败不伪成功：所有状态以 main 返回的快照为准，父组件负责重新拉取
 */
import { useState } from 'react'

import type { Habit, HabitSnapshot } from '@shared/types'

import {
  describePending,
  describeSchedule,
  formatCheckedAt,
  formatCycle,
  weeklyExplain,
} from './format'
import './habits.css'

interface HabitsPageProps {
  habits: HabitSnapshot[]
  loading: boolean
  loadError: string | null
  busy: boolean
  onRetry: () => void
  onCreate: () => void
  onEdit: (habit: Habit) => void
  onDelete: (habit: Habit) => void
  onCheckin: (snapshot: HabitSnapshot) => void
  onHistory: (habit: Habit) => void
}

/** 卡片详情区 id（aria-controls 目标）；habit.id 由 main 生成，不含空白 */
function detailsIdOf(habitId: string): string {
  return `habit-details-${habitId}`
}

export default function HabitsPage({
  habits,
  loading,
  loadError,
  busy,
  onRetry,
  onCreate,
  onEdit,
  onDelete,
  onCheckin,
  onHistory,
}: HabitsPageProps) {
  // 每卡独立展开；折叠状态不需要持久化，也不读任何数据
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set<string>())

  const toggleExpanded = (habitId: string): void => {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(habitId)) next.delete(habitId)
      else next.add(habitId)
      return next
    })
  }

  if (loading && habits.length === 0) {
    return <p className="tasks__state">正在加载打卡项目…</p>
  }

  if (loadError !== null && habits.length === 0) {
    return (
      <div className="tasks__state tasks__state--error" role="alert">
        <p className="tasks__state-title">打卡项目加载失败</p>
        <p>{loadError}</p>
        <button type="button" className="btn" onClick={onRetry}>
          重试
        </button>
      </div>
    )
  }

  if (habits.length === 0) {
    return (
      <div className="tasks__state">
        <p className="tasks__state-title">还没有打卡项目，先新建一个</p>
        <p>每项独立，按本机本地 04:00 分周期；不需要创建待办，也不与任务统计联动。</p>
        <button type="button" className="btn btn--primary" onClick={onCreate}>
          新建打卡项目
        </button>
      </div>
    )
  }

  return (
    <div className="habits">
      <h2 className="section-title">打卡项目 · {habits.length}</h2>
      <ul className="habit-cards">
        {habits.map(({ habit, currentCheckin }) => {
          const expanded = expandedIds.has(habit.id)
          const detailsId = detailsIdOf(habit.id)
          const weekly = habit.currentCycle.schedule
          return (
            <li
              key={habit.id}
              className={`habit-card ${expanded ? 'habit-card--expanded' : 'habit-card--collapsed'}`}
              data-habit-id={habit.id}
              data-expanded={expanded ? 'true' : 'false'}
            >
              <div className="habit-card__head">
                <h3 className="habit-card__name">{habit.name}</h3>
                <span className="habit-card__frequency">
                  {describeSchedule(habit.currentCycle.schedule)}
                </span>
              </div>

              <div className="habit-card__bar">
                {currentCheckin !== null ? (
                  <span className="habit-card__done">本周期已打卡</span>
                ) : (
                  <span className="habit-card__todo">本周期未打卡</span>
                )}
                <div className="habit-card__bar-actions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    aria-label={`打卡「${habit.name}」`}
                    disabled={busy || currentCheckin !== null}
                    onClick={() => onCheckin({ habit, currentCheckin })}
                  >
                    {currentCheckin !== null ? '已打卡' : '本期打卡'}
                  </button>
                  <button
                    type="button"
                    className="btn habit-card__expand"
                    aria-expanded={expanded}
                    aria-controls={detailsId}
                    aria-label={`${expanded ? '收起' : '展开'}「${habit.name}」详情`}
                    onClick={() => toggleExpanded(habit.id)}
                  >
                    {expanded ? '收起' : '展开'}
                  </button>
                </div>
              </div>

              {expanded ? (
                <div className="habit-card__details" id={detailsId}>
                  <p className="habit-card__cycle">{formatCycle(habit.currentCycle)}</p>

                  {habit.note !== null ? <p className="habit-card__note">{habit.note}</p> : null}

                  {weekly.frequency === 'weekly' ? (
                    <p className="habit-card__hint">{weeklyExplain(weekly.deadlineWeekday)}</p>
                  ) : (
                    <p className="habit-card__hint">每天本地 04:00 换周期；本周期内可打卡一次。</p>
                  )}

                  {habit.pendingSchedule !== null ? (
                    <p className="habit-card__pending">
                      {describePending(habit.pendingSchedule)}（下期生效）
                    </p>
                  ) : null}

                  <p className="habit-card__checked-at">
                    {currentCheckin !== null
                      ? `已打卡时间：${formatCheckedAt(currentCheckin.checkedAt)}`
                      : '已打卡时间：本周期还没有记录'}
                  </p>

                  <div className="habit-card__actions">
                    <button
                      type="button"
                      className="btn"
                      aria-label={`编辑打卡项目「${habit.name}」`}
                      disabled={busy}
                      onClick={() => onEdit(habit)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn"
                      aria-label={`查看「${habit.name}」打卡历史`}
                      disabled={busy}
                      onClick={() => onHistory(habit)}
                    >
                      历史
                    </button>
                    <button
                      type="button"
                      className="btn"
                      aria-label={`删除打卡项目「${habit.name}」`}
                      disabled={busy}
                      onClick={() => onDelete(habit)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
