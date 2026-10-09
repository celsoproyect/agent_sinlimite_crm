// Pure plan math (no I/O), shared by the server and the browser.

import { MODULE_KEYS, isModuleEnabled, type EnabledModules } from '@/lib/modules'

import {
  EXPIRING_DAYS,
  GRACE_DAYS,
  MONTHLY_RESOURCES,
  PLAN_LIMIT_COLUMN,
  PLAN_RESOURCES,
  type AccountExtra,
  type Limits,
  type PlanLimitsRow,
  type PlanResource,
  type PlanState,
  type PlanStatus,
} from './types'

const DAY_MS = 24 * 60 * 60 * 1000

/** Extras that count right now (no expiry, or expiring in the future). */
export function activeExtras(extras: AccountExtra[], now: Date = new Date()): AccountExtra[] {
  return extras.filter((e) => !e.expires_at || Date.parse(e.expires_at) > now.getTime())
}

/**
 * The account's limits: plan value + active extras, NULL = unlimited.
 * With no plan nothing is capped, except the AI's own per-account limit
 * (`accounts.ai_monthly_limit`, migration 072), which also replaces the
 * plan's AI value when it is set. Mirrors `account_plan_limit` in SQL.
 */
export function effectiveLimits(
  plan: PlanLimitsRow | null,
  extras: AccountExtra[],
  aiMonthlyLimit: number | null = null,
  now: Date = new Date(),
): Limits {
  const live = activeExtras(extras, now)
  const limits = {} as Limits
  for (const resource of PLAN_RESOURCES) {
    let base: number | null = plan ? plan[PLAN_LIMIT_COLUMN[resource]] : null
    if (resource === 'ai_replies' && aiMonthlyLimit !== null) base = aiMonthlyLimit
    if (base === null) {
      limits[resource] = null
      continue
    }
    const added = live
      .filter((e) => e.resource === resource)
      .reduce((sum, e) => sum + e.quantity, 0)
    limits[resource] = base + added
  }
  return limits
}

/**
 * The module switches an account gets from its plan plus its module
 * extras: every module key, explicitly on or off, ready to be written to
 * `accounts.enabled_modules`. A key the plan doesn't mention keeps the
 * module's default (on, except the default-off ones).
 */
export function planModules(
  planModulesMap: EnabledModules,
  extras: AccountExtra[],
  now: Date = new Date(),
): EnabledModules {
  const out: EnabledModules = {}
  for (const key of MODULE_KEYS) out[key] = isModuleEnabled(planModulesMap, key)
  for (const e of activeExtras(extras, now)) {
    if (e.resource === 'module' && e.module_key) out[e.module_key] = true
  }
  return out
}

export interface PlanStateInfo {
  state: PlanState
  /** Whole days until the paid-up date (negative once it passed). */
  daysLeft: number | null
  /** When an expired account gets suspended. */
  suspendsAt: string | null
}

export function planState(
  args: { hasPlan: boolean; status: PlanStatus; expiresAt: string | null },
  now: Date = new Date(),
): PlanStateInfo {
  if (args.status === 'suspended') return { state: 'suspended', daysLeft: null, suspendsAt: null }
  if (!args.hasPlan) return { state: 'none', daysLeft: null, suspendsAt: null }
  if (!args.expiresAt) {
    return { state: args.status === 'trial' ? 'trial' : 'active', daysLeft: null, suspendsAt: null }
  }
  const expires = Date.parse(args.expiresAt)
  const daysLeft = Math.ceil((expires - now.getTime()) / DAY_MS)
  const suspendsAt = new Date(expires + GRACE_DAYS * DAY_MS).toISOString()
  if (now.getTime() >= expires + GRACE_DAYS * DAY_MS) {
    return { state: 'suspended', daysLeft, suspendsAt }
  }
  if (now.getTime() >= expires) return { state: 'past_due', daysLeft, suspendsAt }
  if (args.status === 'trial') return { state: 'trial', daysLeft, suspendsAt }
  if (daysLeft <= EXPIRING_DAYS) return { state: 'expiring', daysLeft, suspendsAt }
  return { state: 'active', daysLeft, suspendsAt }
}

/** True when the account may not use the paid features. */
export function isBlockedState(state: PlanState): boolean {
  return state === 'suspended'
}

/** How full a limit is: ok, warn (≥80%) or full (≥100%). */
export function usageLevel(used: number, limit: number | null): 'ok' | 'warn' | 'full' {
  if (limit === null) return 'ok'
  if (used >= limit) return 'full'
  if (used >= limit * 0.8) return 'warn'
  return 'ok'
}

/** How many more of `resource` fit (Infinity when unlimited). */
export function remaining(used: number, limit: number | null): number {
  return limit === null ? Infinity : Math.max(0, limit - used)
}

/**
 * Key that makes a usage alert go out once: per business month for
 * monthly resources, per limit value for the rest (so raising the limit
 * re-arms the alert).
 */
export function usageAlertKey(
  resource: PlanResource,
  threshold: 80 | 100,
  limit: number,
  monthKey: string,
): string {
  return MONTHLY_RESOURCES.has(resource)
    ? `${resource}:${monthKey}:${threshold}`
    : `${resource}:${limit}:${threshold}`
}

/** New paid-up date when the owner pays one more period. */
export function extendPaidUntil(
  current: string | null,
  interval: 'month' | 'year',
  now: Date = new Date(),
): string {
  const start = current && Date.parse(current) > now.getTime() ? new Date(current) : now
  const next = new Date(start)
  if (interval === 'year') next.setUTCFullYear(next.getUTCFullYear() + 1)
  else next.setUTCMonth(next.getUTCMonth() + 1)
  return next.toISOString()
}
