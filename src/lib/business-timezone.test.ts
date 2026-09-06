import { describe, it, expect, afterEach } from 'vitest'
import {
  BUSINESS_TIME_ZONE,
  applyBusinessTimeZone,
  businessDate,
  businessLocalToInstant,
  businessTime,
  businessWeekday,
  normalizeAiTimestamp,
} from './business-timezone'

describe('businessLocalToInstant', () => {
  it('reads a business-local wall clock as UTC-4, independent of the host zone', () => {
    expect(businessLocalToInstant('2026-09-07', '09:00').toISOString()).toBe(
      '2026-09-07T13:00:00.000Z',
    )
  })

  it('accepts an HH:mm:ss time too', () => {
    expect(businessLocalToInstant('2026-09-07', '17:30:00').toISOString()).toBe(
      '2026-09-07T21:30:00.000Z',
    )
  })

  it('returns an Invalid Date for malformed input', () => {
    expect(Number.isNaN(businessLocalToInstant('not-a-date', '09:00').getTime())).toBe(true)
  })
})

describe('businessWeekday', () => {
  it('reports the business-local weekday, not the UTC-midnight one', () => {
    // 2026-09-07 is a Monday. Parsing it as UTC midnight and reading a
    // local getter west of Greenwich would report Sunday.
    expect(businessWeekday('2026-09-07')).toBe(1)
    expect(businessWeekday('2026-09-06')).toBe(0)
  })
})

describe('businessDate / businessTime', () => {
  it('converts a UTC instant into the business calendar day and wall clock', () => {
    expect(businessDate('2026-09-07T13:00:00.000Z')).toBe('2026-09-07')
    expect(businessTime('2026-09-07T13:00:00.000Z')).toBe('09:00')
  })

  it('rolls back to the previous business day for an instant in the UTC/AST gap', () => {
    // 01:30 UTC is still 21:30 the evening before in Santo Domingo.
    expect(businessDate('2026-09-08T01:30:00.000Z')).toBe('2026-09-07')
    expect(businessTime('2026-09-08T01:30:00.000Z')).toBe('21:30')
  })
})

describe('normalizeAiTimestamp', () => {
  it('passes a zoned timestamp through unchanged', () => {
    expect(normalizeAiTimestamp('2026-09-07T13:00:00.000Z')).toBe('2026-09-07T13:00:00.000Z')
    expect(normalizeAiTimestamp('2026-09-07T09:00:00-04:00')).toBe('2026-09-07T13:00:00.000Z')
  })

  it('treats a bare timestamp as business-local, not host-local', () => {
    expect(normalizeAiTimestamp('2026-09-07T09:00:00')).toBe('2026-09-07T13:00:00.000Z')
    expect(normalizeAiTimestamp('2026-09-07T09:00')).toBe('2026-09-07T13:00:00.000Z')
  })

  it('rejects anything that is not a usable timestamp', () => {
    expect(normalizeAiTimestamp('')).toBeNull()
    expect(normalizeAiTimestamp('tomorrow at nine')).toBeNull()
    expect(normalizeAiTimestamp('2026-09-07')).toBeNull()
  })
})

describe('applyBusinessTimeZone', () => {
  const original = process.env.TZ

  afterEach(() => {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  })

  it('pins an unset process clock to the business zone', () => {
    delete process.env.TZ
    applyBusinessTimeZone()
    expect(process.env.TZ).toBe(BUSINESS_TIME_ZONE)
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(BUSINESS_TIME_ZONE)
  })

  it('leaves an explicitly configured zone alone', () => {
    process.env.TZ = 'Asia/Tokyo'
    applyBusinessTimeZone()
    expect(process.env.TZ).toBe('Asia/Tokyo')
  })

  it('is safe to call twice', () => {
    delete process.env.TZ
    applyBusinessTimeZone()
    applyBusinessTimeZone()
    expect(process.env.TZ).toBe(BUSINESS_TIME_ZONE)
  })
})
