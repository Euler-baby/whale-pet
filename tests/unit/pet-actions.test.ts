import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  ACTION_DURATION_MS,
  hasNewUrgent,
  selectAction,
  spriteFadeMs,
} from '../../src/renderer/src/pet/actions'
import type { UrgentTasksState } from '../../src/shared/types'

const empty: UrgentTasksState = { tasks: [], total: 0, queued: 0 }
const urgent: UrgentTasksState = {
  tasks: [
    {
      id: 'u1',
      title: '紧急',
      dueAt: null,
      importance: 'urgent',
      category: 'study',
      projectName: null,
    },
  ],
  total: 1,
  queued: 0,
}

describe('pet action selection', () => {
  it('higher priority interrupts while equal and lower priority do not stack', () => {
    expect(selectAction(null, 'idle-look')).toBe('idle-look')
    expect(selectAction('idle-look', 'celebrate')).toBe('celebrate')
    expect(selectAction('celebrate', 'pat')).toBe('pat')
    expect(selectAction('pat', 'concern')).toBe('concern')
    expect(selectAction('concern', 'pat')).toBe('concern')
    expect(selectAction('pat', 'pat')).toBe('pat')
  })

  it('each action has a bounded duration', () => {
    expect(ACTION_DURATION_MS).toEqual({
      pat: 890,
      celebrate: 920,
      concern: 940,
      'idle-look': 1405,
    })
  })

  it('ships eight frames per action and returns during the exact idle final frame', () => {
    const root = resolve('assets/sprites/whale-girl-actions-v1')
    const idle = readFileSync(resolve('assets/sprites/whale-girl-v1/idle.png'))
    const report = JSON.parse(readFileSync(resolve(root, 'animation.json'), 'utf8')) as {
      actions: Record<string, { frameCount: number; totalMs: number; firstLastExact: boolean }>
    }
    for (const [action, duration] of Object.entries(ACTION_DURATION_MS)) {
      expect(report.actions[action]?.frameCount).toBe(8)
      expect(report.actions[action]?.firstLastExact).toBe(true)
      expect(report.actions[action]?.totalMs).toBe(duration + 50)
      expect(readFileSync(resolve(root, 'frames', action, '0.png')).equals(idle)).toBe(true)
      expect(readFileSync(resolve(root, 'frames', action, '7.png')).equals(idle)).toBe(true)
    }
  })

  it('skips idle action fades but briefly fades mismatched or interrupted sources', () => {
    expect(spriteFadeMs(null, 'pat', 'idle', 'idle', false)).toBe(0)
    expect(spriteFadeMs('pat', null, 'idle', 'idle', false)).toBe(0)
    expect(spriteFadeMs(null, 'pat', 'sleepy', 'sleepy', false)).toBe(90)
    expect(spriteFadeMs('pat', null, 'sleepy', 'sleepy', false)).toBe(90)
    expect(spriteFadeMs(null, 'celebrate', 'happy', 'happy', false)).toBe(90)
    expect(spriteFadeMs('idle-look', 'pat', 'idle', 'idle', false)).toBe(90)
    expect(spriteFadeMs(null, null, 'happy', 'idle', false)).toBe(90)
    expect(spriteFadeMs(null, 'pat', 'sleepy', 'sleepy', true)).toBe(0)
  })

  it('responds to new urgent tasks, not queue counts or repeat refreshes', () => {
    expect(hasNewUrgent(empty, urgent)).toBe(true)
    expect(hasNewUrgent(urgent, { ...urgent, queued: 1 })).toBe(false)
    expect(hasNewUrgent(urgent, urgent)).toBe(false)
  })
})
