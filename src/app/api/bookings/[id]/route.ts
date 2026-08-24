import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

// Update / cancel a single booking. RLS (bookings_update/delete) already
// scopes to the caller's account — the explicit `account_id` filter below
// is defense in depth, matching quick-replies' [id] route.

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const update: Record<string, unknown> = {}
  if (typeof body.service === 'string') update.service = body.service
  if (typeof body.notes === 'string' || body.notes === null) update.notes = body.notes
  if (typeof body.starts_at === 'string') update.starts_at = body.starts_at
  if (typeof body.ends_at === 'string') update.ends_at = body.ends_at
  if (
    body.status === 'confirmed' ||
    body.status === 'cancelled' ||
    body.status === 'completed'
  ) {
    update.status = body.status
  }

  if (
    typeof update.starts_at === 'string' &&
    typeof update.ends_at === 'string' &&
    new Date(update.ends_at) <= new Date(update.starts_at)
  ) {
    return NextResponse.json(
      { error: 'ends_at must be after starts_at' },
      { status: 400 },
    )
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true })
  }

  const { data, error } = await ctx.supabase
    .from('bookings')
    .update(update)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('*, contact:contacts(*)')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ booking: data })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { error } = await ctx.supabase
    .from('bookings')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
