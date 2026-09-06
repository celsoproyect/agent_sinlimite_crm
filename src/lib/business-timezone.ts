// ============================================================
// The one place the business's timezone is defined.
//
// This app runs for a single business that always operates in
// America/Santo_Domingo (UTC-4, permanently — the Dominican Republic
// has observed no DST since 1974). Customers, business hours, holidays
// and appointments are all expressed in that zone, never in the
// server's zone and never in the browser's.
//
// Everything scheduling-related used to lean on the container's `TZ`
// (docker-compose sets it to America/Santo_Domingo) and on naive
// `new Date('2026-09-07T09:00:00')` parsing, which silently produced
// times four hours off whenever the process ran anywhere else — a
// local `npm run dev`, a CI box, or any host that didn't inherit the
// compose env. The helpers here make the conversion explicit so the
// result no longer depends on where the code happens to run.
// ============================================================

export const BUSINESS_TIME_ZONE = 'America/Santo_Domingo'

/** Fixed UTC offset for {@link BUSINESS_TIME_ZONE}. Safe to hardcode
 *  precisely because the zone has no DST — if this app is ever pointed
 *  at a zone that does, this constant must become a lookup. */
export const BUSINESS_UTC_OFFSET = '-04:00'

const DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** Today's calendar date in the business's zone, as `YYYY-MM-DD`. */
export function businessToday(now: Date = new Date()): string {
  return DATE_FORMATTER.format(now)
}

/** `2026-09-07T13:00:00.000Z` -> `2026-09-07` (business zone). */
export function businessDate(instant: Date | string): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant
  return DATE_FORMATTER.format(d)
}

/** `2026-09-07T13:00:00.000Z` -> `09:00` (business zone). */
export function businessTime(instant: Date | string): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant
  return TIME_FORMATTER.format(d)
}

/**
 * Turn a business-local calendar date + wall-clock time into the real
 * UTC instant it denotes — e.g. `('2026-09-07', '09:00')` is
 * `2026-09-07T13:00:00.000Z`. Returns an Invalid Date for malformed
 * input, so callers can guard with `Number.isNaN(d.getTime())`.
 */
export function businessLocalToInstant(dateISO: string, hhmm: string): Date {
  const time = /^\d{2}:\d{2}$/.test(hhmm) ? `${hhmm}:00` : hhmm
  return new Date(`${dateISO}T${time}${BUSINESS_UTC_OFFSET}`)
}

/**
 * Day of week (0 = Sunday) for a `YYYY-MM-DD` business-local date,
 * computed without touching the host timezone — `new Date(dateISO)`
 * parses as UTC midnight, which is the previous day for anyone west of
 * Greenwich, so this anchors at noon instead.
 */
export function businessWeekday(dateISO: string): number {
  return new Date(`${dateISO}T12:00:00Z`).getUTCDay()
}

/**
 * Normalize a timestamp the AI produced into a true UTC instant.
 *
 * The model echoes the ISO strings `check_availability` handed it
 * (already UTC, with a `Z`), but on a later turn it may reconstruct one
 * from the wall-clock time it quoted the customer and emit it bare
 * (`2026-09-07T09:00:00`). A bare timestamp means business-local time —
 * that's the only clock the model was ever shown — so stamp the
 * business offset onto it rather than letting `new Date` guess from the
 * host's zone. Returns null when the value isn't a usable timestamp.
 */
export function normalizeAiTimestamp(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Already carries an explicit zone (`...Z` or `...±HH:MM`/`±HHMM`)?
  // Then it's unambiguous — parse as-is.
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)
  const stamped = hasZone ? trimmed : `${trimmed}${BUSINESS_UTC_OFFSET}`
  const parsed = new Date(stamped)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString()
}

/**
 * Pin the *process* clock to the business zone.
 *
 * The helpers above already make every scheduling calculation
 * zone-explicit, so nothing in the booking path depends on this. It
 * exists for the code that still formats dates the ordinary way —
 * server-rendered dashboard timestamps, `toLocaleString()` in emails and
 * exports, log lines — which reads whatever zone the process booted in.
 * Production gets `TZ=America/Santo_Domingo` from the Docker image, but a
 * local `npm run dev` inherits the developer's OS zone, so the dashboard
 * showed one clock and the agent quoted another.
 *
 * Node re-reads `process.env.TZ` on assignment (it resets the internal
 * date cache), so setting it here at startup is enough — no wrapper
 * script or `cross-env` dependency needed, which also keeps it working
 * identically on Windows.
 *
 * An explicit `TZ` in the environment always wins: the container sets it,
 * and a developer debugging zone behaviour can still override it.
 */
export function applyBusinessTimeZone(): void {
  if (process.env.TZ) return
  process.env.TZ = BUSINESS_TIME_ZONE
}
