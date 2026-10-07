import { NextResponse } from 'next/server'
import {
  clinicAdmin,
  clinicDbError,
  loadProfessional,
  replaceProfessionalSpecialties,
} from '@/lib/clinic/api'
import { parseProfessionalInput } from '@/lib/clinic/input'

// Clinic module: update / delete a doctor (admins only). `specialty_ids`,
// when sent, replaces the doctor's specialties. Deleting a doctor keeps
// their past appointments (bookings.professional_id goes NULL); to stop
// new bookings while keeping history, set `active: false` instead.

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const guard = await clinicAdmin()
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const parsed = parseProfessionalInput(await request.json().catch(() => null), true)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const { specialty_ids, ...columns } = parsed.input

  const { data, error } = await ctx.supabase
    .from('professionals')
    .update({ ...columns, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('id')
  if (error) return clinicDbError(error)
  if (!data || data.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  if (specialty_ids) {
    const linkError = await replaceProfessionalSpecialties(ctx.supabase, id, specialty_ids)
    if (linkError) return NextResponse.json({ error: linkError }, { status: 500 })
  }
  const professional = await loadProfessional(ctx.supabase, ctx.accountId, id)
  return NextResponse.json({ professional })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const guard = await clinicAdmin()
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const { data, error } = await ctx.supabase
    .from('professionals')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('id')
  if (error) return clinicDbError(error)
  if (!data || data.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
