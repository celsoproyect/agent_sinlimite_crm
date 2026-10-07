import type { WeeklyHours } from './directory'

// Validation for the clinic module's CRUD routes (/api/clinic/*). Pure,
// so the rules are unit-tested without a database.

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export const MAX_NAME_LENGTH = 120
export const MAX_BIO_LENGTH = 1000

/** The columns a professional write may set, plus its specialties. */
export interface ProfessionalInput {
  name?: string
  bio?: string | null
  active?: boolean
  hours?: WeeklyHours | null
  slot_minutes?: number | null
  sort_order?: number
  specialty_ids?: string[]
}

/**
 * Weekly hours as sent by the form: `{ monday: { open, close } | null, … }`.
 * Returns null for "same as the business" (null, or no open day), or an
 * error for a malformed day.
 */
export function parseWeeklyHours(raw: unknown): { hours: WeeklyHours | null } | { error: string } {
  if (raw === null || raw === undefined) return { hours: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid_hours' }
  const hours: WeeklyHours = {}
  let openDays = 0
  for (const day of WEEKDAYS) {
    const value = (raw as Record<string, unknown>)[day]
    if (value === null || value === undefined) {
      hours[day] = null
      continue
    }
    const { open, close } = value as { open?: unknown; close?: unknown }
    if (typeof open !== 'string' || typeof close !== 'string' || !HHMM_RE.test(open) || !HHMM_RE.test(close)) {
      return { error: 'invalid_hours' }
    }
    if (close <= open) return { error: 'invalid_hours' }
    hours[day] = { open, close }
    openDays++
  }
  return { hours: openDays > 0 ? hours : null }
}

/**
 * Validate a professional create (`partial` false: name required) or
 * update (`partial` true: only the fields present).
 */
export function parseProfessionalInput(
  body: unknown,
  partial: boolean,
): { input: ProfessionalInput } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'invalid_body' }
  const b = body as Record<string, unknown>
  const input: ProfessionalInput = {}

  if (b.name !== undefined || !partial) {
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name) return { error: 'name_required' }
    input.name = name.slice(0, MAX_NAME_LENGTH)
  }
  if (b.bio !== undefined) {
    const bio = typeof b.bio === 'string' ? b.bio.trim() : ''
    input.bio = bio ? bio.slice(0, MAX_BIO_LENGTH) : null
  }
  if (b.active !== undefined) {
    if (typeof b.active !== 'boolean') return { error: 'invalid_active' }
    input.active = b.active
  }
  if (b.hours !== undefined) {
    const parsed = parseWeeklyHours(b.hours)
    if ('error' in parsed) return parsed
    input.hours = parsed.hours
  }
  if (b.slot_minutes !== undefined) {
    if (b.slot_minutes === null || b.slot_minutes === '') {
      input.slot_minutes = null
    } else {
      const n = Number(b.slot_minutes)
      if (!Number.isInteger(n) || n < 5 || n > 480) return { error: 'invalid_slot_minutes' }
      input.slot_minutes = n
    }
  }
  if (b.sort_order !== undefined) {
    const n = Number(b.sort_order)
    if (!Number.isInteger(n)) return { error: 'invalid_sort_order' }
    input.sort_order = n
  }
  if (b.specialty_ids !== undefined) {
    if (!Array.isArray(b.specialty_ids) || b.specialty_ids.some((id) => typeof id !== 'string' || !id)) {
      return { error: 'invalid_specialties' }
    }
    input.specialty_ids = [...new Set(b.specialty_ids as string[])]
  }
  return { input }
}

/** Validate a specialty create/update. */
export function parseSpecialtyInput(
  body: unknown,
  partial: boolean,
): { input: { name?: string; description?: string | null } } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'invalid_body' }
  const b = body as Record<string, unknown>
  const input: { name?: string; description?: string | null } = {}
  if (b.name !== undefined || !partial) {
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name) return { error: 'name_required' }
    input.name = name.slice(0, MAX_NAME_LENGTH)
  }
  if (b.description !== undefined) {
    const d = typeof b.description === 'string' ? b.description.trim() : ''
    input.description = d ? d.slice(0, MAX_BIO_LENGTH) : null
  }
  return { input }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** The columns a clinic service write may set. */
export interface ServiceInput {
  name?: string
  description?: string | null
  specialty_id?: string | null
  duration_minutes?: number
  price?: number | null
  active?: boolean
  sort_order?: number
}

/** Validate a clinic service create (name + duration required) or update. */
export function parseServiceInput(body: unknown, partial: boolean): { input: ServiceInput } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'invalid_body' }
  const b = body as Record<string, unknown>
  const input: ServiceInput = {}
  if (b.name !== undefined || !partial) {
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name) return { error: 'name_required' }
    input.name = name.slice(0, MAX_NAME_LENGTH)
  }
  if (b.description !== undefined) {
    const d = typeof b.description === 'string' ? b.description.trim() : ''
    input.description = d ? d.slice(0, MAX_BIO_LENGTH) : null
  }
  if (b.specialty_id !== undefined) {
    if (b.specialty_id === null || b.specialty_id === '') input.specialty_id = null
    else if (typeof b.specialty_id === 'string') input.specialty_id = b.specialty_id
    else return { error: 'invalid_specialty' }
  }
  if (b.duration_minutes !== undefined || !partial) {
    const n = Number(b.duration_minutes)
    if (b.duration_minutes === null || b.duration_minutes === '' || !Number.isInteger(n) || n < 5 || n > 480) {
      return { error: 'invalid_duration' }
    }
    input.duration_minutes = n
  }
  if (b.price !== undefined) {
    if (b.price === null || b.price === '') {
      input.price = null
    } else {
      const n = Number(b.price)
      if (!Number.isFinite(n) || n < 0) return { error: 'invalid_price' }
      input.price = Math.round(n * 100) / 100
    }
  }
  if (b.active !== undefined) {
    if (typeof b.active !== 'boolean') return { error: 'invalid_active' }
    input.active = b.active
  }
  if (b.sort_order !== undefined) {
    const n = Number(b.sort_order)
    if (!Number.isInteger(n)) return { error: 'invalid_sort_order' }
    input.sort_order = n
  }
  return { input }
}

/** Validate a doctor's time off: business-local dates, inclusive. */
export function parseTimeOffInput(
  body: unknown,
): { input: { starts_on: string; ends_on: string; reason: string | null } } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'invalid_body' }
  const b = body as Record<string, unknown>
  const startsOn = typeof b.starts_on === 'string' ? b.starts_on.trim() : ''
  const endsOn = typeof b.ends_on === 'string' && b.ends_on.trim() ? b.ends_on.trim() : startsOn
  if (!DATE_RE.test(startsOn) || !DATE_RE.test(endsOn) || Number.isNaN(Date.parse(`${startsOn}T00:00:00Z`)) || Number.isNaN(Date.parse(`${endsOn}T00:00:00Z`))) {
    return { error: 'invalid_dates' }
  }
  if (endsOn < startsOn) return { error: 'invalid_dates' }
  const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 200) : null
  return { input: { starts_on: startsOn, ends_on: endsOn, reason } }
}

export const MAX_INSURERS = 50

/** Validate `accounts.clinic_settings` as sent by the Seguros tab. */
export function parseClinicSettingsInput(
  body: unknown,
): { input: { ask_insurance: boolean; insurers: string[] } } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'invalid_body' }
  const b = body as Record<string, unknown>
  if (typeof b.ask_insurance !== 'boolean') return { error: 'invalid_ask_insurance' }
  if (!Array.isArray(b.insurers) || b.insurers.some((i) => typeof i !== 'string')) return { error: 'invalid_insurers' }
  const seen = new Set<string>()
  const insurers: string[] = []
  for (const raw of b.insurers as string[]) {
    const name = raw.trim().slice(0, 80)
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    insurers.push(name)
  }
  if (insurers.length > MAX_INSURERS) return { error: 'too_many_insurers' }
  return { input: { ask_insurance: b.ask_insurance, insurers } }
}
