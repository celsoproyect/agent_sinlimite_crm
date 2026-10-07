import { NextResponse } from 'next/server'
import { intIn, restaurantDbError, restaurantGuard, str } from '@/lib/restaurant/api'

// Restaurant module, waitlist: change an entry's status (waiting →
// notified → seated, or cancelled / expired) or details, or delete it.
// Marking it "notified" only records it: the team writes to the customer.

const STATUSES = new Set(['waiting', 'notified', 'seated', 'cancelled', 'expired'])

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const guard = await restaurantGuard('agent', { waitlist: true })
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  const update: Record<string, unknown> = {}
  if (typeof body.status === 'string') {
    if (!STATUSES.has(body.status)) return NextResponse.json({ error: 'invalid_status' }, { status: 400 })
    update.status = body.status
  }
  if (body.party_size !== undefined) {
    const n = intIn(body.party_size, 1, 500)
    if (!n) return NextResponse.json({ error: 'invalid_party' }, { status: 400 })
    update.party_size = n
  }
  if ('preferred_time' in body) update.preferred_time = str(body.preferred_time, 20)
  if ('notes' in body) update.notes = str(body.notes, 500)
  if (Object.keys(update).length === 0) return NextResponse.json({ ok: true })
  update.updated_at = new Date().toISOString()

  const { data, error } = await ctx.supabase
    .from('restaurant_waitlist')
    .update(update)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('*')
  if (error) return restaurantDbError(error)
  if (!data?.length) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ entry: data[0] })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const guard = await restaurantGuard('agent', { waitlist: true })
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const { data, error } = await ctx.supabase
    .from('restaurant_waitlist')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('id')
  if (error) return restaurantDbError(error)
  if (!data?.length) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
