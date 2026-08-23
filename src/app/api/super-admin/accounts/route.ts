// ============================================================
// GET /api/super-admin/accounts
//
// Lists every account on the platform (id + name), for the account
// picker in the super-admin Users panel. Super admin only — a
// client's own admin/owner has no reason to see other tenants'
// account names.
// ============================================================

import { NextResponse } from 'next/server'

import { requireSuperAdmin, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/super-admin/admin-client'

export async function GET() {
  try {
    await requireSuperAdmin()

    const { data, error } = await supabaseAdmin()
      .from('accounts')
      .select('id, name')
      .order('name', { ascending: true })

    if (error) {
      console.error('[GET /api/super-admin/accounts] fetch error:', error)
      return NextResponse.json(
        { error: 'Failed to load accounts' },
        { status: 500 },
      )
    }

    return NextResponse.json({ accounts: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
