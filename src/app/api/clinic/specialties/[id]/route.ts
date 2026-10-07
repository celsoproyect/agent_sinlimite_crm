import { NextResponse } from 'next/server'
import { clinicAdmin, clinicDbError } from '@/lib/clinic/api'
import { parseSpecialtyInput } from '@/lib/clinic/input'

// Clinic module: rename / delete a specialty (admins only). Deleting it
// removes it from every doctor (ON DELETE CASCADE on the join table).

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const guard = await clinicAdmin()
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const parsed = parseSpecialtyInput(await request.json().catch(() => null), true)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  if (Object.keys(parsed.input).length === 0) return NextResponse.json({ ok: true })

  const { data, error } = await ctx.supabase
    .from('specialties')
    .update({ ...parsed.input, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('*')
  if (error) return clinicDbError(error)
  if (!data || data.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ specialty: data[0] })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const guard = await clinicAdmin()
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const { data, error } = await ctx.supabase
    .from('specialties')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('id')
  if (error) return clinicDbError(error)
  if (!data || data.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
