// ============================================================
// Agenda ⇄ Google Calendar.
//
// * Every CRM booking (AI or manual) is mirrored as an event in the
//   connected calendar: created, moved, cancelled or deleted with it.
//   The event id is kept in `bookings.google_event_id` (migration 065)
//   and the event carries `wacrmBookingId` in its private properties.
// * Busy events in that calendar block the AI's availability, so the
//   owner's personal appointments are never offered as free slots.
//
// Everything here is best-effort and never throws: a Google outage
// must not fail a booking, a reply or an availability check. Reads
// and writes use the service-role client because the connection table
// has no RLS policies (the refresh token never reaches a browser).
// ============================================================

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { BUSINESS_TIME_ZONE, businessLocalToInstant } from '@/lib/business-timezone'
import { bookingReference } from '@/lib/bookings/reference'
import { decrypt } from '@/lib/whatsapp/encryption'
import { accountModuleEnabled } from '@/lib/modules-server'
import { googleCalendarConfigured, refreshGoogleToken } from './oauth'

const API = 'https://www.googleapis.com/calendar/v3'
const CONNECTION_TTL_MS = 60_000

export interface GoogleConnection {
  accountId: string
  email: string | null
  calendarId: string
  refreshToken: string
}

type Cached<T> = { value: T; until: number }
const g = globalThis as {
  __gcalConnections?: Map<string, Cached<GoogleConnection | null>>
  __gcalTokens?: Map<string, Cached<string>>
}
const connections = (g.__gcalConnections ??= new Map())
const tokens = (g.__gcalTokens ??= new Map())

/** Forget cached state after connect/disconnect. */
export function forgetGoogleConnection(accountId: string) {
  connections.delete(accountId)
  tokens.delete(accountId)
}

export async function loadGoogleConnection(accountId: string): Promise<GoogleConnection | null> {
  if (!googleCalendarConfigured()) return null
  const hit = connections.get(accountId)
  if (hit && hit.until > Date.now()) return hit.value

  let value: GoogleConnection | null = null
  try {
    // A disabled module behaves as "not connected": no sync, no busy times.
    if (!(await accountModuleEnabled(supabaseAdmin(), accountId, 'google_calendar'))) {
      connections.set(accountId, { value: null, until: Date.now() + CONNECTION_TTL_MS })
      return null
    }
    const { data, error } = await supabaseAdmin()
      .from('google_calendar_connections')
      .select('account_id, google_email, calendar_id, refresh_token')
      .eq('account_id', accountId)
      .maybeSingle()
    // 42P01 / PGRST205: migration 065 not run yet — treat as not connected.
    if (!error && data) {
      value = {
        accountId,
        email: data.google_email,
        calendarId: data.calendar_id || 'primary',
        refreshToken: decrypt(data.refresh_token),
      }
    }
  } catch (err) {
    console.error('[gcal] load connection failed:', err)
  }
  connections.set(accountId, { value, until: Date.now() + CONNECTION_TTL_MS })
  return value
}

async function accessToken(conn: GoogleConnection): Promise<string> {
  const hit = tokens.get(conn.accountId)
  if (hit && hit.until > Date.now()) return hit.value
  const res = await refreshGoogleToken(conn.refreshToken)
  tokens.set(conn.accountId, { value: res.access_token, until: Date.now() + (res.expires_in - 120) * 1000 })
  return res.access_token
}

async function gcal(
  conn: GoogleConnection,
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string> } = {},
): Promise<Response> {
  const token = await accessToken(conn)
  const qs = init.query ? `?${new URLSearchParams(init.query).toString()}` : ''
  return fetch(`${API}/calendars/${encodeURIComponent(conn.calendarId)}${path}${qs}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })
}

// ------------------------------------------------------------------
// Busy times
// ------------------------------------------------------------------

interface GoogleEvent {
  id: string
  status?: string
  transparency?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  extendedProperties?: { private?: Record<string, string> }
}

/** Busy intervals from Google events. Skips cancelled and "free"
 *  (transparent) events and the CRM's own events, which the bookings
 *  table already covers. All-day events block whole business-local days. */
export function eventsToBusy(events: GoogleEvent[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  for (const e of events) {
    if (e.status === 'cancelled' || e.transparency === 'transparent') continue
    if (e.extendedProperties?.private?.wacrmBookingId) continue
    const start = e.start?.dateTime
      ? Date.parse(e.start.dateTime)
      : e.start?.date
        ? businessLocalToInstant(e.start.date, '00:00').getTime()
        : NaN
    const end = e.end?.dateTime
      ? Date.parse(e.end.dateTime)
      : e.end?.date
        ? businessLocalToInstant(e.end.date, '00:00').getTime()
        : NaN
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) out.push({ start, end })
  }
  return out
}

/** Busy intervals in the connected calendar between two instants; [] when
 *  not connected or on any error. */
export async function googleBusy(accountId: string, fromMs: number, toMs: number): Promise<{ start: number; end: number }[]> {
  const conn = await loadGoogleConnection(accountId)
  if (!conn) return []
  try {
    const events: GoogleEvent[] = []
    let pageToken: string | undefined
    for (let i = 0; i < 5; i++) {
      const res = await gcal(conn, '/events', {
        query: {
          timeMin: new Date(fromMs).toISOString(),
          timeMax: new Date(toMs).toISOString(),
          singleEvents: 'true',
          maxResults: '250',
          fields: 'items(id,status,transparency,start,end,extendedProperties),nextPageToken',
          ...(pageToken ? { pageToken } : {}),
        },
      })
      if (!res.ok) {
        console.error('[gcal] events.list failed:', res.status, await res.text().catch(() => ''))
        return []
      }
      const json = (await res.json()) as { items?: GoogleEvent[]; nextPageToken?: string }
      events.push(...(json.items ?? []))
      pageToken = json.nextPageToken
      if (!pageToken) break
    }
    return eventsToBusy(events)
  } catch (err) {
    console.error('[gcal] busy lookup failed:', err)
    return []
  }
}

// ------------------------------------------------------------------
// Booking → event
// ------------------------------------------------------------------

interface BookingRow {
  id: string
  account_id: string
  service: string
  starts_at: string
  ends_at: string
  status: string
  notes: string | null
  created_by: string | null
  customer_name?: string | null
  customer_phone?: string | null
  google_event_id: string | null
  /** Migration 068. */
  kind?: string | null
  is_sample?: boolean | null
  contact: { name: string | null; phone: string | null } | null
}

export function bookingToEvent(b: BookingRow) {
  const name = b.customer_name || b.contact?.name || ''
  const phone = b.customer_phone || b.contact?.phone || ''
  const description = [
    `Referencia: ${bookingReference(b.id, b.kind)}`,
    name && `Cliente: ${name}`,
    phone && `Teléfono: ${phone}`,
    b.notes && `Notas: ${b.notes}`,
    b.created_by ? 'Agendada desde el CRM' : 'Agendada por la IA',
  ]
    .filter(Boolean)
    .join('\n')
  return {
    summary: name ? `${b.service} — ${name}` : b.service,
    description,
    start: { dateTime: b.starts_at, timeZone: BUSINESS_TIME_ZONE },
    end: { dateTime: b.ends_at, timeZone: BUSINESS_TIME_ZONE },
    extendedProperties: { private: { wacrmBookingId: b.id } },
  }
}

async function loadBooking(bookingId: string): Promise<BookingRow | null> {
  const db = supabaseAdmin()
  // `*` brings customer_name/phone (062), kind and is_sample (068) when
  // they exist.
  const full = '*, contact:contacts(name, phone)'
  let { data, error } = await db.from('bookings').select(full).eq('id', bookingId).maybeSingle()
  if (error?.code === '42703') {
    // Migration 062 missing (customer_name/phone); google_event_id may
    // still exist. Without google_event_id we can't sync (no dedupe).
    ;({ data, error } = await db
      .from('bookings')
      .select('id, account_id, service, starts_at, ends_at, status, notes, created_by, google_event_id, contact:contacts(name, phone)')
      .eq('id', bookingId)
      .maybeSingle())
  }
  if (error) {
    if (error.code !== '42703') console.error('[gcal] load booking failed:', error)
    return null
  }
  // `*` doesn't fail when migration 065 is missing; without
  // google_event_id we can't sync (no dedupe).
  if (data && !('google_event_id' in data)) return null
  return data as unknown as BookingRow | null
}

async function saveEventId(bookingId: string, eventId: string | null) {
  const { data, error } = await supabaseAdmin()
    .from('bookings')
    .update({ google_event_id: eventId })
    .eq('id', bookingId)
    .select('id')
  if (error || !data?.length) console.error('[gcal] saving google_event_id failed:', error)
}

/**
 * Bring the Google event in line with the booking: insert it, update
 * it, or delete it once the booking is cancelled. Idempotent — safe to
 * call after any booking write.
 */
export async function syncBookingToGoogle(bookingId: string): Promise<void> {
  if (!googleCalendarConfigured()) return
  try {
    const booking = await loadBooking(bookingId)
    // Example bookings ("Cargar ejemplos") never reach the owner's calendar.
    if (!booking || booking.is_sample) return
    const conn = await loadGoogleConnection(booking.account_id)
    if (!conn) return

    if (booking.status === 'cancelled' || booking.status === 'no_show') {
      if (booking.google_event_id) {
        await deleteGoogleEvent(booking.account_id, booking.google_event_id)
        await saveEventId(booking.id, null)
      }
      return
    }

    const event = bookingToEvent(booking)
    if (booking.google_event_id) {
      const res = await gcal(conn, `/events/${encodeURIComponent(booking.google_event_id)}`, {
        method: 'PATCH',
        body: { ...event, status: 'confirmed' },
      })
      if (res.ok) return
      if (res.status !== 404 && res.status !== 410) {
        console.error('[gcal] events.patch failed:', res.status, await res.text().catch(() => ''))
        return
      }
      // Deleted in Google: create it again below.
    }
    const res = await gcal(conn, '/events', { method: 'POST', body: event })
    if (!res.ok) {
      console.error('[gcal] events.insert failed:', res.status, await res.text().catch(() => ''))
      return
    }
    const created = (await res.json()) as { id: string }
    await saveEventId(booking.id, created.id)
  } catch (err) {
    console.error('[gcal] sync failed for booking', bookingId, err)
  }
}

/** Delete one event (a booking that was hard-deleted or cancelled). */
export async function deleteGoogleEvent(accountId: string, eventId: string): Promise<void> {
  try {
    const conn = await loadGoogleConnection(accountId)
    if (!conn) return
    const res = await gcal(conn, `/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      console.error('[gcal] events.delete failed:', res.status, await res.text().catch(() => ''))
    }
  } catch (err) {
    console.error('[gcal] delete failed:', err)
  }
}

/** Push every upcoming, non-cancelled booking without an event (used
 *  right after connecting). Returns how many were synced. */
export async function syncUpcomingBookings(accountId: string): Promise<number> {
  const { data, error } = await supabaseAdmin()
    .from('bookings')
    .select('id')
    .eq('account_id', accountId)
    .neq('status', 'cancelled')
    .is('google_event_id', null)
    .gte('starts_at', new Date().toISOString())
    .order('starts_at', { ascending: true })
    .limit(500)
  if (error) {
    console.error('[gcal] upcoming bookings load failed:', error)
    return 0
  }
  for (const b of data ?? []) await syncBookingToGoogle(b.id)
  return data?.length ?? 0
}
