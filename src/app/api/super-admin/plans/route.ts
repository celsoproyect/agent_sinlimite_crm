// ============================================================
// /api/super-admin/plans  (super admin only, migration 074)
//
//   GET   every plan, with how many accounts are on each
//   POST  create a plan (limits blank = unlimited)
// ============================================================

import { NextResponse } from 'next/server'

import { requireSuperAdmin, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/super-admin/admin-client'
import { parsePlanInput } from '@/lib/plans/parse'
import { PLAN_COLUMNS, isMissingSchema, normalizePlan } from '@/lib/plans/server'

export async function GET() {
  try {
    await requireSuperAdmin()
    const admin = supabaseAdmin()
    const { data, error } = await admin
      .from('plans')
      .select(PLAN_COLUMNS)
      .order('sort_order', { ascending: true })
      .order('price', { ascending: true })
    if (error) {
      if (isMissingSchema(error.code)) {
        return NextResponse.json({ plans: [], migrated: false })
      }
      console.error('[GET /api/super-admin/plans] error:', error)
      return NextResponse.json({ error: 'Failed to load plans' }, { status: 500 })
    }

    const { data: accounts } = await admin.from('accounts').select('plan_id')
    const counts = new Map<string, number>()
    for (const a of (accounts ?? []) as { plan_id: string | null }[]) {
      if (a.plan_id) counts.set(a.plan_id, (counts.get(a.plan_id) ?? 0) + 1)
    }

    return NextResponse.json({
      migrated: true,
      plans: (data ?? []).map((row) => ({
        ...normalizePlan(row as Record<string, unknown>),
        account_count: counts.get((row as { id: string }).id) ?? 0,
      })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    await requireSuperAdmin()
    const parsed = parsePlanInput(await request.json().catch(() => null))
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const { data, error } = await supabaseAdmin()
      .from('plans')
      .insert(parsed.value)
      .select(PLAN_COLUMNS)
      .single()
    if (error) {
      if (isMissingSchema(error.code)) {
        return NextResponse.json(
          { error: 'Migration 074 has not run', code: 'plans_not_migrated' },
          { status: 503 },
        )
      }
      console.error('[POST /api/super-admin/plans] error:', error)
      return NextResponse.json({ error: 'Failed to create plan' }, { status: 500 })
    }
    return NextResponse.json({ plan: normalizePlan(data as Record<string, unknown>) })
  } catch (err) {
    return toErrorResponse(err)
  }
}
