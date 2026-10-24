/**
 * 项目列表（0.4.2：单列表口径）
 *
 * - 项目卡片始终全部显示（含当前范围零匹配）；先按 scope 取任务，再显示
 *   “当前范围：活动/已完成/搁置”三项计数与未搁置任务预览（含已完成，按 sortTasks 排序）
 * - 新建/编辑走模态弹窗；删除资格看全部状态任务引用，不能因当前筛选为空而放行
 */
import type { Project, Task, TaskViewCounts } from '@shared/types'

import TaskRows from './TaskRows'

export interface ProjectCardData {
  project: Project
  /** 当前 scope 下未搁置的任务（含已完成，shared sortTasks 排序） */
  preview: Task[]
  /** 当前 scope 下活动/已完成/搁置三项计数 */
  counts: TaskViewCounts
}

interface ProjectListProps {
  cards: ProjectCardData[]
  now: number
  busy: boolean
  loading: boolean
  loadError: string | null
  /** projectId → 全状态任务总数（删除资格） */
  totals: Readonly<Record<string, number>>
  onRetry: () => void
  onCreateProject: () => void
  onEditProject: (project: Project) => void
  onDeleteProject: (project: Project) => void
  onOpenProject: (projectId: string) => void
  onToggleTask: (task: Task) => void
  onEditTask: (task: Task) => void
  onDeleteTask: (task: Task) => void
  onArchiveTask: (task: Task) => void
  onRestoreTask: (task: Task) => void
}

export default function ProjectList({
  cards,
  now,
  busy,
  loading,
  loadError,
  totals,
  onRetry,
  onCreateProject,
  onEditProject,
  onDeleteProject,
  onOpenProject,
  onToggleTask,
  onEditTask,
  onDeleteTask,
  onArchiveTask,
  onRestoreTask,
}: ProjectListProps) {
  if (loading) {
    return <p className="tasks__state">正在加载项目…</p>
  }

  if (loadError !== null) {
    return (
      <div className="tasks__state tasks__state--error" role="alert">
        <p className="tasks__state-title">项目加载失败</p>
        <p>{loadError}</p>
        <button type="button" className="btn" onClick={onRetry}>
          重试
        </button>
      </div>
    )
  }

  if (cards.length === 0) {
    return (
      <div className="tasks__state">
        <p className="tasks__state-title">还没有项目，先建一个</p>
        <p>项目用来收纳同一目标下的任务；项目任务不计入生活/运动/学习的分类计数。</p>
        <button type="button" className="btn btn--primary" onClick={onCreateProject}>
          新建项目
        </button>
      </div>
    )
  }

  return (
    <div className="project-list">
      <h2 className="section-title">我的项目 · {cards.length}</h2>
      <ul className="project-cards">
        {cards.map(({ project, preview, counts }) => {
          const total = totals[project.id] ?? 0
          const cannotDelete = total > 0
          return (
            <li key={project.id} className="project-card">
              <div className="project-card__head">
                <button
                  type="button"
                  className="project-card__open"
                  aria-label={`打开项目「${project.name}」`}
                  onClick={() => onOpenProject(project.id)}
                >
                  {project.name}
                </button>
                <span className="project-card__counts">
                  当前范围：活动 {counts.active} · 已完成 {counts.completed} · 搁置{' '}
                  {counts.archived}
                </span>
                <span className="project-card__counts">当前显示 {preview.length} 项</span>
                <div className="project-card__actions">
                  <button
                    type="button"
                    className="btn"
                    aria-label={`进入项目「${project.name}」`}
                    disabled={busy}
                    onClick={() => onOpenProject(project.id)}
                  >
                    进入
                  </button>
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
              {project.note !== null ? <p className="project-card__note">{project.note}</p> : null}
              {cannotDelete ? (
                <p className="project-card__hint">项目下有任务（含已完成/搁置），不能删除</p>
              ) : null}
              <div className="project-card__preview">
                {preview.length > 0 ? (
                  <TaskRows
                    tasks={preview}
                    now={now}
                    projectName={project.name}
                    busy={busy}
                    onToggle={onToggleTask}
                    onEdit={onEditTask}
                    onDelete={onDeleteTask}
                    onArchive={onArchiveTask}
                    onRestore={onRestoreTask}
                  />
                ) : (
                  <p className="project-card__empty">
                    当前范围没有未搁置任务，仍可进入项目与编辑。
                  </p>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
