import { useEffect, useRef } from 'react'

import { isTimelineEnd, sampleTimeline, springStep } from './rig'
import type { RigKeyframe, RigTransform } from './rig'

export interface RigLayer {
  id: string
  src: string
  pivot: [number, number]
  z: number
  initial: RigTransform
  frames: readonly RigKeyframe[]
  secondary?: boolean
}

interface PetRigProps {
  layers: readonly RigLayer[]
  staticMode: boolean
  onFinish?: () => void
}

/** 视觉层内部运行；不修改按钮尺寸，也不经 React state 更新逐帧姿态。 */
export default function PetRig({ layers, staticMode, onFinish }: PetRigProps) {
  const imageRefs = useRef(new Map<string, HTMLImageElement>())
  const onFinishRef = useRef(onFinish)
  onFinishRef.current = onFinish

  useEffect(() => {
    if (staticMode || layers.length === 0) return
    let frame = 0
    let started = -1
    let previous = -1
    const springs = new Map<string, { value: number; velocity: number }>()
    const duration = Math.max(...layers.map((layer) => layer.frames.at(-1)?.at ?? 0))
    const tick = (now: number): void => {
      if (started < 0) started = now
      const elapsed = Math.min(now - started, duration)
      const dt = previous < 0 ? 0 : (now - previous) / 1000
      previous = now
      for (const layer of layers) {
        const element = imageRefs.current.get(layer.id)
        if (!element) continue
        const pose = sampleTimeline(layer.frames, elapsed)
        const prior = springs.get(layer.id) ?? { value: 0, velocity: 0 }
        const secondary = layer.secondary
          ? springStep(prior.value, prior.velocity, pose.rotation, dt, 9)
          : { value: pose.rotation, velocity: 0 }
        springs.set(layer.id, secondary)
        element.style.transform = `translate3d(${pose.x + layer.initial.x}px, ${pose.y + layer.initial.y}px, 0) rotate(${secondary.value + layer.initial.rotation}deg) scale(${pose.scale * layer.initial.scale})`
      }
      if (elapsed >= duration && layers.every((layer) => isTimelineEnd(layer.frames, elapsed))) {
        onFinishRef.current?.()
      } else {
        frame = requestAnimationFrame(tick)
      }
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [layers, staticMode])

  return (
    <span className="pet-rig" aria-hidden="true">
      {layers.map((layer) => (
        <img
          key={layer.id}
          ref={(element) => {
            if (element) imageRefs.current.set(layer.id, element)
            else imageRefs.current.delete(layer.id)
          }}
          src={layer.src}
          alt=""
          draggable={false}
          className="pet-rig__layer"
          style={{
            zIndex: layer.z,
            transformOrigin: `${layer.pivot[0]}px ${layer.pivot[1]}px`,
            transform: `translate3d(${layer.initial.x}px, ${layer.initial.y}px, 0) rotate(${layer.initial.rotation}deg) scale(${layer.initial.scale})`,
          }}
        />
      ))}
    </span>
  )
}
