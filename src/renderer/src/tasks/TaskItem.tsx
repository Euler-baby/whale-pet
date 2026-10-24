/**
 * 单条任务行（0.4.2：单一列表 + 搁置清单）
 *
 * - 未搁置任务（含已完成）在同一列表：勾选完成/取消完成、编辑、删除；未完成任务可搁置
 * - 已完成任务保留在列表并划掉/弱化，取消完成即恢复到活动状态（排序由 shared sortTasks 决定）
 * - 搁置清单中的行只提供恢复、删除（先恢复再处理）
 * - 归属标签：项目任务“项目：名称”，普通任务三分类；截止用 shared formatDueAt/formatCountdown
 */
import {
  TASK_CATEGORY_LABELS,
  TASK_COUNTDOWN_COLORS,
  TASK_IMPORTANCE_COLORS,
  TASK_IMPORTANCE_LABELS,
  countdownLevel,
  formatCountdown,
  formatDueAt,
  isTaskOverdue,
} from '@shared/tasks'
import type { Task } from '@shared/types'

import { formatMinuteTime, taskAttributionLabel } from './format'

interface TaskItemProps {
  task: Task
  now: number
  /** 项目任务显示项目名；非项目任务忽略 */
  projectName?: string | null
  busy: boolean
  onToggle: (task: Task) => void
  onEdit: (task: Task) => void
  onDelete: (task: Task) => void
  onArchive: (task: Task) => void
  onRestore: (task: Task) => void
}

export default function TaskItem({
  task,
  now,
  projectName = null,
  busy,
  onToggle,
  onEdit,
  onDelete,
  onArchive,
  onRestore,
}: TaskItemProps) {
  const done = task.status === 'done'
  const archived = task.archivedAt !== null
  const overdue = isTaskOverdue(task, now)
  const urgent = task.importance === 'urgent' && !done && !archived
  const countdown = countdownLevel(task.dueAt, now)
  const isProjectTask = task.projectId !== null
  const attribution = taskAttributionLabel(task, projectName)
  const categoryClass = task.category === null ? 'project' : task.category
  const dueText = task.dueAt === null ? null : formatDueAt(task.dueAt, now)
  // 已完成/搁置不再显示倒计时；过期只保留红色绝对时间（0.3.2 视觉口径）
  const showCountdown = !done && !archived && !overdue && task.dueAt !== null
  const stamp = archived
    ? task.archivedAt !== null
      ? `搁置于 ${formatMinuteTime(task.archivedAt)}`
      : null
    : done && task.completedAt !== null
      ? `完成于 ${formatMinuteTime(task.completedAt)}`
      : null

  return (
    <li
      className={[
        'task-item',
        done ? 'task-item--done' : '',
        overdue ? 'task-item--overdue' : '',
        urgent ? 'task-item--urgent' : '',
        archived ? 'task-item--archived' : '',
      ]
        .filter((name) => name !== '')
        .join(' ')}
      data-task-id={task.id}
    >
      {archived ? (
        <span className="task-item__archived-mark" aria-hidden="true">
          搁置
        </span>
      ) : (
        <input
          type="checkbox"
          className="task-item__check"
          checked={done}
          disabled={busy}
          aria-label={done ? `将「${task.title}」标记为未完成` : `完成「${task.title}」`}
          onChange={() => onToggle(task)}
        />
      )}

      <div className="task-item__body">
        <p className="task-item__title">{task.title}</p>
        <div className="task-item__meta">
          {isProjectTask ? (
            <span className="task-tag task-tag--project">{attribution}</span>
          ) : (
            <span className={`task-tag task-tag--${categoryClass}`}>
              {task.category === null ? '未分类' : TASK_CATEGORY_LABELS[task.category]}
            </span>
          )}
          <span className="task-item__importance">
            <span
              className="task-item__dot"
              style={{ backgroundColor: TASK_IMPORTANCE_COLORS[task.importance] }}
              aria-hidden="true"
            />
            {TASK_IMPORTANCE_LABELS[task.importance]}
          </span>
          {stamp !== null ? <span className="task-item__stamp">{stamp}</span> : null}
          {dueText !== null ? (
            <span className="task-item__due">
              <span
                className={
                  overdue ? 'task-item__due-abs task-item__due-abs--overdue' : 'task-item__due-abs'
                }
              >
                {dueText}
              </span>
              {showCountdown ? (
                <>
                  <span className="task-item__due-sep" aria-hidden="true">
                    {' · '}
                  </span>
                  <span
                    className={`task-item__countdown task-item__countdown--${countdown}`}
                    style={{ color: TASK_COUNTDOWN_COLORS[countdown] }}
                  >
                    {formatCountdown(task.dueAt, now)}
                  </span>
                </>
              ) : null}
            </span>
          ) : !done ? (
            <span className="task-item__due task-item__due--none">无截止</span>
          ) : null}
          {task.reminderLeadMinOverride !== null ? (
            <span className="task-item__reminder" title="任务级提醒提前量（覆盖全局默认）">
              提醒 {task.reminderLeadMinOverride} 分钟
            </span>
          ) : null}
        </div>
        {task.note !== null ? <p className="task-item__note">{task.note}</p> : null}
      </div>

      <div className="task-item__actions">
        {archived ? (
          <button
            type="button"
            className="task-item__action"
            disabled={busy}
            aria-label={`恢复任务「${task.title}」`}
            onClick={() => onRestore(task)}
          >
            恢复
          </button>
        ) : (
          <>
            <button
              type="button"
              className="task-item__action"
              disabled={busy}
              aria-label={`编辑任务「${task.title}」`}
              onClick={() => onEdit(task)}
            >
              编辑
            </button>
            {done ? null : (
              <button
                type="button"
                className="task-item__action"
                disabled={busy}
                aria-label={`搁置任务「${task.title}」`}
                onClick={() => onArchive(task)}
              >
                搁置
              </button>
            )}
          </>
        )}
        <button
          type="button"
          className="task-item__action task-item__action--danger"
          disabled={busy}
          aria-label={`删除任务「${task.title}」`}
          onClick={() => onDelete(task)}
        >
          删除
        </button>
      </div>
    </li>
  )
}
