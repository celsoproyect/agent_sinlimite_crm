import type { SupabaseClient } from '@supabase/supabase-js'
import {
  businessDate,
  businessLocalToInstant,
  businessTime,
  businessToday,
  businessWeekday,
} from '@/lib/business-timezone'
import { bookingReference, phonesMatch, referenceMatches } from '@/lib/bookings/reference'
import { googleBusy, syncBookingToGoogle } from '@/lib/google-calendar/sync'
import type { AvailabilityResult, BookingAppointment, ManagedBooking, TimeSlot } from './types'

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
 *  dates, `toISO` exclusive), or null on a query failure. `excludeId`
 *  leaves one booking out — the one being moved, when rescheduling, so
 *  it doesn't block its own neighbouring slots. */
async function loadBusy(
  db: SupabaseClient,
  accountId: string,
  fromISO: string,
  toISO: string,
  excludeId?: string,
): Promise<Busy | null> {
  const from = businessLocalToInstant(fromISO, '00:00').getTime()
  const to = businessLocalToInstant(toISO, '00:00').getTime()
  // Widen the window by a day on the left and filter in memory: a
  // booking that STARTED before the range can still run into it, and
  // `starts_at >= from` alone would miss it and hand the customer a slot
  // that is already taken.
  const { data, error } = await db
    .from('bookings')
    .select('id, starts_at, ends_at')
    .eq('account_id', accountId)
    .neq('status', 'cancelled')
    .gte('starts_at', new Date(from - 86_400_000).toISOString())
    .lt('starts_at', new Date(to).toISOString())
  if (error) return null
  const own = (data ?? [])
    .filter((b: { id?: string }) => !excludeId || b.id !== excludeId)
    .map((b: { starts_at: string; ends_at: string }) => ({
      start: new Date(b.starts_at).getTime(),
      end: new Date(b.ends_at).getTime(),
    }))
    .filter((b) => b.end > from)
  // The owner's own events in a connected Google Calendar block slots
  // too ([] when not connected or Google fails).
  const google = await googleBusy(accountId, from, to)
  return [...own, ...google]
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
  excludeId?: string,
): Promise<string | null> {
  const start = new Date(startsAt).getTime()
  const end = new Date(endsAt).getTime()

  if (start < Date.now()) return 'that time is in the past'

  const settings = await loadBookingSettings(db, accountId)
  const date = businessDate(startsAt)
  const window = settings ? dayWindow(settings, date) : null
  if (!window) return 'the business is closed that day'
  if (start < window.dayStart || end > window.dayEnd) return 'that time is outside business hours'

  const busy = await loadBusy(db, accountId, date, addDays(date, 1), excludeId)
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
): Promise<{ confirmed: boolean; error?: string; reference?: string }> {
  const { accountId, contactId, conversationId, appointment } = args

  try {
    const conflict = await validateSlot(db, accountId, appointment.startsAt, appointment.endsAt)
    if (conflict) {
      console.log('[ai booking] book_appointment rejected', { accountId, conflict, appointment })
      return { confirmed: false, error: conflict }
    }

    const row = {
      account_id: accountId,
      contact_id: contactId,
      conversation_id: conversationId,
      service: appointment.service,
      starts_at: appointment.startsAt,
      ends_at: appointment.endsAt,
      notes: appointment.notes ?? null,
      created_by: null,
    }
    let { data: inserted, error: bookingErr } = await db
      .from('bookings')
      .insert({
        ...row,
        customer_name: appointment.customerName ?? null,
        customer_phone: appointment.customerPhone ?? null,
      })
      .select('id')
      .single()
    if (bookingErr?.code === '42703') {
      // Migration 062 not applied yet: keep the name/phone in the notes so
      // they aren't lost.
      const extra = [appointment.customerName, appointment.customerPhone].filter(Boolean).join(' · ')
      ;({ data: inserted, error: bookingErr } = await db
        .from('bookings')
        .insert({ ...row, notes: [extra, appointment.notes].filter(Boolean).join(' — ') || null })
        .select('id')
        .single())
    }
    if (bookingErr || !inserted) {
      console.error('[ai booking] booking insert failed:', bookingErr)
      return { confirmed: false, error: 'the booking could not be saved' }
    }
    const reference = bookingReference((inserted as { id: string }).id)
    void syncBookingToGoogle((inserted as { id: string }).id)

    // Thread annotation is cosmetic — a failure here must not turn a
    // booking that really was saved into a "no" for the customer.
    try {
      await db.from('messages').insert({
        conversation_id: conversationId,
        sender_type: 'bot',
        content_type: 'system_event',
        content_text: `Booked ${appointment.service} for ${businessDate(appointment.startsAt)} ${businessTime(appointment.startsAt)} (${reference})`,
        metadata: { kind: 'booking_created', ...appointment, reference },
      })
    } catch (err) {
      console.error('[ai booking] booking system_event insert failed:', err)
    }

    console.log('[ai booking] booked', { accountId, contactId, startsAt: appointment.startsAt, reference })
    return { confirmed: true, reference }
  } catch (err) {
    console.error('[ai booking] confirmAiBooking failed:', err)
    return { confirmed: false, error: 'the booking could not be saved' }
  }
}

// ------------------------------------------------------------
// Finding, moving and cancelling an existing appointment.
//
// The customer identifies their appointment by the phone number they
// booked with (plus the reference code when they have it). The phone is
// asked for explicitly because WhatsApp doesn't always tell us the
// sender's number (username-only users, migration 054). Bookings made
// from this same contact also match, so appointments booked before
// customer_phone existed can still be found.
// ------------------------------------------------------------

interface CustomerBookingRow {
  id: string
  contact_id: string
  service: string
  starts_at: string
  ends_at: string
  customer_name?: string | null
  customer_phone?: string | null
  contact?: { name: string | null; phone: string | null } | null
}

async function loadCustomerBookings(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  phone: string,
): Promise<CustomerBookingRow[] | null> {
  const base = 'id, contact_id, service, starts_at, ends_at, contact:contacts(name, phone)'
  const query = (columns: string) =>
    db
      .from('bookings')
      .select(columns)
      .eq('account_id', accountId)
      .eq('status', 'confirmed')
      .gt('starts_at', new Date().toISOString())
      .order('starts_at', { ascending: true })
      .limit(500)
  let { data, error } = await query(`${base}, customer_name, customer_phone`)
  if (error?.code === '42703') ({ data, error } = await query(base))
  if (error) {
    console.error('[ai booking] loadCustomerBookings failed:', error)
    return null
  }
  return ((data ?? []) as unknown as CustomerBookingRow[]).filter(
    (b) =>
      b.contact_id === contactId ||
      phonesMatch(b.customer_phone, phone) ||
      phonesMatch(b.contact?.phone, phone),
  )
}

function toManaged(b: CustomerBookingRow): ManagedBooking {
  return {
    reference: bookingReference(b.id),
    service: b.service,
    startsAt: b.starts_at,
    endsAt: b.ends_at,
    date: businessDate(b.starts_at),
    time: businessTime(b.starts_at),
    customerName: b.customer_name || b.contact?.name || null,
  }
}

/** Upcoming confirmed appointments booked with this phone number (or
 *  from this same contact). */
export async function findCustomerBookings(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; phone: string },
): Promise<ManagedBooking[]> {
  const rows = await loadCustomerBookings(db, args.accountId, args.contactId, args.phone)
  return (rows ?? []).map(toManaged)
}

/** Pick the one booking a reschedule/cancel refers to, or explain why
 *  it can't be picked. */
async function pickCustomerBooking(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; phone: string; reference?: string },
): Promise<{ booking: CustomerBookingRow } | { error: string; appointments?: ManagedBooking[] }> {
  const rows = await loadCustomerBookings(db, args.accountId, args.contactId, args.phone)
  if (!rows) return { error: 'the appointments could not be looked up' }
  if (rows.length === 0) {
    return { error: 'no upcoming appointment was found for that phone number' }
  }
  const reference = args.reference
  if (reference) {
    const match = rows.find((b) => referenceMatches(b.id, reference))
    if (match) return { booking: match }
    return {
      error: 'no upcoming appointment with that reference was found for that phone number',
      appointments: rows.map(toManaged),
    }
  }
  if (rows.length === 1) return { booking: rows[0] }
  return {
    error: 'several appointments match; ask the customer which one (by reference, date or service)',
    appointments: rows.map(toManaged),
  }
}

async function annotate(
  db: SupabaseClient,
  conversationId: string,
  text: string,
  metadata: Record<string, unknown>,
) {
  try {
    await db.from('messages').insert({
      conversation_id: conversationId,
      sender_type: 'bot',
      content_type: 'system_event',
      content_text: text,
      metadata,
    })
  } catch (err) {
    console.error('[ai booking] system_event insert failed:', err)
  }
}

/**
 * Move an existing appointment to a new time — the same `bookings` row,
 * so the old time is freed instead of a second booking being created.
 * Reminder sends are cleared so the reminders fire again for the new
 * time.
 */
export async function rescheduleAiBooking(
  db: SupabaseClient,
  args: {
    accountId: string
    contactId: string
    conversationId: string
    phone: string
    reference?: string
    startsAt: string
    endsAt: string
  },
): Promise<{
  rescheduled: boolean
  error?: string
  appointments?: ManagedBooking[]
  appointment?: BookingAppointment
}> {
  const { accountId, conversationId, startsAt, endsAt } = args
  try {
    const picked = await pickCustomerBooking(db, args)
    if ('error' in picked) return { rescheduled: false, ...picked }
    const booking = picked.booking

    const conflict = await validateSlot(db, accountId, startsAt, endsAt, booking.id)
    if (conflict) return { rescheduled: false, error: conflict }

    const { data: rows, error } = await db
      .from('bookings')
      .update({ starts_at: startsAt, ends_at: endsAt, updated_at: new Date().toISOString() })
      .eq('id', booking.id)
      .eq('account_id', accountId)
      .select('id')
    if (error || !rows?.length) {
      console.error('[ai booking] reschedule update failed:', error)
      return { rescheduled: false, error: 'the appointment could not be changed' }
    }

    await db.from('booking_reminder_sends').delete().eq('booking_id', booking.id)
    void syncBookingToGoogle(booking.id)

    const reference = bookingReference(booking.id)
    const from = `${businessDate(booking.starts_at)} ${businessTime(booking.starts_at)}`
    const to = `${businessDate(startsAt)} ${businessTime(startsAt)}`
    await annotate(db, conversationId, `Rescheduled ${booking.service} (${reference}) from ${from} to ${to}`, {
      kind: 'booking_rescheduled',
      reference,
      previousStartsAt: booking.starts_at,
      startsAt,
      endsAt,
    })
    console.log('[ai booking] rescheduled', { accountId, reference, startsAt })
    return {
      rescheduled: true,
      appointment: {
        startsAt,
        endsAt,
        service: booking.service,
        reference,
        customerName: booking.customer_name || booking.contact?.name || undefined,
      },
    }
  } catch (err) {
    console.error('[ai booking] rescheduleAiBooking failed:', err)
    return { rescheduled: false, error: 'the appointment could not be changed' }
  }
}

/** Cancel an existing appointment the customer identified by phone (and
 *  reference). */
export async function cancelAiBooking(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; conversationId: string; phone: string; reference?: string },
): Promise<{ cancelled: boolean; error?: string; appointments?: ManagedBooking[]; reference?: string }> {
  try {
    const picked = await pickCustomerBooking(db, args)
    if ('error' in picked) return { cancelled: false, ...picked }
    const booking = picked.booking

    const { data: rows, error } = await db
      .from('bookings')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', booking.id)
      .eq('account_id', args.accountId)
      .select('id')
    if (error || !rows?.length) {
      console.error('[ai booking] cancel update failed:', error)
      return { cancelled: false, error: 'the appointment could not be cancelled' }
    }
    void syncBookingToGoogle(booking.id)

    const reference = bookingReference(booking.id)
    await annotate(
      db,
      args.conversationId,
      `Cancelled ${booking.service} (${reference}) of ${businessDate(booking.starts_at)} ${businessTime(booking.starts_at)}`,
      { kind: 'booking_cancelled', reference },
    )
    console.log('[ai booking] cancelled', { accountId: args.accountId, reference })
    return { cancelled: true, reference }
  } catch (err) {
    console.error('[ai booking] cancelAiBooking failed:', err)
    return { cancelled: false, error: 'the appointment could not be cancelled' }
  }
}
