import { describe, expect, it } from 'vitest'
import { bookingReference, normalizeReference, phonesMatch, referenceMatches } from './reference'

const ID = '3f9a2c1e-1111-4000-8000-000000000000'

describe('bookingReference', () => {
  it('derives a short upper-case code from the booking id', () => {
    expect(bookingReference(ID)).toBe('CITA-3F9A2C')
  })

  it('prefixes tables and events by kind (migration 068)', () => {
    expect(bookingReference(ID, 'appointment')).toBe('CITA-3F9A2C')
    expect(bookingReference(ID, 'table')).toBe('RES-3F9A2C')
    expect(bookingReference(ID, 'event')).toBe('EVT-3F9A2C')
    expect(bookingReference(ID, null)).toBe('CITA-3F9A2C')
  })

  it('matches whatever prefix the customer writes', () => {
    for (const raw of ['RES-3F9A2C', 'evt 3f9a2c', 'CITA-3F9A2C']) expect(referenceMatches(ID, raw)).toBe(true)
  })
})

describe('normalizeReference / referenceMatches', () => {
  it('accepts the ways a customer writes it', () => {
    for (const raw of ['CITA-3F9A2C', 'cita 3f9a2c', '#3F9A2C', '3f9a2c']) {
      expect(normalizeReference(raw)).toBe('3F9A2C')
      expect(referenceMatches(ID, raw)).toBe(true)
    }
  })

  it('rejects anything else', () => {
    expect(normalizeReference('CITA-3F9A')).toBe('')
    expect(referenceMatches(ID, 'CITA-000000')).toBe(false)
  })
})

describe('phonesMatch', () => {
  it('ignores formatting and the country code', () => {
    expect(phonesMatch('+1 (809) 555-1234', '8095551234')).toBe(true)
    expect(phonesMatch('18095551234', '809-555-1234')).toBe(true)
  })

  it('needs a real number on both sides', () => {
    expect(phonesMatch('', '8095551234')).toBe(false)
    expect(phonesMatch('8095551234', '8295551234')).toBe(false)
    expect(phonesMatch('123', '123')).toBe(false)
  })
})
