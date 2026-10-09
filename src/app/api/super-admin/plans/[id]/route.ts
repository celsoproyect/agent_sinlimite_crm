// ============================================================
// /api/super-admin/plans/[id]  (super admin only, migration 074)
//
//   PATCH  edit the plan; the accounts on it get the new modules and
//          limits right away
//   DELETE remove it; its accounts are left with no plan (no limits)
// ============================================================

import { NextResponse } from 'next/server'

import { requireSuperAdmin, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/super-admin/admin-client'
import { parsePlanInput } from '@/lib/plans/parse'
import {
  PLAN_COLUMNS,
  clearPlanCache,
  normalizePlan,
  syncAccountModules,
} from '@/lib/plans/server'

type Params = { params: Promise<{ id: string }> }

export async function PATCH(request: Request, { params }: Params) {
  try {
    await requireSuperAdmin()
    const { id } = await params
    const parsed = parsePlanInput(await request.json().catch(() => null))
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const admin = supabaseAdmin()
    const { data, error } = await admin
      .from('plans')
      .update({ ...parsed.value, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select(PLAN_COLUMNS)
    if (error) {
      console.error('[PATCH /api/super-admin/plans/:id] error:', error)
      return NextResponse.json({ error: 'Failed to save plan' }, { status: 500 })
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Plan not found' }, { status: 404 })
    }

    const { data: accounts } = await admin.from('accounts').select('id').eq('plan_id', id)
    clearPlanCache()
    for (const a of (accounts ?? []) as { id: string }[]) {
      await syncAccountModules(admin, a.id)
    }

    return NextResponse.json({ plan: normalizePlan(data[0] as Record<string, unknown>) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    await requireSuperAdmin()
    const { id } = await params
    const { data, error } = await supabaseAdmin().from('plans').delete().eq('id', id).select('id')
    if (error) {
      console.error('[DELETE /api/super-admin/plans/:id] error:', error)
      return NextResponse.json({ error: 'Failed to delete plan' }, { status: 500 })
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Plan not found' }, { status: 404 })
    }
    clearPlanCache()
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
