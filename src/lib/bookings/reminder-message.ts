// ============================================================
// Placeholder substitution for booking reminder messages.
//
// Named tokens (not `renderTemplateBody`'s positional {{1}}/{{2}} —
// this is free text the account owner writes themselves, so named
// placeholders are far more legible in a settings textarea). A token
// with no value is left visible rather than blanked, matching
// `renderTemplateBody`'s convention in template-body.ts.
//
// Dates/times are read directly off the ISO `starts_at` string
// (UTC-offset components), not converted through a per-account
// timezone — `src/lib/ai/booking.ts` documents that no such timezone
// is stored; `starts_at` already reflects whatever wall-clock the
// booking was created against.
// ============================================================

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

/** `2026-08-25T14:30:00.000Z` -> `{ date: '2026-08-25', time: '14:30' }`. */
function splitIsoDateTime(iso: string): { date: string; time: string } {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso)
  if (!match) return { date: iso, time: '' }
  return { date: match[1], time: match[2] }
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
