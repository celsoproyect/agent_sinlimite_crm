import { NextResponse, after } from 'next/server'
import { businessLocalToInstant } from '@/lib/business-timezone'
import { syncBookingToGoogle } from '@/lib/google-calendar/sync'
import { getRestaurantDirectory, rescheduleTableReservation } from '@/lib/restaurant/engine'
import { intIn, restaurantDbError, restaurantGuard, str } from '@/lib/restaurant/api'
import type { TableSeating } from '@/types'

// Restaurant module: change a table reservation.
// - date + time: moves it (same row), re-picking free tables.
// - duration_minutes: a longer or shorter stay. The tables follow through
//   the bookings_sync_tables trigger, and a clash with the next
//   reservation at that table answers 409 table_busy.
// - status (confirmed | completed | cancelled | no_show): cancelled and
//   no-show release the tables.
// - notes, occasion, party_size.

const STATUSES = new Set(['confirmed', 'completed', 'cancelled', 'no_show'])

interface Current {
  id: string
  starts_at: string
  ends_at: string
  party_size: number | null
  seating: TableSeating | null
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const guard = await restaurantGuard('agent')
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'invalid_json' }, { status: 400 })

  const { data: row, error: loadError } = await ctx.supabase
    .from('bookings')
    .select('id, starts_at, ends_at, party_size, seating')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .eq('kind', 'table')
    .maybeSingle()
  if (loadError) return restaurantDbError(loadError)
  const current = row as Current | null
  if (!current) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const currentMinutes = Math.round((new Date(current.ends_at).getTime() - new Date(current.starts_at).getTime()) / 60_000)
  const rawDuration = body.duration_minutes
  const hasDuration = rawDuration !== undefined && rawDuration !== null && rawDuration !== ''
  const duration = hasDuration ? intIn(rawDuration, 15, 720) : currentMinutes
  if (duration === null) return NextResponse.json({ error: 'invalid_duration' }, { status: 400 })
  const partySize = body.party_size === undefined ? (current.party_size ?? 1) : intIn(body.party_size, 1, 500)
  if (partySize === null) return NextResponse.json({ error: 'invalid_party' }, { status: 400 })

  const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null
  const time = typeof body.time === 'string' && /^\d{2}:\d{2}$/.test(body.time) ? body.time : null
  const moving = !!(date && time)
  if (moving) {
    const dir = await getRestaurantDirectory(ctx.supabase, ctx.accountId)
    if (!dir) return NextResponse.json({ error: 'no_tables' }, { status: 409 })
    const moved = await rescheduleTableReservation(ctx.supabase, {
      accountId: ctx.accountId,
      dir,
      bookingId: id,
      startsAt: businessLocalToInstant(date, time).toISOString(),
      partySize,
      durationMinutes: duration,
      customerAgreed: true,
      seating: current.seating === 'separate' ? 'separate' : 'joined',
    })
    if (!moved.rescheduled) return NextResponse.json({ error: 'unavailable', message: moved.error ?? null }, { status: 409 })
  }

  const update: Record<string, unknown> = {}
  if (hasDuration && !moving) {
    update.ends_at = new Date(new Date(current.starts_at).getTime() + duration * 60_000).toISOString()
  }
  if (typeof body.status === 'string') {
    if (!STATUSES.has(body.status)) return NextResponse.json({ error: 'invalid_status' }, { status: 400 })
    update.status = body.status
  }
  if ('notes' in body) update.notes = str(body.notes, 1000)
  if ('occasion' in body) update.occasion = str(body.occasion, 120)
  if (body.party_size !== undefined) update.party_size = partySize

  if (Object.keys(update).length > 0) {
    update.updated_at = new Date().toISOString()
    const { data, error } = await ctx.supabase
      .from('bookings')
      .update(update)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id')
    if (error) return restaurantDbError(error)
    if (!data?.length) return NextResponse.json({ error: 'not_saved' }, { status: 403 })
  }

  after(() => syncBookingToGoogle(id))
  return NextResponse.json({ ok: true })
}
