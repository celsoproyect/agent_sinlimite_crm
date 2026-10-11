import { describe, it, expect } from 'vitest'
import {
  normalizeAssignmentSettings,
  pickAssignee,
  rotationOrder,
  type AssignCandidate,
} from './settings'

const c = (user_id: string, last: string | null = null, open_chats = 0): AssignCandidate => ({
  user_id,
  last_assigned_at: last,
  open_chats,
})

describe('normalizeAssignmentSettings', () => {
  it('fills defaults and clamps minutes', () => {
    expect(normalizeAssignmentSettings(null)).toEqual({
      mode: 'off',
      members: [],
      reassign_minutes: 10,
      assign_when_ai_off: false,
    })
    const s = normalizeAssignmentSettings({ mode: 'sequence', members: ['a', 'a', 3, 'b'], reassign_minutes: 0.2 })
    expect(s.mode).toBe('sequence')
    expect(s.members).toEqual(['a', 'b'])
    expect(s.reassign_minutes).toBe(1)
    expect(normalizeAssignmentSettings({ reassign_minutes: null }).reassign_minutes).toBeNull()
    expect(normalizeAssignmentSettings({ mode: 'nope' }).mode).toBe('off')
  })
})

describe('pickAssignee', () => {
  it('round robin goes to whoever waited longest, never-assigned first', () => {
    const team = [c('ana', '2026-10-11T10:00:00Z'), c('luis', null), c('eva', '2026-10-11T09:00:00Z')]
    expect(pickAssignee('round_robin', team)).toBe('luis')
    expect(pickAssignee('round_robin', [team[0], team[2]])).toBe('eva')
  })

  it('sequence starts at the top and continues after the current one', () => {
    const team = [c('ana'), c('luis'), c('eva')]
    expect(pickAssignee('sequence', team)).toBe('ana')
    expect(pickAssignee('sequence', team, 'luis')).toBe('eva')
    expect(pickAssignee('sequence', team, 'eva')).toBe('ana')
  })

  it('least busy picks the fewest open chats, ties by turn', () => {
    const team = [c('ana', null, 4), c('luis', '2026-10-11T10:00:00Z', 1), c('eva', '2026-10-11T08:00:00Z', 1)]
    expect(pickAssignee('least_busy', team)).toBe('eva')
  })

  it('skips the current assignee and returns null with nobody else', () => {
    expect(pickAssignee('round_robin', [c('ana')], 'ana')).toBeNull()
    expect(pickAssignee('off', [c('ana')])).toBeNull()
  })
})

describe('rotationOrder', () => {
  it('follows the owner order and drops missing people', () => {
    const team = [{ user_id: 'a' }, { user_id: 'b' }, { user_id: 'c' }]
    expect(rotationOrder(team, ['c', 'x', 'a']).map((m) => m.user_id)).toEqual(['c', 'a'])
    expect(rotationOrder(team, [])).toBe(team)
  })
})
