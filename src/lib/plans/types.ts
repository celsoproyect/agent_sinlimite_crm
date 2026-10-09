// ============================================================
// Plans (migration 074) — shared by the server and the browser.
//
// A plan sets the limits an account gets (NULL = unlimited) and the
// modules it includes. `account_extras` add resources to one account on
// top of its plan. An account with no plan has no limits at all.
// ============================================================

import type { EnabledModules, ModuleKey } from '@/lib/modules'

/** Limited resources. Monthly ones reset on the 1st (business month). */
export const PLAN_RESOURCES = [
  'ai_replies',
  'users',
  'contacts',
  'broadcasts',
  'kb_documents',
] as const

export type PlanResource = (typeof PLAN_RESOURCES)[number]

export function isPlanResource(value: unknown): value is PlanResource {
  return typeof value === 'string' && (PLAN_RESOURCES as readonly string[]).includes(value)
}

export const MONTHLY_RESOURCES: ReadonlySet<PlanResource> = new Set<PlanResource>([
  'ai_replies',
  'broadcasts',
])

/** The plans column that holds each resource's limit. */
export const PLAN_LIMIT_COLUMN: Record<PlanResource, keyof PlanLimitsRow> = {
  ai_replies: 'ai_replies_month',
  users: 'max_users',
  contacts: 'max_contacts',
  broadcasts: 'broadcasts_month',
  kb_documents: 'max_kb_documents',
}

export interface PlanLimitsRow {
  ai_replies_month: number | null
  max_users: number | null
  max_contacts: number | null
  broadcasts_month: number | null
  max_kb_documents: number | null
}

export type BillingInterval = 'month' | 'year'

export interface Plan extends PlanLimitsRow {
  id: string
  name: string
  description: string | null
  price: number
  currency: string
  billing_interval: BillingInterval
  modules: EnabledModules
  is_active: boolean
  sort_order: number
}

export type ExtraResource = PlanResource | 'module'

export interface AccountExtra {
  id: string
  resource: ExtraResource
  quantity: number
  module_key: ModuleKey | null
  expires_at: string | null
  note: string | null
  created_at: string
}

/** Stored status. Expiry turns into past_due/suspended in planState(). */
export type PlanStatus = 'trial' | 'active' | 'suspended'

export const PLAN_STATUSES: readonly PlanStatus[] = ['trial', 'active', 'suspended']

/**
 * What the account is living through right now:
 * - none: no plan, no limits (accounts from before plans existed)
 * - trial / active: running normally
 * - expiring: paid up, but the date is less than EXPIRING_DAYS away
 * - past_due: the date passed; still working during the grace days
 * - suspended: by hand, or GRACE_DAYS after the date
 */
export type PlanState = 'none' | 'trial' | 'active' | 'expiring' | 'past_due' | 'suspended'

/** Days an expired account keeps working before it is suspended. */
export const GRACE_DAYS = 7
/** Days before expiry when the owner starts getting reminded. */
export const EXPIRING_DAYS = 5
/** Days a new trial lasts when the super admin picks "Prueba". */
export const TRIAL_DAYS = 14

/** The business WhatsApp line (same as the website's trial buttons). */
export const SALES_WHATSAPP = '18298059191'

export function upgradeUrl(accountName: string, planName: string | null): string {
  const text = planName
    ? `Hola, quiero mejorar el plan ${planName} de la cuenta ${accountName}.`
    : `Hola, quiero un plan para la cuenta ${accountName}.`
  return `https://wa.me/${SALES_WHATSAPP}?text=${encodeURIComponent(text)}`
}

export type Limits = Record<PlanResource, number | null>
export type Usage = Record<PlanResource, number>
