/**
 * HUD 常驻卡片（0.3.2 C-02；docs/25 §7.1/§7.2）
 *
 * - 数据完全来自 main（Bootstrap.urgentTasks / pet:event.tasks-urgent）：最多 3 条 + total + queued，
 *   renderer 不做排队，只展示；HUD 活跃时由 App 抑制普通气泡/问候
 * - 剩余时间用 shared formatCountdown/countdownLevel/TASK_COUNTDOWN_COLORS；now 由 App 每 30s 刷新
 * - 「打开」按钮调用 window.pet.openTasks()；命中矩形由 App 统一对 .hud 实际矩形上报
 * - 新出现的任务行 pulse 红色；每次状态变化重放一次轻量高亮（含任务完成/降级后的移除）
 */
import { useEffect, useRef, useState } from 'react'

import {
  TASK_COUNTDOWN_COLORS,
  TASK_IMPORTANCE_COLORS,
  countdownLevel,
  formatCountdown,
} from '@shared/tasks'
import type { HudScope, UrgentTasksState } from '@shared/types'

interface HudCardProps {
  state: UrgentTasksState
  hudScope: HudScope
  /** App 级共享时刻（30s tick），用于倒计时文案与颜色分级 */
  now: number
  onOpenTasks: () => void
}

export default function HudCard({ state, hudScope, now, onOpenTasks }: HudCardProps) {
  const [pulseIds, setPulseIds] = useState<readonly string[]>([])
  const previousIds = useRef<readonly string[]>([])

  // 新出现的任务 id → pulse 一次（完成/降级后的移除不保留 ghost 行，由整卡高亮反馈）
  useEffect(() => {
    const currentIds = state.tasks.map((task) => task.id)
    const added = currentIds.filter((id) => !previousIds.current.includes(id))
    previousIds.current = currentIds
    if (added.length > 0) setPulseIds(added)
  }, [state.tasks])

  useEffect(() => {
    if (pulseIds.length === 0) return
    const timer = window.setTimeout(() => setPulseIds([]), 1400)
    return () => window.clearTimeout(timer)
  }, [pulseIds])

  if (state.tasks.length === 0) return null

  const title = hudScope === 'urgent-due' ? '紧急与今日到期' : '紧急任务'
  // 契约 1.9：main 已裁剪到最多 3 条；这里再兜底一次，防止 UI 越过“最多 3 条常驻”
  const shown = state.tasks.slice(0, 3)
  const remaining = state.total - shown.length
  // 每次状态变化换 key：重放一次整卡高亮，让「新增/完成/降级」都有视觉反馈
  const flashKey = `${state.total}-${state.queued}-${state.tasks.map((task) => task.id).join(',')}`

  return (
    <section className="hud" role="region" aria-label="紧急任务 HUD" data-hud-scope={hudScope}>
      <span key={flashKey} className="hud__flash" aria-hidden="true" />
      <div className="hud__head">
        <p className="hud__title">
          {title} · {state.total}
        </p>
        <button type="button" className="hud__open" aria-label="打开任务清单" onClick={onOpenTasks}>
          打开
        </button>
      </div>

      {state.queued > 0 ? (
        <p className="hud__badge" aria-label={`还有 ${state.queued} 条提醒排队`}>
          +{state.queued} 条提醒
        </p>
      ) : null}

      <ul className="hud__list" aria-label="紧急任务列表">
        {shown.map((task) => {
          const level = countdownLevel(task.dueAt, now)
          const classes = [
            'hud__row',
            task.importance === 'urgent' ? 'hud__row--urgent' : '',
            pulseIds.includes(task.id) ? 'hud__row--pulse' : '',
          ]
            .filter((name) => name !== '')
            .join(' ')
          return (
            <li
              key={task.id}
              className={classes}
              aria-label={`任务「${task.title}」`}
              data-task-id={task.id}
            >
              <span
                className="hud__dot"
                style={{ backgroundColor: TASK_IMPORTANCE_COLORS[task.importance] }}
                aria-hidden="true"
              />
              <span className="hud__task">
                {task.projectName !== null ? (
                  <span className="hud__project">项目：{task.projectName}</span>
                ) : null}
                <span className="hud__task-title" title={task.title}>
                  {task.title}
                </span>
              </span>
              <span
                className={`hud__due hud__due--${level}`}
                style={{ color: TASK_COUNTDOWN_COLORS[level] }}
              >
                {formatCountdown(task.dueAt, now)}
              </span>
            </li>
          )
        })}
      </ul>

      {remaining > 0 ? <p className="hud__more">还有 {remaining} 条</p> : null}
    </section>
  )
}
