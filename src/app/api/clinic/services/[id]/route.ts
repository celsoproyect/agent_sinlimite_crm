import { NextResponse } from 'next/server'
import { clinicAdmin, clinicDbError } from '@/lib/clinic/api'
import { parseServiceInput } from '@/lib/clinic/input'

// Clinic module: edit / delete a service (admins only). Bookings made for
// it keep their service name; only the link is cleared (ON DELETE SET NULL).

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const guard = await clinicAdmin()
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const parsed = parseServiceInput(await request.json().catch(() => null), true)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  if (Object.keys(parsed.input).length === 0) return NextResponse.json({ ok: true })

  const { data, error } = await ctx.supabase
    .from('clinic_services')
    .update({ ...parsed.input, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('*')
  if (error) return clinicDbError(error)
  if (!data || data.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ service: data[0] })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const guard = await clinicAdmin()
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const { data, error } = await ctx.supabase
    .from('clinic_services')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('id')
  if (error) return clinicDbError(error)
  if (!data || data.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
