import { describe, expect, it } from 'vitest'

import { isSyntheticPhone, mintSyntheticPhone } from './synthetic-phone'

describe('mintSyntheticPhone', () => {
  it('mints an 18-digit synthetic phone starting with the reserved 000 prefix', () => {
    const phone = mintSyntheticPhone()
    expect(phone).toMatch(/^000\d{18}$/)
  })

  it('mints distinct values across calls', () => {
    const values = new Set(Array.from({ length: 20 }, () => mintSyntheticPhone()))
    expect(values.size).toBe(20)
  })

  it('round-trips through isSyntheticPhone', () => {
    expect(isSyntheticPhone(mintSyntheticPhone())).toBe(true)
  })
})

describe('isSyntheticPhone', () => {
  it('accepts the reserved prefix with 16-20 trailing digits', () => {
    expect(isSyntheticPhone(`000${'1'.repeat(16)}`)).toBe(true)
    expect(isSyntheticPhone(`000${'1'.repeat(20)}`)).toBe(true)
  })

  it('rejects trailing-digit counts outside the 16-20 range', () => {
    expect(isSyntheticPhone(`000${'1'.repeat(15)}`)).toBe(false)
    expect(isSyntheticPhone(`000${'1'.repeat(21)}`)).toBe(false)
  })

  it('rejects a real E.164 WhatsApp number', () => {
    expect(isSyntheticPhone('+15551234567')).toBe(false)
  })

  it('rejects a non-string value', () => {
    expect(isSyntheticPhone(12345)).toBe(false)
    expect(isSyntheticPhone(undefined)).toBe(false)
    expect(isSyntheticPhone(null)).toBe(false)
  })

  it('rejects a string that only partially matches the reserved prefix', () => {
    expect(isSyntheticPhone('00112345678901234')).toBe(false)
  })
})
