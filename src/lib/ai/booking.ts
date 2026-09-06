import type { SupabaseClient } from '@supabase/supabase-js'
import {
  businessDate,
  businessLocalToInstant,
  businessTime,
  businessToday,
  businessWeekday,
} from '@/lib/business-timezone'
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
  holidays?: string[]
}

const WEEKDAY_LABEL: Record<Weekday, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
}
const WEEKDAY_ORDER: Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]

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
 * Human-readable weekly schedule + upcoming holiday closures, for the
 * system prompt — lets the model answer "what are your hours" directly
 * instead of only being able to look up slots for one specific date via
 * `check_availability`. Consecutive weekdays with identical hours (or
 * identical closed status) are collapsed into one range for readability.
 * Returns null when no hours are configured at all.
 */
export function formatBusinessHoursSummary(settings: BookingSettingsRow | null): string | null {
  if (!settings?.hours) return null

  const groups: { label: string; days: Weekday[] }[] = []
  for (const day of WEEKDAY_ORDER) {
    const hours = settings.hours[day]
    const label = hours ? `${hours.open}-${hours.close}` : 'closed'
    const last = groups[groups.length - 1]
    if (last && last.label === label) {
      last.days.push(day)
    } else {
      groups.push({ label, days: [day] })
    }
  }
  if (groups.length === 0) return null

  const lines = groups.map((g) => {
    const range =
      g.days.length > 1
        ? `${WEEKDAY_LABEL[g.days[0]]}-${WEEKDAY_LABEL[g.days[g.days.length - 1]]}`
        : WEEKDAY_LABEL[g.days[0]]
    return g.label === 'closed' ? `${range}: closed` : `${range}: ${g.label}`
  })

  let summary = `Weekly hours — ${lines.join('; ')}.`

  const todayIso = businessToday()
  const upcomingHolidays = (settings.holidays ?? []).filter((d) => d >= todayIso).sort()
  if (upcomingHolidays.length > 0) {
    summary += ` Also closed on these specific upcoming dates (holidays): ${upcomingHolidays.join(', ')}.`
  }
  return summary
}

/**
 * Load + format the account's business-hours summary in one call — the
 * convenience wrapper `auto-reply.ts` uses alongside `bookingEnabled`.
 */
export async function getBusinessHoursSummary(
  db: SupabaseClient,
  accountId: string,
): Promise<string | null> {
  try {
    const settings = await loadBookingSettings(db, accountId)
    return formatBusinessHoursSummary(settings)
  } catch {
    return null
  }
}

/**
 * The account's slot geometry for one calendar date: the business-hours
 * window (as real UTC instants), slot/buffer length, and the existing
 * bookings that overlap it. Returns null when the business is closed
 * that day (weekday off, holiday, or malformed hours) so both the
 * "offer slots" and the "validate a booking" paths agree on what
 * "closed" means instead of each re-deriving it.
 */
async function loadDayGeometry(
  db: SupabaseClient,
  accountId: string,
  dateISO: string,
): Promise<
  | {
      dayStart: number
      dayEnd: number
      stepMs: number
      bufferMs: number
      busy: { start: number; end: number }[]
    }
  | null
> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return null

  const settings = await loadBookingSettings(db, accountId)
  if (!settings) return null
  const slotMinutes = settings.slotMinutes && settings.slotMinutes > 0 ? settings.slotMinutes : 30
  const bufferMinutes = settings.bufferMinutes && settings.bufferMinutes > 0 ? settings.bufferMinutes : 0

  if (settings.holidays?.includes(dateISO)) {
    console.log('[ai booking] closed for holiday', { accountId, dateISO })
    return null
  }

  const weekday = WEEKDAY_BY_JS_INDEX[businessWeekday(dateISO)]
  const hours = settings.hours?.[weekday]
  if (!hours) {
    console.log('[ai booking] closed that weekday', { accountId, dateISO, weekday })
    return null // closed that day
  }

  const dayStart = businessLocalToInstant(dateISO, hours.open)
  const dayEnd = businessLocalToInstant(dateISO, hours.close)
  if (Number.isNaN(dayStart.getTime()) || Number.isNaN(dayEnd.getTime()) || dayEnd <= dayStart) {
    return null
  }

  // Widen the window by a day on each side and filter in memory: a
  // booking that STARTED before opening can still run into the day, and
  // `starts_at >= dayStart` alone would miss it and hand the customer a
  // slot that is already taken.
  const { data: existing, error: bookingsErr } = await db
    .from('bookings')
    .select('starts_at, ends_at')
    .eq('account_id', accountId)
    .neq('status', 'cancelled')
    .gte('starts_at', new Date(dayStart.getTime() - 86_400_000).toISOString())
    .lt('starts_at', dayEnd.toISOString())
  if (bookingsErr) return null

  const busy = (existing ?? [])
    .map((b: { starts_at: string; ends_at: string }) => ({
      start: new Date(b.starts_at).getTime(),
      end: new Date(b.ends_at).getTime(),
    }))
    .filter((b) => b.end > dayStart.getTime())

  return {
    dayStart: dayStart.getTime(),
    dayEnd: dayEnd.getTime(),
    stepMs: slotMinutes * 60_000,
    bufferMs: bufferMinutes * 60_000,
    busy,
  }
}

/**
 * Compute open appointment slots for one calendar date, crossing the
 * account's configured business hours against existing (non-cancelled)
 * `bookings`. Best-effort like knowledge/attachment retrieval — any
 * failure degrades to `[]` rather than throwing into the auto-reply path.
 *
 * `dateISO` and the configured open/close times are business-local wall
 * clock (America/Santo_Domingo); they are converted to real instants
 * explicitly, so the result no longer depends on the host's `TZ`.
 */
export async function checkAvailability(
  db: SupabaseClient,
  accountId: string,
  dateISO: string,
  k = 3,
): Promise<TimeSlot[]> {
  try {
    const day = await loadDayGeometry(db, accountId, dateISO)
    if (!day) return []

    const now = Date.now()
    const slots: TimeSlot[] = []

    for (let t = day.dayStart; t + day.stepMs <= day.dayEnd; t += day.stepMs) {
      if (t < now) continue
      const slotStart = t
      const slotEnd = t + day.stepMs
      const overlapsExisting = day.busy.some(
        (b) => slotStart < b.end + day.bufferMs && slotEnd + day.bufferMs > b.start,
      )
      if (!overlapsExisting) {
        slots.push({
          startsAt: new Date(slotStart).toISOString(),
          endsAt: new Date(slotEnd).toISOString(),
        })
        if (slots.length >= k) break
      }
    }
    console.log('[ai booking] checkAvailability: found slots', { accountId, dateISO, slotsFound: slots.length })
    return slots
  } catch (err) {
    console.error('[ai booking] checkAvailability failed:', err)
    return []
  }
}

/**
 * Re-check one specific appointment against the live schedule, right
 * before writing it.
 *
 * The model picks the slot, and until now nothing verified its pick —
 * `book_appointment` took whatever timestamps the model produced and
 * reported `confirmed: true` to it unconditionally, so a slot the model
 * reconstructed a turn later (from the wall-clock time it had quoted the
 * customer) could land outside opening hours, on a holiday, in the past,
 * or on top of an existing booking, and the customer was told it was
 * confirmed either way.
 *
 * Returns null when the slot is bookable, or a short reason the model
 * can act on ("that time is already taken") when it isn't.
 */
async function validateSlot(
  db: SupabaseClient,
  accountId: string,
  startsAt: string,
  endsAt: string,
): Promise<string | null> {
  const start = new Date(startsAt).getTime()
  const end = new Date(endsAt).getTime()

  if (start < Date.now()) return 'that time is in the past'

  const day = await loadDayGeometry(db, accountId, businessDate(startsAt))
  if (!day) return 'the business is closed that day'
  if (start < day.dayStart || end > day.dayEnd) return 'that time is outside business hours'

  const taken = day.busy.some((b) => start < b.end + day.bufferMs && end + day.bufferMs > b.start)
  if (taken) return 'that time is already taken'

  return null
}

/**
 * Validate + persist an appointment the model asked to book via the
 * `book_appointment` tool, and report back honestly.
 *
 * Runs INSIDE the tool call (not after the reply has already been sent)
 * so `{ confirmed: false, error }` reaches the model while it is still
 * writing its reply — it can then tell the customer the truth and offer
 * another time, instead of promising a booking that quietly failed to
 * save.
 *
 * Writes a real `bookings` row (`created_by = null`, distinguishing it
 * from human-created bookings) plus a `system_event` message so the
 * thread shows an inline annotation, matching the manual Agenda flow.
 */
export async function confirmAiBooking(
  db: SupabaseClient,
  args: {
    accountId: string
    contactId: string
    conversationId: string
    appointment: BookingAppointment
  },
): Promise<{ confirmed: boolean; error?: string }> {
  const { accountId, contactId, conversationId, appointment } = args

  try {
    const conflict = await validateSlot(db, accountId, appointment.startsAt, appointment.endsAt)
    if (conflict) {
      console.log('[ai booking] book_appointment rejected', { accountId, conflict, appointment })
      return { confirmed: false, error: conflict }
    }

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
      console.error('[ai booking] booking insert failed:', bookingErr)
      return { confirmed: false, error: 'the booking could not be saved' }
    }

    // Thread annotation is cosmetic — a failure here must not turn a
    // booking that really was saved into a "no" for the customer.
    try {
      await db.from('messages').insert({
        conversation_id: conversationId,
        sender_type: 'bot',
        content_type: 'system_event',
        content_text: `Booked ${appointment.service} for ${businessDate(appointment.startsAt)} ${businessTime(appointment.startsAt)}`,
        metadata: { kind: 'booking_created', ...appointment },
      })
    } catch (err) {
      console.error('[ai booking] booking system_event insert failed:', err)
    }

    console.log('[ai booking] booked', { accountId, contactId, startsAt: appointment.startsAt })
    return { confirmed: true }
  } catch (err) {
    console.error('[ai booking] confirmAiBooking failed:', err)
    return { confirmed: false, error: 'the booking could not be saved' }
  }
}
