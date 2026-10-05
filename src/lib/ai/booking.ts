import type { SupabaseClient } from '@supabase/supabase-js'
import {
  businessDate,
  businessLocalToInstant,
  businessTime,
  businessToday,
  businessWeekday,
} from '@/lib/business-timezone'
import type { AvailabilityResult, BookingAppointment, TimeSlot } from './types'

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

interface DayWindow {
  dayStart: number
  dayEnd: number
  stepMs: number
  bufferMs: number
}

type Busy = { start: number; end: number }[]

/**
 * The business-hours window for one calendar date, as real UTC instants,
 * or null when the business is closed that day (weekday off, holiday, or
 * malformed hours). Shared by the "offer slots" and "validate a booking"
 * paths so both agree on what "closed" means.
 */
function dayWindow(settings: BookingSettingsRow, dateISO: string): DayWindow | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return null
  const slotMinutes = settings.slotMinutes && settings.slotMinutes > 0 ? settings.slotMinutes : 30
  const bufferMinutes = settings.bufferMinutes && settings.bufferMinutes > 0 ? settings.bufferMinutes : 0

  if (settings.holidays?.includes(dateISO)) return null

  const weekday = WEEKDAY_BY_JS_INDEX[businessWeekday(dateISO)]
  const hours = settings.hours?.[weekday]
  if (!hours) return null

  const dayStart = businessLocalToInstant(dateISO, hours.open)
  const dayEnd = businessLocalToInstant(dateISO, hours.close)
  if (Number.isNaN(dayStart.getTime()) || Number.isNaN(dayEnd.getTime()) || dayEnd <= dayStart) {
    return null
  }
  return {
    dayStart: dayStart.getTime(),
    dayEnd: dayEnd.getTime(),
    stepMs: slotMinutes * 60_000,
    bufferMs: bufferMinutes * 60_000,
  }
}

/** Non-cancelled bookings overlapping [fromISO, toISO) (business-local
 *  dates, `toISO` exclusive), or null on a query failure. */
async function loadBusy(
  db: SupabaseClient,
  accountId: string,
  fromISO: string,
  toISO: string,
): Promise<Busy | null> {
  const from = businessLocalToInstant(fromISO, '00:00').getTime()
  const to = businessLocalToInstant(toISO, '00:00').getTime()
  // Widen the window by a day on the left and filter in memory: a
  // booking that STARTED before the range can still run into it, and
  // `starts_at >= from` alone would miss it and hand the customer a slot
  // that is already taken.
  const { data, error } = await db
    .from('bookings')
    .select('starts_at, ends_at')
    .eq('account_id', accountId)
    .neq('status', 'cancelled')
    .gte('starts_at', new Date(from - 86_400_000).toISOString())
    .lt('starts_at', new Date(to).toISOString())
  if (error) return null
  return (data ?? [])
    .map((b: { starts_at: string; ends_at: string }) => ({
      start: new Date(b.starts_at).getTime(),
      end: new Date(b.ends_at).getTime(),
    }))
    .filter((b) => b.end > from)
}

function overlapsBusy(start: number, end: number, busy: Busy, bufferMs: number): boolean {
  return busy.some((b) => start < b.end + bufferMs && end + bufferMs > b.start)
}

function addDays(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b
}

/** Free, not-yet-started slots on one day's grid (opening time + n × slot). */
function freeSlotsOnDay(window: DayWindow, busy: Busy, now: number): TimeSlot[] {
  const slots: TimeSlot[] = []
  for (let t = window.dayStart; t + window.stepMs <= window.dayEnd; t += window.stepMs) {
    if (t < now) continue
    if (overlapsBusy(t, t + window.stepMs, busy, window.bufferMs)) continue
    slots.push({ startsAt: new Date(t).toISOString(), endsAt: new Date(t + window.stepMs).toISOString() })
  }
  return slots
}

/** How far before/after the requested date `checkAvailability` looks for
 *  alternatives when the requested day or time can't be booked. */
const SEARCH_DAYS_BEFORE = 7
const SEARCH_DAYS_AFTER = 14

/**
 * Find bookable appointment slots, crossing the account's configured
 * business hours against existing (non-cancelled) `bookings`.
 *
 * When the customer named a specific time, it reports whether exactly that
 * time is free and, either way, the open slots nearest to it — same day or
 * a nearby one — so the agent can offer real alternatives instead of a
 * dead end. Without a time it returns the first open slots of that date,
 * rolling forward to the next open days when the date is closed or full.
 * Best-effort like knowledge retrieval: any failure degrades to no slots
 * rather than throwing into the auto-reply path.
 *
 * `dateISO`, `preferredTime` and the configured open/close times are
 * business-local wall clock (America/Santo_Domingo), converted to real
 * instants explicitly so the result never depends on the host's `TZ`.
 */
export async function checkAvailability(
  db: SupabaseClient,
  accountId: string,
  dateISO: string,
  preferredTime?: string,
  k = 3,
): Promise<AvailabilityResult> {
  const time = preferredTime && /^\d{2}:\d{2}$/.test(preferredTime) ? preferredTime : undefined
  const empty: AvailabilityResult = time
    ? { requested: { date: dateISO, time, available: false }, slots: [] }
    : { slots: [] }
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return empty
    const settings = await loadBookingSettings(db, accountId)
    if (!settings) return empty

    const now = Date.now()
    const today = businessToday()
    const from = maxDate(today, time ? addDays(dateISO, -SEARCH_DAYS_BEFORE) : dateISO)
    const to = addDays(dateISO, SEARCH_DAYS_AFTER + 1)
    const busy = await loadBusy(db, accountId, from, to)
    if (!busy) return empty

    if (!time) {
      const slots: TimeSlot[] = []
      for (let d = from; d < to && slots.length < k; d = addDays(d, 1)) {
        const window = dayWindow(settings, d)
        if (window) slots.push(...freeSlotsOnDay(window, busy, now).slice(0, k - slots.length))
      }
      console.log('[ai booking] checkAvailability', { accountId, dateISO, slotsFound: slots.length })
      return { slots }
    }

    // Exactly the requested time, when it fits inside that day's hours and
    // nothing overlaps it. Not snapped to the slot grid — 10:15 is fine if
    // it's free.
    const target = businessLocalToInstant(dateISO, time).getTime()
    const requestedWindow = dayWindow(settings, dateISO)
    const requestedSlot: TimeSlot | null =
      requestedWindow &&
      target >= now &&
      target >= requestedWindow.dayStart &&
      target + requestedWindow.stepMs <= requestedWindow.dayEnd &&
      !overlapsBusy(target, target + requestedWindow.stepMs, busy, requestedWindow.bufferMs)
        ? {
            startsAt: new Date(target).toISOString(),
            endsAt: new Date(target + requestedWindow.stepMs).toISOString(),
          }
        : null

    const candidates: TimeSlot[] = []
    for (let d = from; d < to; d = addDays(d, 1)) {
      const window = dayWindow(settings, d)
      if (window) candidates.push(...freeSlotsOnDay(window, busy, now))
    }
    const distance = (s: TimeSlot) => Math.abs(new Date(s.startsAt).getTime() - target)
    const nearest = candidates
      .filter((s) => s.startsAt !== requestedSlot?.startsAt)
      .sort((a, b) => distance(a) - distance(b) || a.startsAt.localeCompare(b.startsAt))
      .slice(0, requestedSlot ? k - 1 : k)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))

    const slots = requestedSlot ? [requestedSlot, ...nearest] : nearest
    console.log('[ai booking] checkAvailability', {
      accountId,
      dateISO,
      time,
      requestedAvailable: !!requestedSlot,
      slotsFound: slots.length,
    })
    return { requested: { date: dateISO, time, available: !!requestedSlot }, slots }
  } catch (err) {
    console.error('[ai booking] checkAvailability failed:', err)
    return empty
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

  const settings = await loadBookingSettings(db, accountId)
  const date = businessDate(startsAt)
  const window = settings ? dayWindow(settings, date) : null
  if (!window) return 'the business is closed that day'
  if (start < window.dayStart || end > window.dayEnd) return 'that time is outside business hours'

  const busy = await loadBusy(db, accountId, date, addDays(date, 1))
  if (!busy) return 'the booking could not be checked'
  if (overlapsBusy(start, end, busy, window.bufferMs)) return 'that time is already taken'

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
