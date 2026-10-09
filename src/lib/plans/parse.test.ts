import { describe, it, expect } from 'vitest'

import { endOfBusinessDay, nextBusinessMonthStart, parseExtraInput, parseLimit, parsePlanInput } from './parse'

const NOW = new Date('2026-10-09T15:00:00Z')

describe('parseLimit', () => {
  it('treats blank as unlimited', () => {
    expect(parseLimit('')).toEqual({ ok: true, value: null })
    expect(parseLimit(null)).toEqual({ ok: true, value: null })
  })
  it('accepts whole numbers and refuses the rest', () => {
    expect(parseLimit('25')).toEqual({ ok: true, value: 25 })
    expect(parseLimit(0)).toEqual({ ok: true, value: 0 })
    expect(parseLimit('2.5').ok).toBe(false)
    expect(parseLimit(-1).ok).toBe(false)
    expect(parseLimit('abc').ok).toBe(false)
  })
})

describe('parsePlanInput', () => {
  it('needs a name', () => {
    expect(parsePlanInput({ name: '  ' }).ok).toBe(false)
  })

  it('normalizes a full plan', () => {
    const r = parsePlanInput({
      name: ' Pro ',
      price: '29.999',
      currency: 'dop',
      billing_interval: 'year',
      ai_replies_month: '1000',
      max_users: '',
      modules: { reports: false, nonsense: true },
      is_active: false,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.name).toBe('Pro')
    expect(r.value.price).toBe(30)
    expect(r.value.currency).toBe('DOP')
    expect(r.value.billing_interval).toBe('year')
    expect(r.value.ai_replies_month).toBe(1000)
    expect(r.value.max_users).toBeNull()
    expect(r.value.modules).toEqual({ reports: false })
    expect(r.value.is_active).toBe(false)
  })

  it('refuses a bad limit or price', () => {
    expect(parsePlanInput({ name: 'X', max_users: '-3' }).ok).toBe(false)
    expect(parsePlanInput({ name: 'X', price: -1 }).ok).toBe(false)
  })
})

describe('business dates', () => {
  it('ends a business day at the next Santo Domingo midnight', () => {
    expect(endOfBusinessDay('2026-10-31').toISOString()).toBe('2026-11-01T04:00:00.000Z')
  })
  it('finds the next business month start', () => {
    expect(nextBusinessMonthStart(NOW).toISOString()).toBe('2026-11-01T04:00:00.000Z')
    expect(nextBusinessMonthStart(new Date('2026-12-15T12:00:00Z')).toISOString()).toBe(
      '2027-01-01T04:00:00.000Z',
    )
  })
})

describe('parseExtraInput', () => {
  it('adds a permanent resource', () => {
    const r = parseExtraInput({ resource: 'users', quantity: 2, duration: 'permanent', note: ' pagó ' }, NOW)
    expect(r).toEqual({
      ok: true,
      value: { resource: 'users', quantity: 2, module_key: null, expires_at: null, note: 'pagó' },
    })
  })

  it('ends a this-month extra at the next month start', () => {
    const r = parseExtraInput({ resource: 'ai_replies', quantity: 500, duration: 'month' }, NOW)
    expect(r.ok && r.value.expires_at).toBe('2026-11-01T04:00:00.000Z')
  })

  it('needs an until date from today on', () => {
    expect(parseExtraInput({ resource: 'contacts', quantity: 1, duration: 'until', until: '2026-10-08' }, NOW).ok).toBe(false)
    const r = parseExtraInput({ resource: 'contacts', quantity: 1, duration: 'until', until: '2026-10-09' }, NOW)
    expect(r.ok && r.value.expires_at).toBe('2026-10-10T04:00:00.000Z')
  })

  it('takes a module instead of a quantity', () => {
    const r = parseExtraInput({ resource: 'module', module_key: 'reports', duration: 'permanent' }, NOW)
    expect(r.ok && r.value.module_key).toBe('reports')
    expect(parseExtraInput({ resource: 'module', module_key: 'nope', duration: 'permanent' }, NOW).ok).toBe(false)
  })

  it('refuses bad quantities, resources and durations', () => {
    expect(parseExtraInput({ resource: 'users', quantity: 0, duration: 'permanent' }, NOW).ok).toBe(false)
    expect(parseExtraInput({ resource: 'gold', quantity: 1, duration: 'permanent' }, NOW).ok).toBe(false)
    expect(parseExtraInput({ resource: 'users', quantity: 1, duration: 'forever' }, NOW).ok).toBe(false)
  })
})
