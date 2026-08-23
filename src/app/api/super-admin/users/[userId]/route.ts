// ============================================================
// /api/super-admin/users/[userId]
//
//   PATCH  — edit full_name / role / account_id / password.
//   DELETE — delete the user outright (auth.users row + cascades).
//
// Super admin only. Uses the service-role client to write across
// accounts and to call the Auth Admin API for password changes and
// deletion — regular RLS-scoped writes can't do either.
//
// `is_super_admin` is never accepted here — see the header comment
// on the sibling GET/POST route.
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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireSuperAdmin()
    const { userId } = await params

    const limit = checkRateLimit(
      `admin:superAdminEditUser:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as
      | {
          full_name?: unknown
          role?: unknown
          account_id?: unknown
          password?: unknown
        }
      | null
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const admin = supabaseAdmin()

    const { data: target, error: targetErr } = await admin
      .from('profiles')
      .select('user_id, account_id, account_role')
      .eq('user_id', userId)
      .maybeSingle()
    if (targetErr) {
      console.error('[PATCH /api/super-admin/users/:id] lookup error:', targetErr)
      return NextResponse.json({ error: 'Failed to update user' }, { status: 500 })
    }
    if (!target) return bad('User not found')

    const profileUpdate: Record<string, unknown> = {}

    if ('full_name' in body) {
      const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : ''
      if (!fullName) return bad('full_name cannot be empty')
      profileUpdate.full_name = fullName
    }

    const roleProvided = 'role' in body
    const accountIdProvided = 'account_id' in body
    if (roleProvided || accountIdProvided) {
      // Owner is tied 1:1 to accounts.owner_user_id — moving it here
      // would desync the two, same reasoning as set_member_role (018).
      if (target.account_role === 'owner') {
        return bad(
          'This user is an account owner — role/account changes are not supported here',
        )
      }
      if (userId === ctx.userId) {
        return bad('Cannot change your own role or account')
      }

      if (roleProvided) {
        if (!isAccountRole(body.role) || body.role === 'owner') {
          return bad("role must be one of 'admin', 'agent', 'viewer'")
        }
        profileUpdate.account_role = body.role
      }

      if (accountIdProvided) {
        const accountId = typeof body.account_id === 'string' ? body.account_id : ''
        if (!accountId) return bad('account_id must be a string')
        const { data: account, error: accountErr } = await admin
          .from('accounts')
          .select('id')
          .eq('id', accountId)
          .maybeSingle()
        if (accountErr) {
          console.error('[PATCH /api/super-admin/users/:id] account lookup error:', accountErr)
          return NextResponse.json({ error: 'Failed to update user' }, { status: 500 })
        }
        if (!account) return bad('Target account not found')
        profileUpdate.account_id = accountId
      }
    }

    if (Object.keys(profileUpdate).length > 0) {
      const { error: updateErr } = await admin
        .from('profiles')
        .update(profileUpdate)
        .eq('user_id', userId)
      if (updateErr) {
        console.error('[PATCH /api/super-admin/users/:id] update error:', updateErr)
        return NextResponse.json({ error: 'Failed to update user' }, { status: 500 })
      }
    }

    if ('password' in body) {
      const password = typeof body.password === 'string' ? body.password : ''
      if (!password || password.length < 8) {
        return bad('Password must be at least 8 characters')
      }
      const { error: pwErr } = await admin.auth.admin.updateUserById(userId, {
        password,
      })
      if (pwErr) {
        console.error('[PATCH /api/super-admin/users/:id] password update error:', pwErr)
        return bad(pwErr.message || 'Failed to update password')
      }
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireSuperAdmin()
    const { userId } = await params

    if (userId === ctx.userId) {
      return bad('Cannot delete your own account')
    }

    const limit = checkRateLimit(
      `admin:superAdminDeleteUser:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const admin = supabaseAdmin()

    const { data: target, error: targetErr } = await admin
      .from('profiles')
      .select('account_role')
      .eq('user_id', userId)
      .maybeSingle()
    if (targetErr) {
      console.error('[DELETE /api/super-admin/users/:id] lookup error:', targetErr)
      return NextResponse.json({ error: 'Failed to delete user' }, { status: 500 })
    }
    if (!target) return bad('User not found')

    // accounts.owner_user_id is ON DELETE RESTRICT — deleting an owner
    // outright would fail at the DB layer. Surface the friendly reason
    // up front rather than letting a raw FK violation reach the client.
    if (target.account_role === 'owner') {
      return bad(
        'This user owns an account — transfer ownership or delete the account before deleting the user',
      )
    }

    const { error: deleteErr } = await admin.auth.admin.deleteUser(userId)
    if (deleteErr) {
      console.error('[DELETE /api/super-admin/users/:id] delete error:', deleteErr)
      return bad(deleteErr.message || 'Failed to delete user')
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
