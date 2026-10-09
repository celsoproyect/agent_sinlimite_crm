// Validation for the super admin's plan and extra forms (pure).

import { businessLocalToInstant, businessToday } from '@/lib/business-timezone'
import { isModuleKey, MODULE_KEYS, type EnabledModules, type ModuleKey } from '@/lib/modules'

import {
  PLAN_LIMIT_COLUMN,
  PLAN_RESOURCES,
  isPlanResource,
  type BillingInterval,
  type ExtraResource,
  type PlanLimitsRow,
} from './types'

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

/** A limit field: blank/null = unlimited, otherwise a whole number ≥ 0. */
export function parseLimit(raw: unknown): { ok: true; value: number | null } | { ok: false } {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null }
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isInteger(n) || n < 0 || n > 100_000_000) return { ok: false }
  return { ok: true, value: n }
}

export interface PlanInput extends PlanLimitsRow {
  name: string
  description: string | null
  price: number
  currency: string
  billing_interval: BillingInterval
  modules: EnabledModules
  is_active: boolean
  sort_order: number
}

export function parsePlanInput(body: unknown): Parsed<PlanInput> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name || name.length > 80) return { ok: false, error: 'name is required (max 80 characters)' }
  const description =
    typeof b.description === 'string' && b.description.trim()
      ? b.description.trim().slice(0, 500)
      : null
  const price = Number(b.price ?? 0)
  if (!Number.isFinite(price) || price < 0) return { ok: false, error: 'price must be ≥ 0' }
  const currency =
    typeof b.currency === 'string' && /^[A-Za-z]{3}$/.test(b.currency.trim())
      ? b.currency.trim().toUpperCase()
      : 'USD'
  const billing_interval: BillingInterval = b.billing_interval === 'year' ? 'year' : 'month'

  const limits = {} as PlanLimitsRow
  for (const resource of PLAN_RESOURCES) {
    const column = PLAN_LIMIT_COLUMN[resource]
    const parsed = parseLimit(b[column])
    if (!parsed.ok) return { ok: false, error: `${column} must be a whole number ≥ 0 or blank` }
    limits[column] = parsed.value
  }

  const modules: EnabledModules = {}
  const rawModules = (b.modules && typeof b.modules === 'object' ? b.modules : {}) as Record<
    string,
    unknown
  >
  for (const key of MODULE_KEYS) {
    if (typeof rawModules[key] === 'boolean') modules[key] = rawModules[key] as boolean
  }

  const sortRaw = Number(b.sort_order ?? 0)
  return {
    ok: true,
    value: {
      name,
      description,
      price: Math.round(price * 100) / 100,
      currency,
      billing_interval,
      ...limits,
      modules,
      is_active: b.is_active !== false,
      sort_order: Number.isInteger(sortRaw) ? sortRaw : 0,
    },
  }
}

export type ExtraDuration = 'permanent' | 'month' | 'until'

export interface ExtraInput {
  resource: ExtraResource
  quantity: number
  module_key: ModuleKey | null
  expires_at: string | null
  note: string | null
}

/** First instant of the next business month (when "this month" extras end). */
export function nextBusinessMonthStart(now: Date = new Date()): Date {
  const [y, m] = businessToday(now).split('-').map(Number)
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
  return businessLocalToInstant(next, '00:00')
}

/** End of a business-local date (the extra counts that whole day). */
export function endOfBusinessDay(dateISO: string): Date {
  return new Date(businessLocalToInstant(dateISO, '00:00').getTime() + 24 * 60 * 60 * 1000)
}

export function parseExtraInput(body: unknown, now: Date = new Date()): Parsed<ExtraInput> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const resource = b.resource
  let module_key: ModuleKey | null = null
  let quantity = 0
  if (resource === 'module') {
    if (typeof b.module_key !== 'string' || !isModuleKey(b.module_key)) {
      return { ok: false, error: 'module_key is not a module' }
    }
    module_key = b.module_key
  } else if (isPlanResource(resource)) {
    const n = Number(b.quantity)
    if (!Number.isInteger(n) || n <= 0 || n > 100_000_000) {
      return { ok: false, error: 'quantity must be a whole number > 0' }
    }
    quantity = n
  } else {
    return { ok: false, error: 'unknown resource' }
  }

  const duration = b.duration as ExtraDuration
  let expires_at: string | null = null
  if (duration === 'month') {
    expires_at = nextBusinessMonthStart(now).toISOString()
  } else if (duration === 'until') {
    const until = typeof b.until === 'string' ? b.until : ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until < businessToday(now)) {
      return { ok: false, error: 'until must be a date from today on' }
    }
    expires_at = endOfBusinessDay(until).toISOString()
  } else if (duration !== 'permanent') {
    return { ok: false, error: 'duration must be permanent, month or until' }
  }

  const note =
    typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 200) : null
  return { ok: true, value: { resource: resource as ExtraResource, quantity, module_key, expires_at, note } }
}
