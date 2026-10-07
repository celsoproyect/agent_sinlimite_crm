import { NextResponse, after } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { accountModuleEnabled } from '@/lib/modules-server'
import { businessLocalToInstant } from '@/lib/business-timezone'
import { syncBookingToGoogle } from '@/lib/google-calendar/sync'
import { confirmTableReservation, getRestaurantDirectory } from '@/lib/restaurant/engine'
import { intIn, restaurantDbError, restaurantGuard, str } from '@/lib/restaurant/api'
import type { PreorderItem, TableSeating } from '@/types'

// Restaurant module (migration 068): table reservations.
// GET ?from&to → kind 'table' bookings with their contact and the tables
//   they hold (`table_ids`).
// POST → a reservation taken by the team. The length defaults to the
//   restaurant's (90 min unless changed) and can be anything within its
//   limits; tables are picked automatically unless `table_ids` is given.

export async function GET(request: Request) {
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }
  if (!(await accountModuleEnabled(ctx.supabase, ctx.accountId, 'restaurant'))) {
    return NextResponse.json({ error: 'module_disabled' }, { status: 403 })
  }
  const { searchParams } = new URL(request.url)
  let query = ctx.supabase
    .from('bookings')
    .select('*, contact:contacts(*), booking_tables(table_id, released)')
    .eq('account_id', ctx.accountId)
    .eq('kind', 'table')
    .order('starts_at', { ascending: true })
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  if (from) query = query.gte('starts_at', from)
  if (to) query = query.lte('starts_at', to)
  const { data, error } = await query
  if (error) return restaurantDbError(error)
  const reservations = (data ?? []).map((row) => {
    const { booking_tables, ...rest } = row as { booking_tables?: { table_id: string; released: boolean }[] }
    const held = booking_tables ?? []
    const live = held.filter((h) => !h.released)
    // A cancelled / no-show reservation released its tables: still show
    // which ones it had.
    return { ...rest, table_ids: (live.length ? live : held).map((h) => h.table_id) }
  })
  return NextResponse.json({ reservations })
}

function parsePreorder(raw: unknown): PreorderItem[] | null {
  if (!Array.isArray(raw)) return null
  const items = raw
    .map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : null))
    .filter((r): r is Record<string, unknown> => !!r && !!str(r.item, 120))
    .map((r) => ({ item: str(r.item, 120)!, qty: intIn(r.qty, 1, 999) ?? 1, notes: str(r.notes, 200) }))
    .slice(0, 50)
  return items.length ? items : null
}

export async function POST(request: Request) {
  const guard = await restaurantGuard('agent')
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  const contactId = str(body.contact_id, 64)
  const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null
  const time = typeof body.time === 'string' && /^\d{2}:\d{2}$/.test(body.time) ? body.time : null
  const partySize = intIn(body.party_size, 1, 500)
  if (!contactId || !date || !time || !partySize) {
    return NextResponse.json({ error: 'required_fields' }, { status: 400 })
  }
  const rawDuration = body.duration_minutes
  const durationMinutes = rawDuration == null || rawDuration === '' ? undefined : intIn(rawDuration, 15, 720)
  if (durationMinutes === null) return NextResponse.json({ error: 'invalid_duration' }, { status: 400 })
  const tableIds = Array.isArray(body.table_ids)
    ? [...new Set(body.table_ids.filter((id): id is string => typeof id === 'string' && !!id))]
    : []
  const seating: TableSeating = body.seating === 'separate' ? 'separate' : 'joined'

  const [dir, contactRes] = await Promise.all([
    getRestaurantDirectory(ctx.supabase, ctx.accountId),
    ctx.supabase.from('contacts').select('id, name, phone').eq('id', contactId).maybeSingle(),
  ])
  if (!dir) return NextResponse.json({ error: 'no_tables' }, { status: 409 })
  const contact = contactRes.data as { id: string; name: string | null; phone: string | null } | null
  if (!contact) return NextResponse.json({ error: 'contact_not_found' }, { status: 404 })

  const result = await confirmTableReservation(ctx.supabase, {
    accountId: ctx.accountId,
    contactId,
    dir,
    createdBy: ctx.userId,
    force: body.force === true,
    input: {
      startsAt: businessLocalToInstant(date, time).toISOString(),
      partySize,
      durationMinutes,
      customerName: contact.name?.trim() || contact.phone || 'Cliente',
      customerPhone: contact.phone,
      // The team already asked the customer (joined or separate tables).
      seating,
      customerAgreed: true,
      occasion: str(body.occasion, 120),
      notes: str(body.notes, 1000),
      preorder: parsePreorder(body.preorder),
      ...(tableIds.length ? { tableIds } : {}),
    },
  })
  if (!result.confirmed || !result.bookingId) {
    return NextResponse.json({ error: 'unavailable', message: result.error ?? null }, { status: 409 })
  }
  const bookingId = result.bookingId
  after(() => syncBookingToGoogle(bookingId))
  return NextResponse.json(
    { ok: true, id: bookingId, reference: result.reference, tables: result.tables, duration_minutes: result.durationMinutes },
    { status: 201 },
  )
}
