import { describe, expect, it } from 'vitest'

import {
  cubicBezier,
  IDLE_POSE,
  interpolateTransform,
  isTimelineEnd,
  sampleTimeline,
  shouldUseRig,
  springStep,
} from '../../src/renderer/src/pet/rig'

const frames = [
  { at: 0, pose: IDLE_POSE },
  { at: 500, pose: { x: 20, y: -40, rotation: 30, scale: 1.1 } },
  { at: 1000, pose: IDLE_POSE },
]

describe('rig timeline', () => {
  it('interpolates every transform and clamps endpoints', () => {
    expect(interpolateTransform(IDLE_POSE, frames[1]!.pose, 0.5)).toEqual({
      x: 10,
      y: -20,
      rotation: 15,
      scale: 1.05,
    })
    expect(sampleTimeline(frames, -10)).toEqual(IDLE_POSE)
    expect(sampleTimeline(frames, 250).y).toBe(-20)
    expect(sampleTimeline(frames, 1001)).toEqual(IDLE_POSE)
    expect(isTimelineEnd(frames, 999)).toBe(false)
    expect(isTimelineEnd(frames, 1000)).toBe(true)
  })

  it('solves cubic Bezier using x as time', () => {
    expect(cubicBezier(0, [0.2, 0, 0.8, 1])).toBeCloseTo(0, 5)
    expect(cubicBezier(1, [0.2, 0, 0.8, 1])).toBeCloseTo(1, 5)
    expect(cubicBezier(0.25, [0.1, 0, 0.9, 0.2])).toBeLessThan(0.25)
  })

  it('spring remains finite and converges after a delayed target', () => {
    let current = { value: 0, velocity: 0 }
    for (let index = 0; index < 180; index += 1) {
      current = springStep(current.value, current.velocity, index < 15 ? 0 : 20, 1 / 60)
      expect(Number.isFinite(current.value)).toBe(true)
    }
    expect(current.value).toBeCloseTo(20, 3)
  })

  it('keeps the eight-frame path until complete art is available', () => {
    expect(shouldUseRig('celebrate', false, false)).toBe(false)
    expect(shouldUseRig('pat', true, false)).toBe(false)
    expect(shouldUseRig('celebrate', true, true)).toBe(false)
    expect(shouldUseRig('celebrate', true, false)).toBe(true)
  })
})
