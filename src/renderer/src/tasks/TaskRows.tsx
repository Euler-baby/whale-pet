/**
 * 任务行列表（0.4.2）：把 Task[] 渲染为 TaskItem；排序与筛选由 main/shared 决定
 *
 * - 主列表：未搁置任务（含已完成）；搁置清单：archivedAt 非空的任务（只恢复/删除）
 * - 不传 view：行内行为由 task.status / task.archivedAt 自行判断
 */
import type { Task } from '@shared/types'

import TaskItem from './TaskItem'

interface TaskRowsProps {
  tasks: Task[]
  now: number
  /** 固定项目名（项目详情/项目卡片预览）；混排列表改用 projectNames */
  projectName?: string | null
  /** 混排列表用：projectId → 项目名 */
  projectNames?: ReadonlyMap<string, string>
  busy: boolean
  onToggle: (task: Task) => void
  onEdit: (task: Task) => void
  onDelete: (task: Task) => void
  onArchive: (task: Task) => void
  onRestore: (task: Task) => void
}

export default function TaskRows({
  tasks,
  now,
  projectName = null,
  projectNames,
  busy,
  onToggle,
  onEdit,
  onDelete,
  onArchive,
  onRestore,
}: TaskRowsProps) {
  return (
    <ul className="task-list">
      {tasks.map((task) => (
        <TaskItem
          key={task.id}
          task={task}
          now={now}
          projectName={
            projectNames !== undefined && task.projectId !== null
              ? (projectNames.get(task.projectId) ?? projectName)
              : projectName
          }
          busy={busy}
          onToggle={onToggle}
          onEdit={onEdit}
          onDelete={onDelete}
          onArchive={onArchive}
          onRestore={onRestore}
        />
      ))}
    </ul>
  )
}
