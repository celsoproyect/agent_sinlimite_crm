import { NextResponse } from 'next/server'
import { parseTableInput, restaurantDbError, restaurantGuard } from '@/lib/restaurant/api'

// Restaurant module: edit / delete a table (admins only). A table with
// upcoming reservations can't be deleted, only deactivated.

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const guard = await restaurantGuard('admin')
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const parsed = parseTableInput(await request.json().catch(() => null), true)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  if (Object.keys(parsed.input).length === 0) return NextResponse.json({ ok: true })

  const { data, error } = await ctx.supabase
    .from('restaurant_tables')
    .update(parsed.input)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('*')
  if (error) return restaurantDbError(error)
  if (!data?.length) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ table: data[0] })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const guard = await restaurantGuard('admin')
  if ('response' in guard) return guard.response
  const { ctx } = guard

  // Deleting a table drops its booking_tables rows (ON DELETE CASCADE), so
  // a table that upcoming reservations still hold is only deactivated.
  const { data: held, error: heldError } = await ctx.supabase
    .from('booking_tables')
    .select('booking_id')
    .eq('table_id', id)
    .eq('released', false)
    .gt('ends_at', new Date().toISOString())
    .limit(1)
  if (heldError) return restaurantDbError(heldError)
  if (held?.length) return NextResponse.json({ error: 'table_in_use' }, { status: 409 })

  const { data, error } = await ctx.supabase
    .from('restaurant_tables')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('id')
  if (error) return restaurantDbError(error)
  if (!data?.length) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
