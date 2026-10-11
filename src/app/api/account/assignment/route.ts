// ============================================================
// /api/account/assignment  (module `auto_assign`, migration 076)
//
// GET  (any member): the account's assignment settings plus the team
//      with each person's "Disponible" switch, for Configuración →
//      Miembros del equipo.
// PUT  (admin+): save the settings (mode, rotation order, reassign
//      minutes, assign while the AI is off).
//
// Before migration 076 both answer `migrated: false` / 503
// `assignment_not_migrated`, and the settings card says so.
// ============================================================

import { NextResponse } from 'next/server'

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { withoutSupportVisitors } from '@/lib/support/sessions'
import { accountModuleEnabled } from '@/lib/modules-server'
import { normalizeAssignmentSettings } from '@/lib/assignment/settings'

function missingColumn(code: string | undefined): boolean {
  return code === '42703' || code === 'PGRST204'
}

interface MemberRow {
  user_id: string
  full_name: string | null
  email: string | null
  account_role: string
  is_available: boolean | null
}

export async function GET() {
  try {
    const { accountId } = await getCurrentAccount()
    const db = supabaseAdmin()
    const [{ data: account, error: accErr }, { data: people, error: peopleErr }] = await Promise.all([
      db.from('accounts').select('assignment_settings').eq('id', accountId).maybeSingle(),
      db
        .from('profiles')
        .select('user_id, full_name, email, account_role, is_available')
        .eq('account_id', accountId)
        .order('created_at', { ascending: true }),
    ])
    if (missingColumn(accErr?.code) || missingColumn(peopleErr?.code)) {
      return NextResponse.json({ migrated: false, settings: normalizeAssignmentSettings(null), members: [] })
    }
    if (accErr || peopleErr) throw accErr ?? peopleErr
    const team = await withoutSupportVisitors(db, accountId, (people ?? []) as MemberRow[])
    return NextResponse.json({
      migrated: true,
      module_enabled: await accountModuleEnabled(db, accountId, 'auto_assign'),
      settings: normalizeAssignmentSettings(account?.assignment_settings),
      members: team
        .filter((p) => p.account_role !== 'viewer')
        .map((p) => ({
          user_id: p.user_id,
          full_name: p.full_name || p.email || '',
          role: p.account_role,
          is_available: p.is_available !== false,
        })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(req: Request) {
  try {
    const { accountId } = await requireRole('admin')
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
    }
    const settings = normalizeAssignmentSettings(body)
    const db = supabaseAdmin()

    // The rotation only keeps people of this account.
    if (settings.members.length) {
      const { data: rows } = await db
        .from('profiles')
        .select('user_id, account_role')
        .eq('account_id', accountId)
        .in('user_id', settings.members)
      const valid = new Set(
        ((rows ?? []) as { user_id: string; account_role: string }[])
          .filter((r) => r.account_role !== 'viewer')
          .map((r) => r.user_id),
      )
      settings.members = settings.members.filter((id) => valid.has(id))
    }

    const { data, error } = await db
      .from('accounts')
      .update({ assignment_settings: settings })
      .eq('id', accountId)
      .select('id')
    if (missingColumn(error?.code)) {
      return NextResponse.json({ error: 'assignment_not_migrated' }, { status: 503 })
    }
    if (error) throw error
    if (!data?.length) return NextResponse.json({ error: 'not_saved' }, { status: 500 })
    return NextResponse.json({ settings })
  } catch (err) {
    return toErrorResponse(err)
  }
}
