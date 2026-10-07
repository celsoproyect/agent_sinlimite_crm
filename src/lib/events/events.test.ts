import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EVENT_SETTINGS,
  effectivePolicy,
  initialEventStatus,
  nextEventStatuses,
  normalizeEventSettings,
  quoteEvent,
} from './settings'
import { preferReal } from '@/lib/samples/prefer-real'

const settings = { ...DEFAULT_EVENT_SETTINGS, requires_approval: true, deposit_required: true, deposit_percent: 30 }

describe('effectivePolicy', () => {
  it('uses the business settings when the hall inherits', () => {
    expect(effectivePolicy(settings, { requires_approval: null, deposit_percent: null })).toEqual({
      requiresApproval: true,
      depositRequired: true,
      depositPercent: 30,
    })
  })

  it('lets a hall override approval and the deposit (0 = none)', () => {
    expect(effectivePolicy(settings, { requires_approval: false, deposit_percent: 50 })).toEqual({
      requiresApproval: false,
      depositRequired: true,
      depositPercent: 50,
    })
    expect(effectivePolicy(settings, { requires_approval: null, deposit_percent: 0 }).depositRequired).toBe(false)
  })

  it('has no deposit when the business turned it off', () => {
    expect(effectivePolicy({ ...settings, deposit_required: false }).depositRequired).toBe(false)
  })
})

describe('quoteEvent', () => {
  const policy = effectivePolicy(settings)

  it('prices a package (fixed + per person) with the deposit percentage', () => {
    const q = quoteEvent({ hall: null, pkg: { name: 'Cumpleaños', price: 5000, price_per_person: 750 }, guests: 20, hours: 4, policy })
    expect(q.total).toBe(20000)
    expect(q.deposit).toBe(6000)
  })

  it('prices the hall by the hour with its minimum', () => {
    const q = quoteEvent({ hall: { price_per_hour: 3000, min_hours: 3 }, guests: 30, hours: 2, policy })
    expect(q.total).toBe(9000)
  })

  it('leaves it to the team when there is no price', () => {
    expect(quoteEvent({ hall: { price_per_hour: null, min_hours: 1 }, guests: 10, hours: 3, policy })).toEqual({
      total: null,
      deposit: null,
      breakdown: null,
    })
  })
})

describe('event pipeline', () => {
  it('starts where the business policy says', () => {
    expect(initialEventStatus({ requiresApproval: true, depositRequired: true, depositPercent: 30 })).toBe('requested')
    expect(initialEventStatus({ requiresApproval: false, depositRequired: true, depositPercent: 30 })).toBe('quoted')
    expect(initialEventStatus({ requiresApproval: false, depositRequired: false, depositPercent: 0 })).toBe('confirmed')
  })

  it('moves forward, skipping the deposit step when there is none', () => {
    expect(nextEventStatuses('requested', { depositRequired: true })).toEqual(['quoted', 'deposit_paid', 'confirmed', 'completed', 'cancelled'])
    expect(nextEventStatuses('quoted', { depositRequired: false })).toEqual(['confirmed', 'completed', 'cancelled'])
    expect(nextEventStatuses('completed', { depositRequired: true })).toEqual([])
    expect(nextEventStatuses('cancelled', { depositRequired: true })).toEqual([])
  })
})

describe('normalizeEventSettings', () => {
  it('clamps the percentage and keeps the business choices', () => {
    const s = normalizeEventSettings({ deposit_required: true, deposit_percent: 150, currency: 'usd', requires_approval: false })
    expect(s).toMatchObject({ deposit_required: true, deposit_percent: 100, currency: 'USD', requires_approval: false })
  })

  it('fills the defaults', () => {
    expect(normalizeEventSettings(undefined)).toMatchObject({ requires_approval: true, deposit_required: false, deposit_percent: 30 })
  })
})

describe('preferReal', () => {
  it('keeps the examples only until a real row exists', () => {
    const samples = [{ id: 'a', is_sample: true }]
    expect(preferReal(samples)).toEqual(samples)
    expect(preferReal([...samples, { id: 'b', is_sample: false }]).map((r) => r.id)).toEqual(['b'])
    expect(preferReal([{ id: 'c', is_sample: null }]).map((r) => r.id)).toEqual(['c'])
  })
})
