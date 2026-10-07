import { NextResponse } from 'next/server'
import { parseAreaInput, restaurantDbError, restaurantGuard } from '@/lib/restaurant/api'

// Restaurant module: edit / delete a area (admins only).

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const guard = await restaurantGuard('admin')
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const parsed = parseAreaInput(await request.json().catch(() => null), true)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  if (Object.keys(parsed.input).length === 0) return NextResponse.json({ ok: true })

  const { data, error } = await ctx.supabase
    .from('restaurant_areas')
    .update(parsed.input)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('*')
  if (error) return restaurantDbError(error)
  if (!data?.length) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ area: data[0] })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const guard = await restaurantGuard('admin')
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const { data, error } = await ctx.supabase
    .from('restaurant_areas')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('id')
  if (error) return restaurantDbError(error)
  if (!data?.length) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
