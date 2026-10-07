import { describe, expect, it } from 'vitest'
import {
  MAX_INSURERS,
  parseClinicSettingsInput,
  parseProfessionalInput,
  parseServiceInput,
  parseSpecialtyInput,
  parseTimeOffInput,
  parseWeeklyHours,
} from './input'

describe('parseWeeklyHours', () => {
  it('keeps open days and nulls the rest', () => {
    expect(parseWeeklyHours({ monday: { open: '08:00', close: '12:00' } })).toEqual({
      hours: {
        monday: { open: '08:00', close: '12:00' },
        tuesday: null,
        wednesday: null,
        thursday: null,
        friday: null,
        saturday: null,
        sunday: null,
      },
    })
  })

  it('treats no open day as business hours', () => {
    expect(parseWeeklyHours(null)).toEqual({ hours: null })
    expect(parseWeeklyHours({ monday: null })).toEqual({ hours: null })
  })

  it('rejects malformed or inverted times', () => {
    expect(parseWeeklyHours({ monday: { open: '8:00', close: '12:00' } })).toEqual({ error: 'invalid_hours' })
    expect(parseWeeklyHours({ monday: { open: '12:00', close: '08:00' } })).toEqual({ error: 'invalid_hours' })
    expect(parseWeeklyHours([])).toEqual({ error: 'invalid_hours' })
  })
})

describe('parseProfessionalInput', () => {
  it('requires a name on create but not on a partial update', () => {
    expect(parseProfessionalInput({ name: '  ' }, false)).toEqual({ error: 'name_required' })
    expect(parseProfessionalInput({ active: false }, true)).toEqual({ input: { active: false } })
  })

  it('normalizes the fields', () => {
    expect(
      parseProfessionalInput(
        { name: ' Dra. Ana ', bio: '', slot_minutes: '30', specialty_ids: ['a', 'b', 'a'] },
        false,
      ),
    ).toEqual({ input: { name: 'Dra. Ana', bio: null, slot_minutes: 30, specialty_ids: ['a', 'b'] } })
    expect(parseProfessionalInput({ slot_minutes: '' }, true)).toEqual({ input: { slot_minutes: null } })
  })

  it('rejects bad values', () => {
    expect(parseProfessionalInput({ slot_minutes: 3 }, true)).toEqual({ error: 'invalid_slot_minutes' })
    expect(parseProfessionalInput({ slot_minutes: 12.5 }, true)).toEqual({ error: 'invalid_slot_minutes' })
    expect(parseProfessionalInput({ specialty_ids: [1] }, true)).toEqual({ error: 'invalid_specialties' })
    expect(parseProfessionalInput({ active: 'yes' }, true)).toEqual({ error: 'invalid_active' })
    expect(parseProfessionalInput(null, true)).toEqual({ error: 'invalid_body' })
  })
})

describe('parseSpecialtyInput', () => {
  it('requires a name on create', () => {
    expect(parseSpecialtyInput({}, false)).toEqual({ error: 'name_required' })
    expect(parseSpecialtyInput({ name: ' Pediatría ', description: ' ' }, false)).toEqual({
      input: { name: 'Pediatría', description: null },
    })
  })
})

describe('parseServiceInput', () => {
  it('requires a name and a length on create', () => {
    expect(parseServiceInput({ duration_minutes: 30 }, false)).toEqual({ error: 'name_required' })
    expect(parseServiceInput({ name: 'Consulta' }, false)).toEqual({ error: 'invalid_duration' })
    expect(parseServiceInput({ name: ' Consulta ', duration_minutes: '30', price: '1500.555', specialty_id: '' }, false)).toEqual({
      input: { name: 'Consulta', duration_minutes: 30, price: 1500.56, specialty_id: null },
    })
  })

  it('rejects bad lengths and prices', () => {
    expect(parseServiceInput({ duration_minutes: 4 }, true)).toEqual({ error: 'invalid_duration' })
    expect(parseServiceInput({ duration_minutes: 481 }, true)).toEqual({ error: 'invalid_duration' })
    expect(parseServiceInput({ duration_minutes: 12.5 }, true)).toEqual({ error: 'invalid_duration' })
    expect(parseServiceInput({ price: -1 }, true)).toEqual({ error: 'invalid_price' })
    expect(parseServiceInput({ price: 'abc' }, true)).toEqual({ error: 'invalid_price' })
    expect(parseServiceInput({ active: 'yes' }, true)).toEqual({ error: 'invalid_active' })
    expect(parseServiceInput({ specialty_id: 3 }, true)).toEqual({ error: 'invalid_specialty' })
  })

  it('only sets what an update sends', () => {
    expect(parseServiceInput({ active: false, price: null }, true)).toEqual({ input: { active: false, price: null } })
  })
})

describe('parseTimeOffInput', () => {
  it('defaults the end to the start', () => {
    expect(parseTimeOffInput({ starts_on: '2026-10-12' })).toEqual({
      input: { starts_on: '2026-10-12', ends_on: '2026-10-12', reason: null },
    })
  })

  it('keeps a range and its reason', () => {
    expect(parseTimeOffInput({ starts_on: '2026-10-12', ends_on: '2026-10-16', reason: ' Congreso ' })).toEqual({
      input: { starts_on: '2026-10-12', ends_on: '2026-10-16', reason: 'Congreso' },
    })
  })

  it('rejects bad or inverted dates', () => {
    expect(parseTimeOffInput({ starts_on: '12/10/2026' })).toEqual({ error: 'invalid_dates' })
    expect(parseTimeOffInput({ starts_on: '2026-10-16', ends_on: '2026-10-12' })).toEqual({ error: 'invalid_dates' })
    expect(parseTimeOffInput(null)).toEqual({ error: 'invalid_body' })
  })
})

describe('parseClinicSettingsInput', () => {
  it('trims and dedupes the insurers', () => {
    expect(parseClinicSettingsInput({ ask_insurance: true, insurers: [' Humano ', 'humano', '', 'Senasa'] })).toEqual({
      input: { ask_insurance: true, insurers: ['Humano', 'Senasa'] },
    })
  })

  it('rejects bad shapes and too many insurers', () => {
    expect(parseClinicSettingsInput({ insurers: [] })).toEqual({ error: 'invalid_ask_insurance' })
    expect(parseClinicSettingsInput({ ask_insurance: false, insurers: [1] })).toEqual({ error: 'invalid_insurers' })
    const many = Array.from({ length: MAX_INSURERS + 1 }, (_, i) => `ARS ${i}`)
    expect(parseClinicSettingsInput({ ask_insurance: false, insurers: many })).toEqual({ error: 'too_many_insurers' })
  })
})
