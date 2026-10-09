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

const PAGE = 1000

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

    return NextResponse.json({
      platform_configured: !!platform,
      limits_available: limitsAvailable,
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
        }
      }),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
