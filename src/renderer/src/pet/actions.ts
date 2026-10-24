import type { PetAction, SpriteState, UrgentTasksState } from '@shared/types'

export const ACTION_DURATION_MS: Record<PetAction, number> = {
  // 比 WebP 最后一帧结束早 50ms：首尾与 idle 字节一致，切回时不额外停顿，也不触发 loop=1 回放。
  pat: 890,
  celebrate: 920,
  concern: 940,
  'idle-look': 1405,
}

/** 整图动作仅在端点与基础态不一致时短暂叠化。 */
export function spriteFadeMs(
  previousAction: PetAction | null,
  nextAction: PetAction | null,
  previousState: SpriteState,
  nextState: SpriteState,
  staticMode: boolean,
): number {
  if (staticMode) return 0
  if (previousAction !== null && nextAction !== null) return 90
  if (previousAction !== null || nextAction !== null) {
    const baseState = nextAction === null ? nextState : previousState
    return baseState === 'idle' ? 0 : 90
  }
  return previousState === nextState ? 0 : 90
}

const PRIORITY: Record<PetAction, number> = {
  concern: 4,
  pat: 3,
  celebrate: 2,
  'idle-look': 1,
}

/** Higher priority interrupts; equal priority never stacks or restarts. */
export function selectAction(current: PetAction | null, incoming: PetAction): PetAction | null {
  return current !== null && PRIORITY[incoming] <= PRIORITY[current] ? current : incoming
}

/** Ignore queue-only changes and existing tasks; react to newly urgent visible tasks. */
export function hasNewUrgent(previous: UrgentTasksState, next: UrgentTasksState): boolean {
  const old = new Set(
    previous.tasks.filter((task) => task.importance === 'urgent').map((task) => task.id),
  )
  return next.tasks.some((task) => task.importance === 'urgent' && !old.has(task.id))
}
