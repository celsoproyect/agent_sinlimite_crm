import { NextResponse } from 'next/server'
import {
  clinicAdmin,
  clinicDbError,
  loadProfessional,
  replaceProfessionalSpecialties,
} from '@/lib/clinic/api'
import { parseProfessionalInput } from '@/lib/clinic/input'

// Clinic module: create a doctor with their specialties (admins only).

export async function POST(request: Request) {
  const guard = await clinicAdmin()
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const parsed = parseProfessionalInput(await request.json().catch(() => null), false)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const { specialty_ids, ...columns } = parsed.input

  const { data, error } = await ctx.supabase
    .from('professionals')
    .insert({ account_id: ctx.accountId, ...columns })
    .select('id')
    .single()
  if (error) return clinicDbError(error)

  if (specialty_ids && specialty_ids.length > 0) {
    const linkError = await replaceProfessionalSpecialties(ctx.supabase, data.id, specialty_ids)
    if (linkError) return NextResponse.json({ error: linkError }, { status: 500 })
  }
  const professional = await loadProfessional(ctx.supabase, ctx.accountId, data.id)
  return NextResponse.json({ professional }, { status: 201 })
}
