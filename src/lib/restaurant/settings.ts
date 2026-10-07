import type { BookingSettings, RestaurantSettings } from '@/types'

// ============================================================
// Restaurant module (migration 068): `accounts.restaurant_settings`.
// Every field has a default, so an account that never saved the settings
// still gets 90-minute reservations on a 15-minute grid.
// ============================================================

export const DEFAULT_RESTAURANT_SETTINGS: RestaurantSettings = {
  default_duration_minutes: 90,
  min_duration_minutes: 30,
  max_duration_minutes: 300,
  slot_minutes: 15,
  buffer_minutes: 0,
  max_party_ai: 12,
  allow_combine: true,
  last_seating_minutes: 60,
  allow_preorder: true,
  hours: null,
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

/** Weekly hours with only well-formed open days, or null when none. */
export function normalizeWeeklyHours(raw: unknown): BookingSettings['hours'] | null {
  if (!raw || typeof raw !== 'object') return null
  const src = raw as Record<string, unknown>
  const out: NonNullable<BookingSettings['hours']> = {}
  let open = 0
  for (const day of WEEKDAYS) {
    const h = src[day] as { open?: unknown; close?: unknown } | null | undefined
    if (h && typeof h.open === 'string' && typeof h.close === 'string' && HHMM.test(h.open) && HHMM.test(h.close) && h.close > h.open) {
      out[day] = { open: h.open, close: h.close }
      open++
    } else {
      out[day] = null
    }
  }
  return open > 0 ? out : null
}

/** Fill in and clamp whatever is stored. */
export function normalizeRestaurantSettings(raw: unknown): RestaurantSettings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const d = DEFAULT_RESTAURANT_SETTINGS
  const min = int(src.min_duration_minutes, d.min_duration_minutes, 15, 600)
  const max = Math.max(min, int(src.max_duration_minutes, d.max_duration_minutes, 15, 720))
  return {
    default_duration_minutes: Math.min(max, Math.max(min, int(src.default_duration_minutes, d.default_duration_minutes, 15, 720))),
    min_duration_minutes: min,
    max_duration_minutes: max,
    slot_minutes: int(src.slot_minutes, d.slot_minutes, 5, 120),
    buffer_minutes: int(src.buffer_minutes, d.buffer_minutes, 0, 120),
    max_party_ai: int(src.max_party_ai, d.max_party_ai, 1, 500),
    allow_combine: typeof src.allow_combine === 'boolean' ? src.allow_combine : d.allow_combine,
    last_seating_minutes: int(src.last_seating_minutes, d.last_seating_minutes, 0, 600),
    allow_preorder: typeof src.allow_preorder === 'boolean' ? src.allow_preorder : d.allow_preorder,
    hours: normalizeWeeklyHours(src.hours),
  }
}

/** The reservation length: what the customer asked for, kept within the
 *  restaurant's limits, else the default (90 min unless changed). */
export function reservationMinutes(settings: RestaurantSettings, requested?: number | null): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return settings.default_duration_minutes
  }
  return Math.min(settings.max_duration_minutes, Math.max(settings.min_duration_minutes, Math.round(requested)))
}
