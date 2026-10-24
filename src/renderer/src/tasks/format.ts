/**
 * 任务窗展示辅助（0.4；纯前端格式化，不做业务判定）
 *
 * - 时间显示一律本机本地时间；业务日边界由 main/shared 计算，这里只负责“10-24 04:00”这种短文案
 * - 归属标签：项目任务显示“项目：名称”，普通任务显示三分类中文
 */
import { TASK_CATEGORY_LABELS } from '@shared/tasks'
import type { Task, TaskView } from '@shared/types'

/** 提醒提前量合法区间（docs/34 §6.1：1–1440 整数分钟） */
export const REMINDER_LEAD_MIN = 1
export const REMINDER_LEAD_MAX = 1440
/** 全局默认值（迁移不覆盖已有合法值；仅用于表单占位兜底） */
export const DEFAULT_REMINDER_LEAD_MIN = 15

export const VIEW_LABELS: Readonly<Record<TaskView, string>> = {
  active: '活动',
  completed: '已完成',
  archived: '搁置',
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 1–1440 的整数分钟（不接受 0/负数/小数/NaN） */
export function isValidReminderLead(value: number): boolean {
  return Number.isInteger(value) && value >= REMINDER_LEAD_MIN && value <= REMINDER_LEAD_MAX
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地时间短文案：`10-24 04:00` */
export function formatMinuteTime(timestamp: number): string {
  const date = new Date(timestamp)
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(
    date.getMinutes(),
  )}`
}

/** 任务归属标签（项目任务带项目名；普通任务用三分类中文） */
export function taskAttributionLabel(task: Task, projectName: string | null): string {
  if (task.projectId !== null) {
    return projectName !== null && projectName !== '' ? `项目：${projectName}` : '项目'
  }
  return task.category === null ? '未分类' : TASK_CATEGORY_LABELS[task.category]
}
