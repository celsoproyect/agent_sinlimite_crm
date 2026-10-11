// ============================================================
// PATCH /api/account/availability  (module `auto_assign`, migration 076)
//
// Body: { is_available: boolean, user_id?: string }
//
// The "Disponible para recibir chats" switch. Anyone sets their own;
// admins and owners can set it for anyone in their account. People
// who are away are skipped by the automatic assignment.
// ============================================================

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { canManageMembers } from '@/lib/auth/roles'
import { supabaseAdmin } from '@/lib/flows/admin-client'

export async function PATCH(req: Request) {
  try {
    const { accountId, userId, role } = await getCurrentAccount()
    const body = (await req.json().catch(() => null)) as { is_available?: unknown; user_id?: unknown } | null
    if (!body || typeof body.is_available !== 'boolean') {
      return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
    }
    const target = typeof body.user_id === 'string' && body.user_id ? body.user_id : userId
    if (target !== userId && !canManageMembers(role)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    const { data, error } = await supabaseAdmin()
      .from('profiles')
      .update({ is_available: body.is_available })
      .eq('user_id', target)
      .eq('account_id', accountId)
      .select('user_id')
    if (error?.code === '42703' || error?.code === 'PGRST204') {
      return NextResponse.json({ error: 'assignment_not_migrated' }, { status: 503 })
    }
    if (error) throw error
    if (!data?.length) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    return NextResponse.json({ user_id: target, is_available: body.is_available })
  } catch (err) {
    return toErrorResponse(err)
  }
}
