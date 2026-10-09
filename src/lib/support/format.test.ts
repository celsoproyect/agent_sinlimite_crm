import { describe, it, expect } from 'vitest'

import { formatDuration } from './format'

describe('formatDuration', () => {
  it('shows minutes under an hour', () => {
    expect(formatDuration('2026-10-09T10:00:00Z', '2026-10-09T10:45:20Z')).toBe('45 min')
  })
  it('shows hours and padded minutes', () => {
    expect(formatDuration('2026-10-09T10:00:00Z', '2026-10-09T12:05:00Z')).toBe('2 h 05 min')
  })
  it('never goes negative', () => {
    expect(formatDuration('2026-10-09T10:00:00Z', '2026-10-09T09:00:00Z')).toBe('0 min')
  })
})
