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
// not a naive local wall-clock value, so the date/time shown to the
// customer must be explicitly converted to the business's zone rather
// than read off the raw (UTC) ISO string. That conversion lives in
// `@/lib/business-timezone`, shared with the AI booking tools.
// ============================================================

import { businessDate, businessTime } from '@/lib/business-timezone'

export interface ReminderMessageVars {
  contactName: string
  service: string
  /** ISO 8601 — e.g. booking.starts_at. */
  startsAt: string
  /** Booking reference ("CITA-3F9A2C"), for {{reference}}. */
  reference?: string
  /** The doctor's name (clinic module), for {{doctor}}. */
  doctor?: string
}

const TOKEN_PATTERN = /\{\{\s*(contact_name|service|date|time|reference|doctor)\s*\}\}/g

export function renderReminderMessage(text: string, vars: ReminderMessageVars): string {
  const { date, time } = splitIsoDateTime(vars.startsAt)
  const values: Record<string, string> = {
    contact_name: vars.contactName,
    service: vars.service,
    date,
    time,
    ...(vars.reference ? { reference: vars.reference } : {}),
    // An appointment with no doctor: blank, never the raw token.
    doctor: vars.doctor ?? '',
  }
  return text.replace(TOKEN_PATTERN, (match, key: string) => values[key] ?? match)
}

/** `2026-08-25T18:30:00.000Z` (UTC) -> `{ date: '2026-08-25', time: '14:30' }` (America/Santo_Domingo). */
function splitIsoDateTime(iso: string): { date: string; time: string } {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: iso, time: '' }
  return { date: businessDate(d), time: businessTime(d) }
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
