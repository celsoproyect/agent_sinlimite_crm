// DELETE /api/super-admin/accounts/[id]/extras/[extraId] — remove an
// extra (super admin only, migration 074).

import { NextResponse } from 'next/server'

import { requireSuperAdmin, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/super-admin/admin-client'
import { clearPlanCache, syncAccountModules } from '@/lib/plans/server'

type Params = { params: Promise<{ id: string; extraId: string }> }

export async function DELETE(_request: Request, { params }: Params) {
  try {
    await requireSuperAdmin()
    const { id, extraId } = await params
    const admin = supabaseAdmin()
    const { data, error } = await admin
      .from('account_extras')
      .delete()
      .eq('id', extraId)
      .eq('account_id', id)
      .select('id')
    if (error) {
      console.error('[DELETE /api/super-admin/accounts/:id/extras/:extraId] error:', error)
      return NextResponse.json({ error: 'Failed to remove the extra' }, { status: 500 })
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Extra not found' }, { status: 404 })
    }
    await syncAccountModules(admin, id)
    clearPlanCache(id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
