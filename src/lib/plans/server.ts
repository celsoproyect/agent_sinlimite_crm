// ============================================================
// Plans on the server (migration 074): load an account's plan, count
// what it used and enforce the limits. Service role throughout — plans,
// extras and usage rows have no RLS policies.
//
// Everything degrades to "no plan, no limits" before migration 074
// runs (missing table/column), so nothing breaks in the meantime.
// ============================================================

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { businessMonthStart, countAiRunsThisMonth } from '@/lib/ai/platform'
import { supportVisitorIds } from '@/lib/support/sessions'
import type { EnabledModules } from '@/lib/modules'

import { effectiveLimits, planModules, planState, remaining, type PlanStateInfo } from './limits'
import type {
  AccountExtra,
  Limits,
  Plan,
  PlanResource,
  PlanStatus,
  Usage,
} from './types'

/** Postgres/PostgREST codes for a table or column that isn't there yet. */
export function isMissingSchema(code: string | undefined): boolean {
  return code === '42P01' || code === 'PGRST205' || code === '42703' || code === 'PGRST204'
}

export const PLAN_COLUMNS =
  'id, name, description, price, currency, billing_interval, ai_replies_month, max_users, max_contacts, broadcasts_month, max_kb_documents, modules, is_active, sort_order'

export function normalizePlan(row: Record<string, unknown>): Plan {
  return {
    ...(row as unknown as Plan),
    price: Number(row.price ?? 0),
    modules: (row.modules as EnabledModules | null) ?? {},
  }
}

export interface PlanSnapshot {
  accountId: string
  accountName: string
  plan: Plan | null
  status: PlanStatus
  expiresAt: string | null
  aiMonthlyLimit: number | null
  extras: AccountExtra[]
  limits: Limits
  state: PlanStateInfo
  /** False until migration 074 runs. */
  migrated: boolean
}

const CACHE_MS = 30_000
const cache = new Map<string, { at: number; value: PlanSnapshot }>()

/** Drop the cached snapshot after the super admin changes an account. */
export function clearPlanCache(accountId?: string): void {
  if (accountId) cache.delete(accountId)
  else cache.clear()
}

/** The account's plan, status, extras and resulting limits. */
export async function loadPlanSnapshot(
  accountId: string,
  opts: { fresh?: boolean; db?: SupabaseClient } = {},
): Promise<PlanSnapshot> {
  const hit = cache.get(accountId)
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value

  const db = opts.db ?? supabaseAdmin()
  let migrated = true
  let account: Record<string, unknown> | null = null
  const full = await db
    .from('accounts')
    .select('id, name, ai_monthly_limit, plan_id, plan_status, plan_expires_at')
    .eq('id', accountId)
    .maybeSingle()
  if (full.error && isMissingSchema(full.error.code)) {
    migrated = false
    const basic = await db.from('accounts').select('id, name').eq('id', accountId).maybeSingle()
    account = (basic.data as Record<string, unknown> | null) ?? null
  } else {
    if (full.error) console.error('[plans] account load failed:', full.error.message)
    account = (full.data as Record<string, unknown> | null) ?? null
  }

  let plan: Plan | null = null
  let extras: AccountExtra[] = []
  if (migrated && account?.plan_id) {
    const { data } = await db
      .from('plans')
      .select(PLAN_COLUMNS)
      .eq('id', account.plan_id as string)
      .maybeSingle()
    plan = data ? normalizePlan(data as Record<string, unknown>) : null
  }
  if (migrated) {
    const { data, error } = await db
      .from('account_extras')
      .select('id, resource, quantity, module_key, expires_at, note, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
    if (error && !isMissingSchema(error.code)) {
      console.error('[plans] extras load failed:', error.message)
    }
    extras = (data as AccountExtra[] | null) ?? []
  }

  const status = ((account?.plan_status as PlanStatus | undefined) ?? 'active') as PlanStatus
  const expiresAt = (account?.plan_expires_at as string | null | undefined) ?? null
  const aiMonthlyLimit =
    typeof account?.ai_monthly_limit === 'number' ? (account.ai_monthly_limit as number) : null

  const value: PlanSnapshot = {
    accountId,
    accountName: (account?.name as string | undefined) ?? '',
    plan,
    status,
    expiresAt,
    aiMonthlyLimit,
    extras,
    limits: effectiveLimits(plan, extras, aiMonthlyLimit),
    state: planState({ hasPlan: !!plan, status, expiresAt }),
    migrated,
  }
  cache.set(accountId, { at: Date.now(), value })
  return value
}

/** Team members (support visitors don't count), plus pending invites. */
export async function countUsers(
  db: SupabaseClient,
  accountId: string,
  opts: { includePendingInvites?: boolean } = {},
): Promise<number> {
  const { data } = await db.from('profiles').select('user_id').eq('account_id', accountId)
  const visitors = await supportVisitorIds(db, accountId)
  let total = ((data as { user_id: string }[] | null) ?? []).filter(
    (p) => !visitors.has(p.user_id),
  ).length
  if (opts.includePendingInvites) {
    const { count } = await db
      .from('account_invitations')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString())
    total += count ?? 0
  }
  return total
}

async function countRows(
  db: SupabaseClient,
  table: string,
  accountId: string,
): Promise<number> {
  const { count, error } = await db
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
  if (error) console.error(`[plans] ${table} count failed:`, error.message)
  return count ?? 0
}

/** Broadcast messages sent this business month. */
export async function countBroadcastsThisMonth(
  db: SupabaseClient,
  accountId: string,
  now: Date = new Date(),
): Promise<number> {
  const { count, error } = await db
    .from('broadcast_recipients')
    .select('id, broadcasts!inner(account_id)', { count: 'exact', head: true })
    .eq('broadcasts.account_id', accountId)
    .gte('sent_at', businessMonthStart(now).toISOString())
  if (error) console.error('[plans] broadcast count failed:', error.message)
  return count ?? 0
}

/** How much of one resource the account used. */
export async function countUsage(
  db: SupabaseClient,
  accountId: string,
  resource: PlanResource,
): Promise<number> {
  switch (resource) {
    case 'ai_replies':
      return countAiRunsThisMonth(db, accountId)
    case 'users':
      return countUsers(db, accountId)
    case 'contacts':
      return countRows(db, 'contacts', accountId)
    case 'broadcasts':
      return countBroadcastsThisMonth(db, accountId)
    case 'kb_documents':
      return countRows(db, 'ai_knowledge_documents', accountId)
  }
}

export async function loadUsage(db: SupabaseClient, accountId: string): Promise<Usage> {
  const [ai_replies, users, contacts, broadcasts, kb_documents] = await Promise.all([
    countUsage(db, accountId, 'ai_replies'),
    countUsage(db, accountId, 'users'),
    countUsage(db, accountId, 'contacts'),
    countUsage(db, accountId, 'broadcasts'),
    countUsage(db, accountId, 'kb_documents'),
  ])
  return { ai_replies, users, contacts, broadcasts, kb_documents }
}

export interface PlanCheck {
  allowed: boolean
  /** Why it was refused: the limit, or a suspended account. */
  reason?: 'limit' | 'suspended'
  limit: number | null
  used: number
  remaining: number
}

/**
 * Can the account add `adding` more of `resource`? `used` lets a caller
 * pass its own count (e.g. users + pending invites).
 */
export async function checkPlanLimit(
  accountId: string,
  resource: PlanResource,
  opts: { adding?: number; used?: number; db?: SupabaseClient } = {},
): Promise<PlanCheck> {
  const adding = opts.adding ?? 1
  const snapshot = await loadPlanSnapshot(accountId)
  if (snapshot.state.state === 'suspended') {
    return { allowed: false, reason: 'suspended', limit: null, used: 0, remaining: 0 }
  }
  const limit = snapshot.limits[resource]
  if (limit === null) return { allowed: true, limit: null, used: 0, remaining: Infinity }
  const db = opts.db ?? supabaseAdmin()
  const used = opts.used ?? (await countUsage(db, accountId, resource))
  const left = remaining(used, limit)
  return { allowed: left >= adding, reason: left >= adding ? undefined : 'limit', limit, used, remaining: left }
}

/** 409 the UI turns into "your plan allows N …" or "account suspended". */
export function planLimitResponse(resource: PlanResource, check: PlanCheck) {
  if (check.reason === 'suspended') {
    return NextResponse.json(
      { error: 'This account is suspended.', code: 'plan_suspended' },
      { status: 409 },
    )
  }
  return NextResponse.json(
    {
      error: `Plan limit reached for ${resource} (${check.used}/${check.limit}).`,
      code: 'plan_limit',
      resource,
      limit: check.limit,
      used: check.used,
    },
    { status: 409 },
  )
}

/**
 * Write the plan's modules (plus module extras) to
 * `accounts.enabled_modules`, so every existing module gate follows the
 * plan. Accounts with no plan keep their hand-set switches.
 */
export async function syncAccountModules(db: SupabaseClient, accountId: string): Promise<void> {
  clearPlanCache(accountId)
  const snapshot = await loadPlanSnapshot(accountId, { fresh: true, db })
  if (!snapshot.plan) return
  const modules = planModules(snapshot.plan.modules, snapshot.extras)
  const { error } = await db.from('accounts').update({ enabled_modules: modules }).eq('id', accountId)
  if (error) console.error('[plans] module sync failed:', error.message)
}

/** True when the plan is suspended (by hand or unpaid past the grace). */
export async function isAccountSuspended(accountId: string): Promise<boolean> {
  try {
    const { state } = await loadPlanSnapshot(accountId)
    return state.state === 'suspended'
  } catch (err) {
    console.error('[plans] suspension check failed:', err)
    return false
  }
}
