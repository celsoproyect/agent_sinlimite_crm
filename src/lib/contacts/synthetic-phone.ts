import { randomInt } from 'node:crypto'

/**
 * Synthetic phone numbers for contacts that have no real WhatsApp
 * number — a web-widget visitor (049) or a lead-form submission (050).
 * `contacts.phone` is NOT NULL and feeds the generated, unique-per-
 * account `phone_normalized` column, so these contacts still need
 * *something* there.
 *
 * The `000` prefix is reserved: no real E.164 WhatsApp number starts
 * with it, so a synthetic phone can never collide with — or be
 * mistaken for — a genuine WhatsApp contact sharing the same
 * `(account_id, phone_normalized)` unique index.
 */
const SYNTHETIC_PHONE_RE = /^000\d{16,20}$/

export function isSyntheticPhone(v: unknown): v is string {
  return typeof v === 'string' && SYNTHETIC_PHONE_RE.test(v)
}

export function mintSyntheticPhone(): string {
  const a = randomInt(0, 1_000_000_000).toString().padStart(9, '0')
  const b = randomInt(0, 1_000_000_000).toString().padStart(9, '0')
  return `000${a}${b}`
}
