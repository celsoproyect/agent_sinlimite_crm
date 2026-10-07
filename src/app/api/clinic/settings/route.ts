import { NextResponse } from 'next/server'
import { clinicAdmin, clinicDbError } from '@/lib/clinic/api'
import { parseClinicSettingsInput } from '@/lib/clinic/input'

// Clinic module: `accounts.clinic_settings` (migration 067) — whether the
// AI agent asks for the health insurance and which insurers are accepted.
// Read through /api/clinic/directory; saved here (admins only).

export async function PATCH(request: Request) {
  const guard = await clinicAdmin()
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const parsed = parseClinicSettingsInput(await request.json().catch(() => null))
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const { data, error } = await ctx.supabase
    .from('accounts')
    .update({ clinic_settings: parsed.input })
    .eq('id', ctx.accountId)
    .select('clinic_settings')
  if (error) return clinicDbError(error)
  if (!data || data.length === 0) return NextResponse.json({ error: 'not_saved' }, { status: 403 })
  return NextResponse.json({ settings: parsed.input })
}
