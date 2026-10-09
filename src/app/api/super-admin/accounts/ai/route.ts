// ============================================================
// GET /api/super-admin/accounts/ai  (super admin only)
//
// One row per account for Super admin → Cuentas: whose key it runs on,
// whether the agent is on, the AI replies and tokens spent this business
// month, and its monthly limit (migration 072).
// ============================================================

import { NextResponse } from 'next/server'

import { requireSuperAdmin, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/super-admin/admin-client'
import { businessMonthStart, loadPlatformAiRow } from '@/lib/ai/platform'
import { planState } from '@/lib/plans/limits'
import type { PlanStatus } from '@/lib/plans/types'

const PAGE = 1000

function planFields(
  row: { plan_id: string | null; plan_status: PlanStatus; plan_expires_at: string | null } | undefined,
  names: Map<string, string>,
) {
  if (!row) return { plan_name: null, plan_state: 'none', plan_expires_at: null }
  const planName = row.plan_id ? (names.get(row.plan_id) ?? null) : null
  return {
    plan_name: planName,
    plan_state: planState({
      hasPlan: !!planName,
      status: row.plan_status,
      expiresAt: row.plan_expires_at,
    }).state,
    plan_expires_at: row.plan_expires_at,
  }
}

export async function GET() {
  try {
    await requireSuperAdmin()
    const admin = supabaseAdmin()

    // `ai_monthly_limit` arrives with migration 072; fall back without it.
    const loadAccounts = (columns: string) =>
      admin.from('accounts').select(columns).order('name', { ascending: true })
    let limitsAvailable = true
    let accountsRes = await loadAccounts('id, name, ai_monthly_limit')
    if (accountsRes.error?.code === '42703') {
      limitsAvailable = false
      accountsRes = await loadAccounts('id, name')
    }
    if (accountsRes.error) {
      console.error('[GET /api/super-admin/accounts/ai] accounts error:', accountsRes.error)
      return NextResponse.json({ error: 'Failed to load accounts' }, { status: 500 })
    }
    const accounts = (accountsRes.data ?? []) as unknown as {
      id: string
      name: string
      ai_monthly_limit?: number | null
    }[]

    const { data: configs } = await admin
      .from('ai_configs')
      .select('account_id, is_active, auto_reply_enabled, api_key')
    const configByAccount = new Map(
      (configs ?? []).map((c) => [c.account_id as string, c]),
    )

    // Usage this month, paged past PostgREST's 1000-row cap.
    const since = businessMonthStart().toISOString()
    const usage = new Map<string, { runs: number; tokens: number }>()
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin
        .from('ai_usage_log')
        .select('account_id, total_tokens')
        .gte('created_at', since)
        .order('created_at', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) {
        console.error('[GET /api/super-admin/accounts/ai] usage error:', error)
        break
      }
      for (const row of data ?? []) {
        const u = usage.get(row.account_id) ?? { runs: 0, tokens: 0 }
        u.runs += 1
        u.tokens += row.total_tokens ?? 0
        usage.set(row.account_id, u)
      }
      if (!data || data.length < PAGE) break
    }

    const platform = await loadPlatformAiRow()

    // Plan columns arrive with migration 074.
    const planByAccount = new Map<
      string,
      { plan_id: string | null; plan_status: PlanStatus; plan_expires_at: string | null }
    >()
    const planNames = new Map<string, string>()
    const plansRes = await admin
      .from('accounts')
      .select('id, plan_id, plan_status, plan_expires_at')
    const plansAvailable = !plansRes.error
    if (plansAvailable) {
      for (const row of (plansRes.data ?? []) as {
        id: string
        plan_id: string | null
        plan_status: PlanStatus
        plan_expires_at: string | null
      }[]) {
        planByAccount.set(row.id, row)
      }
      const { data: plans } = await admin.from('plans').select('id, name')
      for (const p of (plans ?? []) as { id: string; name: string }[]) planNames.set(p.id, p.name)
    }

    return NextResponse.json({
      platform_configured: !!platform,
      limits_available: limitsAvailable,
      plans_available: plansAvailable,
      accounts: accounts.map((a) => {
        const cfg = configByAccount.get(a.id)
        const u = usage.get(a.id) ?? { runs: 0, tokens: 0 }
        return {
          id: a.id,
          name: a.name,
          configured: !!cfg,
          is_active: !!cfg?.is_active,
          auto_reply_enabled: !!cfg?.auto_reply_enabled,
          key_source: cfg?.api_key ? 'own' : platform ? 'platform' : 'none',
          monthly_runs: u.runs,
          monthly_tokens: u.tokens,
          monthly_limit: a.ai_monthly_limit ?? null,
          ...planFields(planByAccount.get(a.id), planNames),
        }
      }),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
