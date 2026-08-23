// ============================================================
// /api/super-admin/users
//
//   GET  — list every user on the platform, across all accounts.
//   POST — create a new user directly (email + password), assigned
//          to a chosen account + role.
//
// Super admin only (`profiles.is_super_admin`, migration 040). Uses
// the service-role client (src/lib/super-admin/admin-client.ts) to
// read/write across accounts and to call the Supabase Auth Admin
// API — regular RLS-scoped queries can't do either.
//
// `is_super_admin` is NEVER accepted or returned as a writable field
// here — it stays a direct-SQL-only flag (see migration 040's header
// comment). This panel only ever touches account_id / account_role /
// full_name / password.
// ============================================================

import { NextResponse } from 'next/server'

import { requireSuperAdmin, toErrorResponse } from '@/lib/auth/account'
import { isAccountRole } from '@/lib/auth/roles'
import { supabaseAdmin } from '@/lib/super-admin/admin-client'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

interface ProfileRow {
  user_id: string
  full_name: string | null
  email: string | null
  account_id: string
  account_role: string
  is_super_admin: boolean | null
  created_at: string
}

export async function GET() {
  try {
    await requireSuperAdmin()

    const admin = supabaseAdmin()

    const [{ data: profiles, error: profErr }, { data: accounts, error: acctErr }] =
      await Promise.all([
        admin
          .from('profiles')
          .select(
            'user_id, full_name, email, account_id, account_role, is_super_admin, created_at',
          )
          .order('created_at', { ascending: true }),
        admin.from('accounts').select('id, name'),
      ])

    if (profErr || acctErr) {
      console.error(
        '[GET /api/super-admin/users] fetch error:',
        profErr || acctErr,
      )
      return NextResponse.json(
        { error: 'Failed to load users' },
        { status: 500 },
      )
    }

    // Join in JS rather than a PostgREST embed — same schema-cache
    // staleness risk documented on getCurrentAccount().
    const accountNames = new Map(
      (accounts ?? []).map((a) => [a.id as string, a.name as string]),
    )

    const users = (profiles as ProfileRow[]).flatMap((row) => {
      if (!isAccountRole(row.account_role)) return []
      return [
        {
          user_id: row.user_id,
          full_name: row.full_name ?? '',
          email: row.email,
          account_id: row.account_id,
          account_name: accountNames.get(row.account_id) ?? '—',
          role: row.account_role,
          is_super_admin: row.is_super_admin === true,
          created_at: row.created_at,
        },
      ]
    })

    return NextResponse.json({ users })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireSuperAdmin()

    const limit = checkRateLimit(
      `admin:superAdminCreateUser:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as
      | {
          email?: unknown
          password?: unknown
          full_name?: unknown
          account_id?: unknown
          role?: unknown
        }
      | null

    const email = typeof body?.email === 'string' ? body.email.trim() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const fullName =
      typeof body?.full_name === 'string' ? body.full_name.trim() : ''
    const accountId =
      typeof body?.account_id === 'string' ? body.account_id : ''
    const role = body?.role

    if (!email || !email.includes('@')) return bad('A valid email is required')
    if (!password || password.length < 8) {
      return bad('Password must be at least 8 characters')
    }
    if (!accountId) return bad('account_id is required')
    // Mirrors the invitation flow: owner is never assignable directly,
    // it's tied to accounts.owner_user_id and only moves via transfer.
    if (!isAccountRole(role) || role === 'owner') {
      return bad("role must be one of 'admin', 'agent', 'viewer'")
    }

    const admin = supabaseAdmin()

    const { data: account, error: accountErr } = await admin
      .from('accounts')
      .select('id')
      .eq('id', accountId)
      .maybeSingle()
    if (accountErr) {
      console.error('[POST /api/super-admin/users] account lookup error:', accountErr)
      return NextResponse.json({ error: 'Failed to create user' }, { status: 500 })
    }
    if (!account) return bad('Target account not found')

    // handle_new_user (migration 017) fires on this insert and
    // auto-creates a personal account + an 'owner' profile for the
    // new user. We overwrite both below to land them in the target
    // account/role instead, then delete the now-orphaned personal
    // account it created.
    const { data: created, error: createErr } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: fullName ? { full_name: fullName } : undefined,
      })

    if (createErr || !created?.user) {
      return bad(createErr?.message || 'Failed to create user')
    }

    const newUserId = created.user.id

    const { error: profileErr } = await admin
      .from('profiles')
      .update({
        account_id: accountId,
        account_role: role,
        ...(fullName ? { full_name: fullName } : {}),
      })
      .eq('user_id', newUserId)

    if (profileErr) {
      console.error('[POST /api/super-admin/users] profile reassign error:', profileErr)
      // The auth user now exists but is stuck on its auto-created
      // personal account. Surface this clearly rather than pretending
      // it succeeded.
      return NextResponse.json(
        {
          error:
            'User was created but could not be assigned to the account. Please retry the edit.',
        },
        { status: 500 },
      )
    }

    // Clean up the orphaned personal account created by the trigger.
    // Safe: the one-account-per-owner unique index guarantees this is
    // exactly the row the trigger just created, and the profile no
    // longer points at it after the reassignment above.
    const { error: cleanupErr } = await admin
      .from('accounts')
      .delete()
      .eq('owner_user_id', newUserId)
      .neq('id', accountId)
    if (cleanupErr) {
      console.error('[POST /api/super-admin/users] orphan account cleanup error:', cleanupErr)
      // Non-fatal — an unused personal account is harmless clutter,
      // not a correctness issue. Don't fail the request over it.
    }

    return NextResponse.json({
      user: {
        user_id: newUserId,
        full_name: fullName,
        email,
        account_id: accountId,
        role,
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
