import { describe, expect, it } from 'vitest'
import { mondayOf, weekLabel } from './ranges'

describe('mondayOf', () => {
  it('returns the same day for a Monday', () => {
    expect(mondayOf('2026-10-12')).toBe('2026-10-12')
  })

  it('goes back to Monday from mid-week and Sunday', () => {
    expect(mondayOf('2026-10-14')).toBe('2026-10-12')
    expect(mondayOf('2026-10-18')).toBe('2026-10-12')
  })

  it('crosses month boundaries', () => {
    expect(mondayOf('2026-11-01')).toBe('2026-10-26')
  })
})

describe('weekLabel', () => {
  it('formats the business-local range', () => {
    expect(weekLabel('2026-10-12', '2026-10-18', 'en')).toBe('Oct 12 – Oct 18, 2026')
  })
})
