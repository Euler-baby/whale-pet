/**
 * 项目详情（0.4.2：单列表口径）
 *
 * - 保留项目头（名称/备注/管理按钮）；任务列表只取该 projectId，应用今日/全部 scope，
 *   显示未搁置任务（含已完成，按 shared sortTasks 排序）
 * - 当前范围无任务时仍可编辑项目；新建任务统一走窗口右下角 FAB + 底部面板
 */
import type { Project, Task, TaskViewCounts } from '@shared/types'

import TaskRows from './TaskRows'

interface ProjectDetailProps {
  project: Project
  tasks: Task[]
  counts: TaskViewCounts | null
  scope: 'today' | 'all'
  now: number
  busy: boolean
  loading: boolean
  error: string | null
  /** 全状态任务总数（删除资格） */
  totalTasks: number
  onBack: () => void
  onRetry: () => void
  onEditProject: (project: Project) => void
  onDeleteProject: (project: Project) => void
  onShowAll: () => void
  onToggleTask: (task: Task) => void
  onEditTask: (task: Task) => void
  onDeleteTask: (task: Task) => void
  onArchiveTask: (task: Task) => void
  onRestoreTask: (task: Task) => void
}

export default function ProjectDetail({
  project,
  tasks,
  counts,
  scope,
  now,
  busy,
  loading,
  error,
  totalTasks,
  onBack,
  onRetry,
  onEditProject,
  onDeleteProject,
  onShowAll,
  onToggleTask,
  onEditTask,
  onDeleteTask,
  onArchiveTask,
  onRestoreTask,
}: ProjectDetailProps) {
  const cannotDelete = totalTasks > 0

  return (
    <div className="project-detail">
      <div className="project-detail__head">
        <button type="button" className="btn" aria-label="返回项目列表" onClick={onBack}>
          ← 返回项目列表
        </button>
        <h2 className="project-detail__title">{project.name}</h2>
        <span className="project-detail__counts">
          当前范围：活动 {counts?.active ?? 0} · 已完成 {counts?.completed ?? 0} · 搁置{' '}
          {counts?.archived ?? 0}
        </span>
        <div className="project-detail__actions">
          <button
            type="button"
            className="btn"
            aria-label={`编辑项目「${project.name}」`}
            disabled={busy}
            onClick={() => onEditProject(project)}
          >
            编辑项目
          </button>
          <button
            type="button"
            className="btn"
            aria-label={`删除项目「${project.name}」`}
            title={cannotDelete ? '项目下有任务（含已完成/搁置），不能删除' : '删除空项目'}
            disabled={busy || cannotDelete}
            onClick={() => onDeleteProject(project)}
          >
            删除
          </button>
        </div>
      </div>
      {project.note !== null ? <p className="project-detail__note">{project.note}</p> : null}

      <div className="tasks__list" role="tabpanel" aria-label="项目任务">
        {loading ? (
          <p className="tasks__state">正在加载项目任务…</p>
        ) : error !== null ? (
          <div className="tasks__state tasks__state--error" role="alert">
            <p className="tasks__state-title">项目任务加载失败</p>
            <p>{error}</p>
            <button type="button" className="btn" onClick={onRetry}>
              重试
            </button>
          </div>
        ) : tasks.length === 0 ? (
          <div className="tasks__state">
            <p className="tasks__state-title">
              当前范围（{scope === 'today' ? '今日' : '全部'}）没有未搁置任务
            </p>
            <p>可点右下角「+ 新建任务」添加到本项目，或切换时间范围查看。</p>
            {scope === 'today' ? (
              <button type="button" className="btn" onClick={onShowAll}>
                查看全部范围
              </button>
            ) : null}
          </div>
        ) : (
          <TaskRows
            tasks={tasks}
            now={now}
            projectName={project.name}
            busy={busy}
            onToggle={onToggleTask}
            onEdit={onEditTask}
            onDelete={onDeleteTask}
            onArchive={onArchiveTask}
            onRestore={onRestoreTask}
          />
        )}
      </div>
    </div>
  )
}
