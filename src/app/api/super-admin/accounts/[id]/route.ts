// ============================================================
// PATCH /api/super-admin/accounts/[id]
//
// Updates a single account's `enabled_modules` flag map (migration
// 048) — the only field this route touches. Super admin only; the
// column itself is additionally guarded at the DB layer by the
// accounts_modules_super_admin_guard trigger, so this endpoint is
// belt-and-suspenders, not the sole line of defense.
// ============================================================

import { NextResponse } from 'next/server'

import { requireSuperAdmin, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/super-admin/admin-client'
import { isModuleKey } from '@/lib/modules'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireSuperAdmin()
    const { id } = await params

    const body = (await request.json().catch(() => null)) as
      | { enabled_modules?: unknown }
      | null
    if (!body || typeof body.enabled_modules !== 'object' || body.enabled_modules === null) {
      return bad('enabled_modules must be an object')
    }

    const input = body.enabled_modules as Record<string, unknown>
    const enabledModules: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(input)) {
      if (!isModuleKey(key)) return bad(`Unknown module key: ${key}`)
      if (typeof value !== 'boolean') return bad(`${key} must be a boolean`)
      enabledModules[key] = value
    }

    const admin = supabaseAdmin()
    const { data: account, error: lookupErr } = await admin
      .from('accounts')
      .select('id')
      .eq('id', id)
      .maybeSingle()
    if (lookupErr) {
      console.error('[PATCH /api/super-admin/accounts/:id] lookup error:', lookupErr)
      return NextResponse.json({ error: 'Failed to update account' }, { status: 500 })
    }
    if (!account) return bad('Account not found')

    const { error: updateErr } = await admin
      .from('accounts')
      .update({ enabled_modules: enabledModules })
      .eq('id', id)
    if (updateErr) {
      console.error('[PATCH /api/super-admin/accounts/:id] update error:', updateErr)
      return NextResponse.json({ error: 'Failed to update account' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
