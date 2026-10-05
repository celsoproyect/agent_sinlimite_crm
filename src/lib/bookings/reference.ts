// ============================================================
// Appointment reference codes and phone matching.
//
// The reference is derived from the booking's uuid ("CITA-3F9A2C"), so
// every booking — old ones included — has one without a stored column.
// It is only ever used together with the customer's phone number, which
// scopes the lookup to a handful of bookings, so 6 hex chars are plenty.
// ============================================================

const REFERENCE_PREFIX = 'CITA-'

/** `3f9a2c1e-…` → `CITA-3F9A2C`. */
export function bookingReference(bookingId: string): string {
  return REFERENCE_PREFIX + bookingId.replace(/-/g, '').slice(0, 6).toUpperCase()
}

/** Normalize what a customer typed ("cita 3f9a2c", "#3F9A2C",
 *  "CITA-3F9A2C") down to the 6-char code, or '' when it can't be one. */
export function normalizeReference(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/^\s*#?\s*CITA[\s-]*/, '').replace(/[^0-9A-F]/g, '')
  return cleaned.length === 6 ? cleaned : ''
}

export function referenceMatches(bookingId: string, raw: string): boolean {
  const code = normalizeReference(raw)
  return !!code && bookingReference(bookingId) === REFERENCE_PREFIX + code
}

/** Digits only. */
export function phoneDigits(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '')
}

/**
 * Same phone, tolerant of how it was written: "+1 (809) 555-1234",
 * "8095551234" and "18095551234" all match. Compares the last 10 digits
 * (a Dominican number without the country code), or the whole number
 * when either side is shorter. Needs at least 7 digits on both sides.
 */
export function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = phoneDigits(a)
  const db = phoneDigits(b)
  if (da.length < 7 || db.length < 7) return false
  const n = Math.min(10, da.length, db.length)
  return da.slice(-n) === db.slice(-n)
}
