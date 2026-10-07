import type { ReminderAppliesTo, ReminderRuleKind } from '@/types'

/** `before` (a reminder) or `after` (a follow-up), or null when invalid. */
export function parseRuleKind(raw: unknown): ReminderRuleKind | null {
  return raw === 'before' || raw === 'after' ? raw : null
}

/** Which bookings a rule applies to, or null when invalid. */
export function parseAppliesTo(raw: unknown): ReminderAppliesTo | null {
  return raw === 'all' || raw === 'appointment' || raw === 'table' || raw === 'event' ? raw : null
}
