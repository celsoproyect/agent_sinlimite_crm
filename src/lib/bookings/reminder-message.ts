// ============================================================
// Placeholder substitution for booking reminder messages.
//
// Named tokens (not `renderTemplateBody`'s positional {{1}}/{{2}} —
// this is free text the account owner writes themselves, so named
// placeholders are far more legible in a settings textarea). A token
// with no value is left visible rather than blanked, matching
// `renderTemplateBody`'s convention in template-body.ts.
//
// `starts_at` is a `timestamptz` (migration 046) — a true UTC instant,
// not a naive local wall-clock value. The business this app runs for
// always operates in America/Santo_Domingo (UTC-4, no DST), same zone
// the app container defaults `TZ` to in docker-compose.yml — so the
// date/time shown to the customer must be explicitly converted to that
// zone rather than read off the raw (UTC) ISO string, which would show
// the wrong wall-clock hour to the customer.
// ============================================================

const REMINDER_TIME_ZONE = 'America/Santo_Domingo'

export interface ReminderMessageVars {
  contactName: string
  service: string
  /** ISO 8601 — e.g. booking.starts_at. */
  startsAt: string
}

const TOKEN_PATTERN = /\{\{\s*(contact_name|service|date|time)\s*\}\}/g

export function renderReminderMessage(text: string, vars: ReminderMessageVars): string {
  const { date, time } = splitIsoDateTime(vars.startsAt)
  const values: Record<string, string> = {
    contact_name: vars.contactName,
    service: vars.service,
    date,
    time,
  }
  return text.replace(TOKEN_PATTERN, (match, key: string) => values[key] ?? match)
}

const DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: REMINDER_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: REMINDER_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** `2026-08-25T18:30:00.000Z` (UTC) -> `{ date: '2026-08-25', time: '14:30' }` (America/Santo_Domingo). */
function splitIsoDateTime(iso: string): { date: string; time: string } {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: iso, time: '' }
  // en-CA renders as YYYY-MM-DD; en-GB + hour12:false renders as HH:mm.
  return { date: DATE_FORMATTER.format(d), time: TIME_FORMATTER.format(d) }
}

/**
 * Positional params for the approved-template fallback, in the fixed
 * order documented to the account owner in the rule settings UI:
 * {{1}}=name, {{2}}=service, {{3}}=date, {{4}}=time.
 */
export function reminderTemplateParams(vars: ReminderMessageVars): string[] {
  const { date, time } = splitIsoDateTime(vars.startsAt)
  return [vars.contactName, vars.service, date, time]
}

/**
 * Meta rejects a free-text send with error code 131047 ("re-engagement
 * message") once more than 24h have passed since the customer's last
 * message. `meta-api.ts`'s `throwMetaError` only preserves the error
 * `message` text (not the numeric code), so detection is a regex over
 * that text — same style as `isRecipientNotAllowedError` in
 * `phone-utils.ts`.
 */
export function isOutsideSessionWindowError(message: string): boolean {
  return /131047|24[ -]?hour|re-?engagement|outside.*(session|window)/i.test(message)
}
