import { NextResponse } from 'next/server'
import { businessLocalToInstant } from '@/lib/business-timezone'
import { eventsDbError, eventsGuard } from '@/lib/events/api'
import { depositFor } from '@/lib/events/input'
import { effectivePolicy, nextEventStatuses, normalizeEventSettings } from '@/lib/events/settings'
import type { EventHall, EventStatus } from '@/types'

// Events module: move an event along its pipeline (Solicitud → Cotizado →
// Depósito pagado → Confirmado → Realizado, or Cancelado), set its quote
// and deposit, or move it to another date/time.

interface EventRow {
  id: string
  kind?: string
  status: string
  event_status: EventStatus | null
  event_hall_id: string | null
  starts_at: string
  ends_at: string
}

function amount(value: unknown): number | null | undefined {
  if (value === null || value === '') return null
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const guard = await eventsGuard('agent')
  if ('response' in guard) return guard.response
  const { supabase, accountId } = guard.ctx

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'invalid_body' }, { status: 400 })

  const { data: current, error: loadError } = await supabase
    .from('bookings')
    .select('id, kind, status, event_status, event_hall_id, starts_at, ends_at')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (loadError) return eventsDbError(loadError)
  const row = current as EventRow | null
  if (!row || row.kind !== 'event') return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const [{ data: account }, { data: hallRow }] = await Promise.all([
    supabase.from('accounts').select('event_settings').eq('id', accountId).maybeSingle(),
    row.event_hall_id
      ? supabase.from('event_halls').select('requires_approval, deposit_percent').eq('id', row.event_hall_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ])
  const policy = effectivePolicy(
    normalizeEventSettings(account?.event_settings),
    hallRow as Pick<EventHall, 'requires_approval' | 'deposit_percent'> | null,
  )

  const update: Record<string, unknown> = {}

  if (body.event_status !== undefined) {
    const to = body.event_status as EventStatus
    const from: EventStatus = row.status === 'cancelled' ? 'cancelled' : (row.event_status ?? 'requested')
    // A deposit already marked paid stays a valid step even if the policy
    // changed since.
    const allowed = nextEventStatuses(from, { depositRequired: policy.depositRequired || from === 'quoted' })
    if (!allowed.includes(to)) {
      return NextResponse.json({ error: 'invalid_transition' }, { status: 409 })
    }
    update.event_status = to
    if (to === 'cancelled') update.status = 'cancelled'
    else if (to === 'completed') update.status = 'completed'
    if (to === 'deposit_paid') update.deposit_paid_at = new Date().toISOString()
  }
  if (body.status === 'no_show') update.status = 'no_show'

  if ('quote_amount' in body) {
    const quote = amount(body.quote_amount)
    if (quote === undefined) return NextResponse.json({ error: 'invalid_amount' }, { status: 400 })
    update.quote_amount = quote
    if (!('deposit_amount' in body)) update.deposit_amount = depositFor(quote, policy)
  }
  if ('deposit_amount' in body) {
    const deposit = amount(body.deposit_amount)
    if (deposit === undefined) return NextResponse.json({ error: 'invalid_amount' }, { status: 400 })
    update.deposit_amount = deposit
  }
  if (typeof body.notes === 'string' || body.notes === null) {
    update.notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim().slice(0, 2000) : null
  }

  let moved = false
  if (body.date !== undefined || body.time !== undefined || body.hours !== undefined) {
    const date = typeof body.date === 'string' ? body.date : ''
    const time = typeof body.time === 'string' ? body.time : ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
      return NextResponse.json({ error: 'invalid_date' }, { status: 400 })
    }
    const hours =
      body.hours === undefined || body.hours === ''
        ? (new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()) / 3_600_000
        : Number(body.hours)
    if (!(hours > 0 && hours <= 24)) return NextResponse.json({ error: 'invalid_hours' }, { status: 400 })
    const start = businessLocalToInstant(date, time).getTime()
    const startsAt = new Date(start).toISOString()
    const endsAt = new Date(start + hours * 3_600_000).toISOString()
    moved =
      new Date(startsAt).getTime() !== new Date(row.starts_at).getTime() ||
      new Date(endsAt).getTime() !== new Date(row.ends_at).getTime()
    if (moved) {
      update.starts_at = startsAt
      update.ends_at = endsAt
    }
  }

  if (Object.keys(update).length === 0) return NextResponse.json({ error: 'nothing_to_update' }, { status: 400 })
  update.updated_at = new Date().toISOString()

  const { data, error } = await supabase
    .from('bookings')
    .update(update)
    .eq('id', id)
    .eq('account_id', accountId)
    .select('*, contact:contacts(*)')
  if (error) return eventsDbError(error)
  if (!data?.length) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  // A new date gets its reminders again.
  if (moved) await supabase.from('booking_reminder_sends').delete().eq('booking_id', id)
  return NextResponse.json({ booking: data[0] })
}
