import { NextResponse } from 'next/server'
import { eventsDbError, eventsGuard, loadManualEventDirectory } from '@/lib/events/api'
import { requestEvent } from '@/lib/events/engine'
import { EVENT_STATUS_FLOW } from '@/lib/events/settings'
import type { EventStatus } from '@/types'

// Events module: the event requests (bookings with kind 'event').
// GET ?from&to → { bookings } (ISO instants, both optional).
// POST → a request entered by the team.

export async function GET(request: Request) {
  const guard = await eventsGuard('any')
  if ('response' in guard) return guard.response
  const { supabase, accountId } = guard.ctx
  const { searchParams } = new URL(request.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  let query = supabase
    .from('bookings')
    .select('*, contact:contacts(*)')
    .eq('account_id', accountId)
    .eq('kind', 'event')
    .order('starts_at', { ascending: true })
  if (from) query = query.gte('starts_at', from)
  if (to) query = query.lte('starts_at', to)
  const { data, error } = await query
  if (error) return eventsDbError(error)
  return NextResponse.json({ bookings: data ?? [] })
}

const HOURS_MAX = 24

export async function POST(request: Request) {
  const guard = await eventsGuard('agent')
  if ('response' in guard) return guard.response
  const { supabase, accountId, userId } = guard.ctx

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const contactId = str(body.contact_id)
  const hallId = str(body.hall_id)
  const date = str(body.date)
  const time = str(body.time)
  const guests = Number(body.guests)
  const hours = body.hours === undefined || body.hours === '' || body.hours === null ? undefined : Number(body.hours)
  if (!contactId || !hallId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 })
  }
  if (!(guests >= 1)) return NextResponse.json({ error: 'invalid_guests' }, { status: 400 })
  if (hours !== undefined && !(hours > 0 && hours <= HOURS_MAX)) return NextResponse.json({ error: 'invalid_hours' }, { status: 400 })
  const status = EVENT_STATUS_FLOW.includes(body.status as EventStatus) ? (body.status as EventStatus) : undefined

  const dir = await loadManualEventDirectory(supabase, accountId)
  if (dir === 'needs_migration') return NextResponse.json({ error: 'needs_migration' }, { status: 503 })
  if (!dir) return NextResponse.json({ error: 'no_halls' }, { status: 409 })

  const { data: contact } = await supabase
    .from('contacts')
    .select('id, name, phone')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!contact) return NextResponse.json({ error: 'contact_not_found' }, { status: 404 })
  const c = contact as { id: string; name: string | null; phone: string | null }

  const result = await requestEvent(supabase, {
    accountId,
    contactId: c.id,
    dir,
    input: {
      hallId,
      packageId: str(body.package_id) || undefined,
      date,
      time,
      hours,
      guests,
      eventType: str(body.event_type) || undefined,
      customerName: c.name || c.phone || 'Cliente',
      customerPhone: c.phone,
      notes: str(body.notes) || null,
    },
    createdBy: userId,
    force: body.force === true,
    status,
  })
  if (!result.requested) return NextResponse.json({ error: 'unavailable', message: result.error }, { status: 409 })

  const { data: booking } = await supabase
    .from('bookings')
    .select('*, contact:contacts(*)')
    .eq('id', result.bookingId!)
    .maybeSingle()
  return NextResponse.json({ booking, reference: result.reference }, { status: 201 })
}
