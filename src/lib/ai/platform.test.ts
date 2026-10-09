import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: vi.fn() }))

import { businessMonthStart } from './platform'

describe('businessMonthStart', () => {
  it('is midnight of the 1st in Santo Domingo (UTC-4)', () => {
    expect(businessMonthStart(new Date('2026-10-15T12:00:00Z')).toISOString()).toBe(
      '2026-10-01T04:00:00.000Z',
    )
  })

  it('uses the business month, not UTC, right after midnight UTC', () => {
    // 02:00 UTC on Nov 1 is still Oct 31 in Santo Domingo.
    expect(businessMonthStart(new Date('2026-11-01T02:00:00Z')).toISOString()).toBe(
      '2026-10-01T04:00:00.000Z',
    )
  })
})
