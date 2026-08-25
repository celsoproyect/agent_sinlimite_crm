import type { SupabaseClient } from '@supabase/supabase-js'
import type { BookingAppointment, TimeSlot } from './types'

type Weekday =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday'

const WEEKDAY_BY_JS_INDEX: Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]

interface BookingSettingsRow {
  slotMinutes?: number
  bufferMinutes?: number
  hours?: Partial<Record<Weekday, { open: string; close: string } | null>>
}

async function loadBookingSettings(
  db: SupabaseClient,
  accountId: string,
): Promise<BookingSettingsRow | null> {
  const { data, error } = await db
    .from('accounts')
    .select('booking_settings')
    .eq('id', accountId)
    .maybeSingle()
  if (error || !data) return null
  return (data.booking_settings ?? {}) as BookingSettingsRow
}

/**
 * Whether the account has configured at least one open business-hours
 * day — cheap gate for `bookingAvailable` in the system prompt and for
 * skipping the `check_availability`/`book_appointment` tools entirely
 * when no owner has set up hours yet. Mirrors `getAttachmentRoster`'s gating.
 */
export async function bookingEnabled(db: SupabaseClient, accountId: string): Promise<boolean> {
  try {
    const settings = await loadBookingSettings(db, accountId)
    return !!settings?.hours && Object.values(settings.hours).some((h) => !!h)
  } catch {
    return false
  }
}

/**
 * Compute open appointment slots for one calendar date, crossing the
 * account's configured business hours against existing (non-cancelled)
 * `bookings`. Best-effort like knowledge/attachment retrieval — any
 * failure degrades to `[]` rather than throwing into the auto-reply path.
 *
 * Dates/times are interpreted as local wall-clock time (no per-account
 * timezone is stored), matching how the Agenda UI builds `starts_at`/
 * `ends_at` from its date + time inputs.
 */
export async function checkAvailability(
  db: SupabaseClient,
  accountId: string,
  dateISO: string,
  k = 3,
): Promise<TimeSlot[]> {
  try {
    const date = new Date(`${dateISO}T00:00:00`)
    if (Number.isNaN(date.getTime())) return []

    const settings = await loadBookingSettings(db, accountId)
    if (!settings) return []
    const slotMinutes = settings.slotMinutes && settings.slotMinutes > 0 ? settings.slotMinutes : 30
    const bufferMinutes = settings.bufferMinutes && settings.bufferMinutes > 0 ? settings.bufferMinutes : 0

    const weekday = WEEKDAY_BY_JS_INDEX[date.getDay()]
    const hours = settings.hours?.[weekday]
    if (!hours) return [] // closed that day

    const dayStart = new Date(`${dateISO}T${hours.open}:00`)
    const dayEnd = new Date(`${dateISO}T${hours.close}:00`)
    if (Number.isNaN(dayStart.getTime()) || Number.isNaN(dayEnd.getTime()) || dayEnd <= dayStart) {
      return []
    }

    const { data: existing, error: bookingsErr } = await db
      .from('bookings')
      .select('starts_at, ends_at')
      .eq('account_id', accountId)
      .neq('status', 'cancelled')
      .gte('starts_at', dayStart.toISOString())
      .lt('starts_at', dayEnd.toISOString())
    if (bookingsErr) return []

    const busy = (existing ?? []).map((b: { starts_at: string; ends_at: string }) => ({
      start: new Date(b.starts_at).getTime(),
      end: new Date(b.ends_at).getTime(),
    }))

    const stepMs = slotMinutes * 60_000
    const bufferMs = bufferMinutes * 60_000
    const now = Date.now()
    const slots: TimeSlot[] = []

    for (let t = dayStart.getTime(); t + stepMs <= dayEnd.getTime(); t += stepMs) {
      if (t < now) continue
      const slotStart = t
      const slotEnd = t + stepMs
      const overlapsExisting = busy.some(
        (b) => slotStart < b.end + bufferMs && slotEnd + bufferMs > b.start,
      )
      if (!overlapsExisting) {
        slots.push({
          startsAt: new Date(slotStart).toISOString(),
          endsAt: new Date(slotEnd).toISOString(),
        })
        if (slots.length >= k) break
      }
    }
    return slots
  } catch (err) {
    console.error('[ai booking] checkAvailability failed:', err)
    return []
  }
}

/**
 * Persist an appointment the AI confirmed via `book_appointment`:
 * a real `bookings` row (`created_by = null`, distinguishing it from
 * human-created bookings) plus a `system_event` message so the thread
 * shows an inline annotation, matching the manual Agenda flow's shape.
 * Best-effort — errors are logged and swallowed by the caller
 * (auto-reply must never fail the customer-facing text send over this).
 */
export async function insertAiBooking(
  db: SupabaseClient,
  args: {
    accountId: string
    contactId: string
    conversationId: string
    appointment: BookingAppointment
  },
): Promise<void> {
  const { accountId, contactId, conversationId, appointment } = args

  const { error: bookingErr } = await db.from('bookings').insert({
    account_id: accountId,
    contact_id: contactId,
    conversation_id: conversationId,
    service: appointment.service,
    starts_at: appointment.startsAt,
    ends_at: appointment.endsAt,
    notes: appointment.notes ?? null,
    created_by: null,
  })
  if (bookingErr) {
    throw new Error(`booking insert failed: ${bookingErr.message}`)
  }

  await db.from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'bot',
    content_type: 'system_event',
    content_text: `Booked ${appointment.service} for ${appointment.startsAt}`,
    metadata: { kind: 'booking_created', ...appointment },
  })
}
