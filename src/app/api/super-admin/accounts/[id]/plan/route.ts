// ============================================================
// /api/super-admin/accounts/[id]/plan  (super admin only, migration 074)
//
//   GET   the account's plan, status, paid-up date, extras, limits and
//         usage, plus every plan for the picker
//   PATCH any of:
//         plan_id      — a plan, or null for no plan (no limits)
//         plan_status  — trial | active | suspended
//         expires_on   — YYYY-MM-DD (paid up to the end of that business
//                        day), or null for no date
//         pay          — 'month' | 'year' | true (the plan's interval):
//                        mark one more period paid, counted from the
//                        current date while it is still ahead, and set
//                        the account active
// The plan's modules are written to enabled_modules after every change.
// ============================================================

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { requireSuperAdmin, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/super-admin/admin-client'
import { extendPaidUntil } from '@/lib/plans/limits'
import { endOfBusinessDay } from '@/lib/plans/parse'
import {
  PLAN_COLUMNS,
  clearPlanCache,
  loadPlanSnapshot,
  loadUsage,
  normalizePlan,
  syncAccountModules,
} from '@/lib/plans/server'
import { PLAN_STATUSES, TRIAL_DAYS, type PlanStatus } from '@/lib/plans/types'

type Params = { params: Promise<{ id: string }> }

async function payload(admin: SupabaseClient, accountId: string) {
  const [snapshot, usage, plansRes] = await Promise.all([
    loadPlanSnapshot(accountId, { fresh: true, db: admin }),
    loadUsage(admin, accountId),
    admin.from('plans').select(PLAN_COLUMNS).order('sort_order').order('price'),
  ])
  return {
    migrated: snapshot.migrated,
    account: { id: accountId, name: snapshot.accountName },
    plan: snapshot.plan,
    status: snapshot.status,
    expires_at: snapshot.expiresAt,
    state: snapshot.state,
    ai_monthly_limit: snapshot.aiMonthlyLimit,
    extras: snapshot.extras,
    limits: snapshot.limits,
    usage,
    plans: ((plansRes.data ?? []) as Record<string, unknown>[]).map(normalizePlan),
  }
}

export async function GET(_request: Request, { params }: Params) {
  try {
    await requireSuperAdmin()
    const { id } = await params
    return NextResponse.json(await payload(supabaseAdmin(), id))
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    await requireSuperAdmin()
    const { id } = await params
    const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>
    const admin = supabaseAdmin()

    const current = await loadPlanSnapshot(id, { fresh: true, db: admin })
    if (!current.migrated) {
      return NextResponse.json(
        { error: 'Migration 074 has not run', code: 'plans_not_migrated' },
        { status: 503 },
      )
    }

    const update: Record<string, unknown> = {}
    let planInterval: 'month' | 'year' = current.plan?.billing_interval ?? 'month'

    if ('plan_id' in body) {
      if (body.plan_id === null) {
        update.plan_id = null
      } else if (typeof body.plan_id === 'string') {
        const { data: plan } = await admin
          .from('plans')
          .select('id, billing_interval')
          .eq('id', body.plan_id)
          .maybeSingle()
        if (!plan) return NextResponse.json({ error: 'Plan not found' }, { status: 400 })
        update.plan_id = plan.id
        planInterval = plan.billing_interval === 'year' ? 'year' : 'month'
      } else {
        return NextResponse.json({ error: 'plan_id must be a string or null' }, { status: 400 })
      }
    }

    if ('plan_status' in body) {
      if (!PLAN_STATUSES.includes(body.plan_status as PlanStatus)) {
        return NextResponse.json({ error: 'invalid plan_status' }, { status: 400 })
      }
      update.plan_status = body.plan_status
      // A new trial with no date gets the standard trial length.
      if (body.plan_status === 'trial' && !current.expiresAt && !('expires_on' in body)) {
        update.plan_expires_at = new Date(Date.now() + TRIAL_DAYS * 86_400_000).toISOString()
      }
    }

    if ('expires_on' in body) {
      if (body.expires_on === null || body.expires_on === '') {
        update.plan_expires_at = null
      } else if (
        typeof body.expires_on === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(body.expires_on)
      ) {
        update.plan_expires_at = endOfBusinessDay(body.expires_on).toISOString()
      } else {
        return NextResponse.json({ error: 'expires_on must be YYYY-MM-DD' }, { status: 400 })
      }
    }

    if (body.pay === 'month' || body.pay === 'year' || body.pay === true) {
      const interval = body.pay === true ? planInterval : body.pay
      update.plan_expires_at = extendPaidUntil(current.expiresAt, interval)
      update.plan_status = 'active'
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'Nothing to change' }, { status: 400 })
    }

    const { data, error } = await admin.from('accounts').update(update).eq('id', id).select('id')
    if (error) {
      console.error('[PATCH /api/super-admin/accounts/:id/plan] error:', error)
      return NextResponse.json({ error: 'Failed to save the plan' }, { status: 500 })
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    }

    await syncAccountModules(admin, id)
    clearPlanCache(id)
    return NextResponse.json(await payload(admin, id))
  } catch (err) {
    return toErrorResponse(err)
  }
}
