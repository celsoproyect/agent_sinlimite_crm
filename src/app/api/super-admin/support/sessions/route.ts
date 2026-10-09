// ============================================================
// GET /api/super-admin/support/sessions  (super admin only)
//
// The support-mode audit log (migration 073): who entered which
// client's account, when, and when they left. Newest first.
//   ?account_id=…  only visits to that account
//   ?limit=…       default 200, max 500
// Returns { sessions: [...], migrated: boolean }.
// ============================================================

import { NextResponse } from 'next/server'

import { requireSuperAdmin, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/super-admin/admin-client'
import { isMissingTable } from '@/lib/support/sessions'

interface SessionRow {
  id: string
  user_id: string
  account_id: string
  started_at: string
  ended_at: string | null
}

export async function GET(request: Request) {
  try {
    await requireSuperAdmin()
    const url = new URL(request.url)
    const accountId = url.searchParams.get('account_id')
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 500)

    const admin = supabaseAdmin()
    let query = admin
      .from('support_sessions')
      .select('id, user_id, account_id, started_at, ended_at')
      .order('started_at', { ascending: false })
      .limit(limit)
    if (accountId) query = query.eq('account_id', accountId)
    const { data, error } = await query
    if (error) {
      if (isMissingTable(error.code)) return NextResponse.json({ sessions: [], migrated: false })
      console.error('[support] sessions list failed:', error)
      return NextResponse.json({ error: 'Failed to load support sessions' }, { status: 500 })
    }

    const rows = (data as SessionRow[] | null) ?? []
    const userIds = [...new Set(rows.map((r) => r.user_id))]
    const accountIds = [...new Set(rows.map((r) => r.account_id))]
    const [{ data: profiles }, { data: accounts }] = await Promise.all([
      userIds.length
        ? admin.from('profiles').select('user_id, full_name, email').in('user_id', userIds)
        : Promise.resolve({ data: [] }),
      accountIds.length
        ? admin.from('accounts').select('id, name').in('id', accountIds)
        : Promise.resolve({ data: [] }),
    ])
    const people = new Map(
      ((profiles as { user_id: string; full_name: string | null; email: string | null }[] | null) ?? []).map(
        (p) => [p.user_id, p],
      ),
    )
    const names = new Map(
      ((accounts as { id: string; name: string }[] | null) ?? []).map((a) => [a.id, a.name]),
    )

    return NextResponse.json({
      migrated: true,
      sessions: rows.map((r) => ({
        id: r.id,
        account_id: r.account_id,
        account_name: names.get(r.account_id) ?? '—',
        user_name: people.get(r.user_id)?.full_name || people.get(r.user_id)?.email || r.user_id,
        user_email: people.get(r.user_id)?.email ?? null,
        started_at: r.started_at,
        ended_at: r.ended_at,
      })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
