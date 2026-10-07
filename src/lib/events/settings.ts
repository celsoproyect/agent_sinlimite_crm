import type { EventHall, EventPackage, EventSettings, EventStatus } from '@/types'
import { normalizeWeeklyHours } from '@/lib/restaurant/settings'

// ============================================================
// Events module (migration 068): `accounts.event_settings`, the
// per-hall policy and quotes. Pure, so it is tested without a database.
//
// Each business decides whether a request needs the owner's approval and
// whether a deposit is required (and what percentage). A hall can
// override both (NULL on the hall = the account setting).
// ============================================================

export const DEFAULT_EVENT_SETTINGS: EventSettings = {
  requires_approval: true,
  deposit_required: false,
  deposit_percent: 30,
  currency: 'DOP',
  min_notice_days: 2,
  deposit_instructions: '',
  event_types: ['Cumpleaños', 'Boda', 'Corporativo', 'Graduación', 'Baby shower'],
  hours: null,
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function normalizeEventSettings(raw: unknown): EventSettings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const d = DEFAULT_EVENT_SETTINGS
  const types = Array.isArray(src.event_types)
    ? src.event_types.filter((t): t is string => typeof t === 'string' && !!t.trim()).map((t) => t.trim().slice(0, 60))
    : d.event_types
  const currency = typeof src.currency === 'string' && /^[A-Za-z]{3}$/.test(src.currency.trim()) ? src.currency.trim().toUpperCase() : d.currency
  return {
    requires_approval: typeof src.requires_approval === 'boolean' ? src.requires_approval : d.requires_approval,
    deposit_required: typeof src.deposit_required === 'boolean' ? src.deposit_required : d.deposit_required,
    deposit_percent: Math.round(num(src.deposit_percent, d.deposit_percent, 0, 100) * 100) / 100,
    currency,
    min_notice_days: Math.round(num(src.min_notice_days, d.min_notice_days, 0, 365)),
    deposit_instructions: typeof src.deposit_instructions === 'string' ? src.deposit_instructions.trim().slice(0, 1000) : '',
    event_types: types.slice(0, 30),
    hours: normalizeWeeklyHours(src.hours),
  }
}

export interface EventPolicy {
  requiresApproval: boolean
  depositRequired: boolean
  depositPercent: number
}

/** The account policy with the hall's overrides applied. A hall deposit
 *  percentage of 0 turns the deposit off for that hall. */
export function effectivePolicy(
  settings: EventSettings,
  hall?: Pick<EventHall, 'requires_approval' | 'deposit_percent'> | null,
): EventPolicy {
  const hallPct = hall?.deposit_percent
  const hasHallPct = typeof hallPct === 'number' && Number.isFinite(hallPct)
  const depositPercent = hasHallPct ? Number(hallPct) : settings.deposit_percent
  return {
    requiresApproval: typeof hall?.requires_approval === 'boolean' ? hall.requires_approval : settings.requires_approval,
    depositRequired: hasHallPct ? Number(hallPct) > 0 : settings.deposit_required && settings.deposit_percent > 0,
    depositPercent,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export interface EventQuote {
  /** Null when there is no price to quote from: the team sends it. */
  total: number | null
  deposit: number | null
  /** How the total was worked out, for the customer and the owner. */
  breakdown: string | null
}

/**
 * The price of an event: the package (fixed price plus per person), else
 * the hall by the hour (at least `min_hours`). Null when neither has a
 * price — the team quotes it by hand.
 */
export function quoteEvent(args: {
  hall: Pick<EventHall, 'price_per_hour' | 'min_hours'> | null
  pkg?: Pick<EventPackage, 'name' | 'price' | 'price_per_person'> | null
  guests: number
  hours: number
  policy: EventPolicy
}): EventQuote {
  const { hall, pkg, guests, hours, policy } = args
  let total: number | null = null
  let breakdown: string | null = null
  if (pkg && (pkg.price != null || pkg.price_per_person != null)) {
    const fixed = Number(pkg.price ?? 0)
    const perPerson = Number(pkg.price_per_person ?? 0)
    total = round2(fixed + perPerson * guests)
    const parts = [
      fixed ? `${fixed}` : null,
      perPerson ? `${perPerson} × ${guests} personas` : null,
    ].filter(Boolean)
    breakdown = `${pkg.name}: ${parts.join(' + ')}`
  } else if (hall?.price_per_hour != null) {
    const billed = Math.max(Number(hall.min_hours ?? 1), hours)
    total = round2(Number(hall.price_per_hour) * billed)
    breakdown = `${Number(hall.price_per_hour)} × ${billed} h`
  }
  const deposit = total != null && policy.depositRequired ? round2((total * policy.depositPercent) / 100) : null
  return { total, deposit, breakdown }
}

/** Where a new request starts: waiting for the owner, waiting for the
 *  deposit, or confirmed straight away. */
export function initialEventStatus(policy: EventPolicy): EventStatus {
  if (policy.requiresApproval) return 'requested'
  if (policy.depositRequired) return 'quoted'
  return 'confirmed'
}

/** The statuses an event can move to from `from`, in pipeline order. */
export const EVENT_STATUS_FLOW: EventStatus[] = ['requested', 'quoted', 'deposit_paid', 'confirmed', 'completed']

export function nextEventStatuses(from: EventStatus, policy: Pick<EventPolicy, 'depositRequired'>): EventStatus[] {
  if (from === 'cancelled' || from === 'completed') return []
  const at = EVENT_STATUS_FLOW.indexOf(from)
  const next = EVENT_STATUS_FLOW.slice(at + 1).filter((s) => policy.depositRequired || s !== 'deposit_paid')
  return [...next, 'cancelled']
}
