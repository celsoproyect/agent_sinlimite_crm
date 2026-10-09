// ============================================================
// POST /api/super-admin/accounts/[id]/extras  (super admin only, 074)
//
// Adds a resource or a module to one account on top of its plan:
//   { resource, quantity | module_key, duration: permanent | month |
//     until, until?: YYYY-MM-DD, note? }
// ============================================================

import { NextResponse } from 'next/server'

import { requireSuperAdmin, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/super-admin/admin-client'
import { parseExtraInput } from '@/lib/plans/parse'
import { clearPlanCache, isMissingSchema, syncAccountModules } from '@/lib/plans/server'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params) {
  try {
    const { userId } = await requireSuperAdmin()
    const { id } = await params
    const parsed = parseExtraInput(await request.json().catch(() => null))
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const admin = supabaseAdmin()
    const { data, error } = await admin
      .from('account_extras')
      .insert({ ...parsed.value, account_id: id, created_by: userId })
      .select('id, resource, quantity, module_key, expires_at, note, created_at')
      .single()
    if (error) {
      if (isMissingSchema(error.code)) {
        return NextResponse.json(
          { error: 'Migration 074 has not run', code: 'plans_not_migrated' },
          { status: 503 },
        )
      }
      console.error('[POST /api/super-admin/accounts/:id/extras] error:', error)
      return NextResponse.json({ error: 'Failed to add the extra' }, { status: 500 })
    }

    await syncAccountModules(admin, id)
    clearPlanCache(id)
    return NextResponse.json({ extra: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
