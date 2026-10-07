// ============================================================
// Appointment reference codes and phone matching.
//
// The reference is derived from the booking's uuid ("CITA-3F9A2C"), so
// every booking — old ones included — has one without a stored column.
// It is only ever used together with the customer's phone number, which
// scopes the lookup to a handful of bookings, so 6 hex chars are plenty.
// The prefix tells the kind apart (migration 068): CITA- for an agenda
// appointment, RES- for a restaurant table, EVT- for an event. Matching
// ignores the prefix, so a customer who writes the wrong one still finds
// it.
// ============================================================

const REFERENCE_PREFIX: Record<string, string> = {
  appointment: 'CITA-',
  table: 'RES-',
  event: 'EVT-',
}

function referenceCode(bookingId: string): string {
  return bookingId.replace(/-/g, '').slice(0, 6).toUpperCase()
}

/** `3f9a2c1e-…` → `CITA-3F9A2C` (`RES-…` for a table, `EVT-…` for an
 *  event). */
export function bookingReference(bookingId: string, kind?: string | null): string {
  return (REFERENCE_PREFIX[kind ?? 'appointment'] ?? REFERENCE_PREFIX.appointment) + referenceCode(bookingId)
}

/** Normalize what a customer typed ("cita 3f9a2c", "#3F9A2C",
 *  "CITA-3F9A2C", "RES-3F9A2C") down to the 6-char code, or '' when it
 *  can't be one. */
export function normalizeReference(raw: string): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/^\s*#?\s*(CITA|RES|EVT)[\s-]*/, '')
    .replace(/[^0-9A-F]/g, '')
  return cleaned.length === 6 ? cleaned : ''
}

export function referenceMatches(bookingId: string, raw: string): boolean {
  const code = normalizeReference(raw)
  return !!code && referenceCode(bookingId) === code
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
