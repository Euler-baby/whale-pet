/** 480px 坐标系中的分层姿态；不依赖 DOM，便于素材到位后复用。 */
export interface RigTransform {
  x: number
  y: number
  rotation: number
  scale: number
}

export interface RigKeyframe {
  at: number
  pose: RigTransform
  /** 三次 Bezier 的两个控制点；x 必须单调。 */
  ease?: [number, number, number, number]
}

export const IDLE_POSE: RigTransform = { x: 0, y: 0, rotation: 0, scale: 1 }

const clamp = (value: number): number => Math.max(0, Math.min(1, value))
const bezier = (t: number, p1: number, p2: number): number => {
  const inverse = 1 - t
  return 3 * inverse * inverse * t * p1 + 3 * inverse * t * t * p2 + t * t * t
}

export function cubicBezier(progress: number, controls: [number, number, number, number]): number {
  const [x1, y1, x2, y2] = controls
  const target = clamp(progress)
  let lower = 0
  let upper = 1
  for (let step = 0; step < 24; step += 1) {
    const middle = (lower + upper) / 2
    if (bezier(middle, x1, x2) < target) lower = middle
    else upper = middle
  }
  return bezier((lower + upper) / 2, y1, y2)
}

export function interpolateTransform(a: RigTransform, b: RigTransform, t: number): RigTransform {
  const p = clamp(t)
  return {
    x: a.x + (b.x - a.x) * p,
    y: a.y + (b.y - a.y) * p,
    rotation: a.rotation + (b.rotation - a.rotation) * p,
    scale: a.scale + (b.scale - a.scale) * p,
  }
}

export function sampleTimeline(frames: readonly RigKeyframe[], elapsedMs: number): RigTransform {
  if (frames.length === 0) return IDLE_POSE
  if (elapsedMs <= frames[0]!.at) return frames[0]!.pose
  for (let index = 1; index < frames.length; index += 1) {
    const next = frames[index]!
    if (elapsedMs > next.at) continue
    const previous = frames[index - 1]!
    const span = next.at - previous.at
    const raw = span > 0 ? (elapsedMs - previous.at) / span : 1
    return interpolateTransform(
      previous.pose,
      next.pose,
      next.ease ? cubicBezier(raw, next.ease) : raw,
    )
  }
  return frames[frames.length - 1]!.pose
}

/** 有界指数弹簧：逐帧积分时先限制 dt，避免窗口恢复造成爆振。 */
export function springStep(
  current: number,
  velocity: number,
  target: number,
  deltaSeconds: number,
  frequency = 8,
): { value: number; velocity: number } {
  const dt = Math.max(0, Math.min(deltaSeconds, 1 / 30))
  const decay = Math.exp(-frequency * dt)
  const displacement = current - target
  const next = (displacement * (1 + frequency * dt) + velocity * dt) * decay
  const nextVelocity =
    (velocity * (1 - frequency * dt) - displacement * frequency ** 2 * dt) * decay
  return { value: target + next, velocity: nextVelocity }
}

export function isTimelineEnd(frames: readonly RigKeyframe[], elapsedMs: number): boolean {
  return frames.length === 0 || elapsedMs >= frames[frames.length - 1]!.at
}

export function shouldUseRig(
  action: string | null,
  available: boolean,
  staticMode: boolean,
): boolean {
  return action === 'celebrate' && available && !staticMode
}
