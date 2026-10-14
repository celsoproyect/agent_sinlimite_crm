import { NextResponse } from 'next/server'
import { toProperty } from '@/lib/real-estate/directory'
import { parsePropertyInput, propertiesDbError, propertiesGuard } from '@/lib/real-estate/api'

// Real estate module: edit / delete a listing (admins only). Visits
// booked for it keep their row (bookings.property_id is set null).

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const guard = await propertiesGuard('admin')
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const parsed = parsePropertyInput(await request.json().catch(() => null), true)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  if (Object.keys(parsed.input).length === 0) return NextResponse.json({ ok: true })

  const { data, error } = await ctx.supabase
    .from('properties')
    .update({ ...parsed.input, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('*')
  if (error) return propertiesDbError(error)
  if (!data?.length) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ property: toProperty(data[0] as Record<string, unknown>) })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const guard = await propertiesGuard('admin')
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const { data, error } = await ctx.supabase
    .from('properties')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('id')
  if (error) return propertiesDbError(error)
  if (!data?.length) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
