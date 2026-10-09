// ============================================================
// /api/super-admin/support  (super admin only, migration 073)
//
// Support mode: the super admin enters a client's account to help
// them, seeing and editing everything as an admin of that account.
//   GET     the open visit, if any: { session: { account_id,
//           account_name, home_account_id, started_at } | null }
//   POST    { account_id } — enter that account (switching straight
//           from one client to another keeps the original home)
//   DELETE  leave and go back to the home account
//
// The profile move goes through the service role, because the 034
// trigger stops `authenticated` from changing account_id/account_role.
// Every visit stays in `support_sessions` as the audit log.
// ============================================================

import { NextResponse } from 'next/server'

import { requireSuperAdmin, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/super-admin/admin-client'
import {
  SUPPORT_ROLE,
  isMissingTable,
  loadOpenSupportSession,
  type SupportSession,
} from '@/lib/support/sessions'

function migrationPending() {
  return NextResponse.json(
    {
      error: 'Apply migration 073 in the Supabase SQL Editor first.',
      code: 'migration_pending',
    },
    { status: 409 },
  )
}

function failed(message: string) {
  return NextResponse.json({ error: message }, { status: 500 })
}

export async function GET() {
  try {
    const { userId } = await requireSuperAdmin()
    const admin = supabaseAdmin()
    const session = await loadOpenSupportSession(admin, userId)
    if (!session) return NextResponse.json({ session: null })
    const { data: account } = await admin
      .from('accounts')
      .select('name')
      .eq('id', session.account_id)
      .maybeSingle()
    return NextResponse.json({
      session: {
        account_id: session.account_id,
        account_name: (account as { name: string } | null)?.name ?? '—',
        home_account_id: session.home_account_id,
        started_at: session.started_at,
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** Put the profile back home and close the visit. */
async function leave(userId: string, session: SupportSession): Promise<string | null> {
  const admin = supabaseAdmin()
  const { error: profileErr } = await admin
    .from('profiles')
    .update({ account_id: session.home_account_id, account_role: session.home_role })
    .eq('user_id', userId)
  if (profileErr) {
    console.error('[support] restore profile failed:', profileErr)
    return 'Failed to return to your account'
  }
  const { error } = await admin
    .from('support_sessions')
    .update({ ended_at: new Date().toISOString() })
    .eq('id', session.id)
  if (error) console.error('[support] close session failed:', error)
  return null
}

export async function POST(request: Request) {
  try {
    const ctx = await requireSuperAdmin()

    const limit = checkRateLimit(`sa-support:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as { account_id?: unknown } | null
    const targetId = typeof body?.account_id === 'string' ? body.account_id : ''
    if (!targetId) {
      return NextResponse.json({ error: 'account_id is required' }, { status: 400 })
    }

    const admin = supabaseAdmin()

    // Is the table there? (A missing table reads as "no session".)
    const probe = await admin.from('support_sessions').select('id').limit(1)
    if (probe.error) {
      return isMissingTable(probe.error.code) ? migrationPending() : failed('Failed to enter the account')
    }

    const { data: target } = await admin
      .from('accounts')
      .select('id, name')
      .eq('id', targetId)
      .maybeSingle()
    if (!target) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

    const open = await loadOpenSupportSession(admin, ctx.userId)
    const home = open
      ? { accountId: open.home_account_id, role: open.home_role }
      : { accountId: ctx.accountId, role: ctx.role }

    // Entering your own account = leaving support mode.
    if (targetId === home.accountId) {
      if (open) {
        const problem = await leave(ctx.userId, open)
        if (problem) return failed(problem)
      }
      return NextResponse.json({ ok: true, session: null })
    }
    if (open?.account_id === targetId) {
      return NextResponse.json({ ok: true, account_name: target.name })
    }

    // Switching client to client: close the current visit, keep home.
    if (open) {
      await admin
        .from('support_sessions')
        .update({ ended_at: new Date().toISOString() })
        .eq('id', open.id)
    }

    const { data: created, error: insertErr } = await admin
      .from('support_sessions')
      .insert({
        user_id: ctx.userId,
        account_id: targetId,
        home_account_id: home.accountId,
        home_role: home.role,
      })
      .select('id')
      .single()
    if (insertErr || !created) {
      console.error('[support] open session failed:', insertErr)
      return failed('Failed to enter the account')
    }

    const { error: profileErr } = await admin
      .from('profiles')
      .update({ account_id: targetId, account_role: SUPPORT_ROLE })
      .eq('user_id', ctx.userId)
    if (profileErr) {
      console.error('[support] move profile failed:', profileErr)
      await admin.from('support_sessions').delete().eq('id', created.id)
      return failed('Failed to enter the account')
    }

    return NextResponse.json({ ok: true, account_name: target.name })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE() {
  try {
    const { userId } = await requireSuperAdmin()
    const session = await loadOpenSupportSession(supabaseAdmin(), userId)
    if (!session) return NextResponse.json({ ok: true })
    const problem = await leave(userId, session)
    if (problem) return failed(problem)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
