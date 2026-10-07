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
import {
  getClinicDirectory,
  isOnTimeOff,
  professionalOffersService,
  resolveProfessional,
  resolveService,
  searchProfessionals,
  type ClinicDirectory,
  type ClinicProfessional,
  type ClinicService,
} from '@/lib/clinic/directory'
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
  /** Optional name per holiday date ("2026-12-25" → "Navidad"). */
  holidayNames?: Record<string, string>
  /** Clinic module, not stored: the doctor's days off (inclusive ranges). */
  timeOff?: { from: string; to: string }[]
  /** Clinic module, not stored: the length of the service being booked,
   *  when it differs from the slot grid. */
  durationMinutes?: number
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
    const listed = upcomingHolidays.map((d) => holidayLabel(settings, d))
    summary += ` Also closed on these specific upcoming dates (holidays): ${listed.join(', ')}. Never book, reschedule or promise an appointment on a holiday: offer another day.`
  }
  return summary
}

/** "2026-12-25 (Navidad)", or just the date when it has no name. */
function holidayLabel(settings: BookingSettingsRow, dateISO: string): string {
  const name = settings.holidayNames?.[dateISO]?.trim()
  return name ? `${dateISO} (${name})` : dateISO
}

/** The holiday on `dateISO`, or null when it is not one. */
function holidayOn(settings: BookingSettingsRow | null, dateISO: string): { date: string; name?: string } | null {
  if (!settings?.holidays?.includes(dateISO)) return null
  const name = settings.holidayNames?.[dateISO]?.trim()
  return name ? { date: dateISO, name } : { date: dateISO }
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
  /** Distance between slot starts (the slot length). */
  stepMs: number
  /** Length of the appointment being looked for: a service's own length
   *  in clinic mode, else the slot length. */
  durationMs: number
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
  if (settings.timeOff?.some((r) => dateISO >= r.from && dateISO <= r.to)) return null

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
    durationMs: (settings.durationMinutes && settings.durationMinutes > 0 ? settings.durationMinutes : slotMinutes) * 60_000,
    bufferMs: bufferMinutes * 60_000,
  }
}

interface BookedRow {
  start: number
  end: number
  professionalId: string | null
}

/** Non-cancelled bookings overlapping [fromISO, toISO) (business-local
 *  dates, `toISO` exclusive), or null on a query failure. `excludeId`
 *  leaves one booking out — the one being moved, when rescheduling, so
 *  it doesn't block its own neighbouring slots. `withProfessional` also
 *  reads each booking's doctor (clinic module, migration 066). */
async function loadBookedRows(
  db: SupabaseClient,
  accountId: string,
  fromISO: string,
  toISO: string,
  excludeId: string | undefined,
  withProfessional: boolean,
): Promise<BookedRow[] | null> {
  const from = businessLocalToInstant(fromISO, '00:00').getTime()
  const to = businessLocalToInstant(toISO, '00:00').getTime()
  // Widen the window by a day on the left and filter in memory: a
  // booking that STARTED before the range can still run into it, and
  // `starts_at >= from` alone would miss it and hand the customer a slot
  // that is already taken.
  const { data, error } = await db
    .from('bookings')
    .select(withProfessional ? 'id, starts_at, ends_at, professional_id' : 'id, starts_at, ends_at')
    .eq('account_id', accountId)
    .neq('status', 'cancelled')
    .gte('starts_at', new Date(from - 86_400_000).toISOString())
    .lt('starts_at', new Date(to).toISOString())
  if (error) return null
  return ((data ?? []) as unknown as { id: string; starts_at: string; ends_at: string; professional_id?: string | null }[])
    .filter((b) => !excludeId || b.id !== excludeId)
    .map((b) => ({
      start: new Date(b.starts_at).getTime(),
      end: new Date(b.ends_at).getTime(),
      professionalId: b.professional_id ?? null,
    }))
    .filter((b) => b.end > from)
}

/** Busy times on the single shared agenda: every booking plus the
 *  owner's own events in a connected Google Calendar ([] when not
 *  connected or Google fails). */
async function loadBusy(
  db: SupabaseClient,
  accountId: string,
  fromISO: string,
  toISO: string,
  excludeId?: string,
): Promise<Busy | null> {
  const rows = await loadBookedRows(db, accountId, fromISO, toISO, excludeId, false)
  if (!rows) return null
  const from = businessLocalToInstant(fromISO, '00:00').getTime()
  const to = businessLocalToInstant(toISO, '00:00').getTime()
  const google = await googleBusy(accountId, from, to)
  return [...rows, ...google]
}

/** One doctor's busy times: only their own appointments. The owner's
 *  Google Calendar is not applied — it isn't any one doctor's agenda. */
function professionalBusy(rows: BookedRow[], professionalId: string): Busy {
  return rows.filter((r) => r.professionalId === professionalId)
}

/** The business settings with a doctor's own hours, slot length and days
 *  off on top, plus the length of the service being booked. */
function settingsFor(
  settings: BookingSettingsRow,
  professional: ClinicProfessional | null,
  service: ClinicService | null = null,
): BookingSettingsRow {
  if (!professional) return service ? { ...settings, durationMinutes: service.durationMinutes } : settings
  return {
    ...settings,
    hours: professional.hours ?? settings.hours,
    slotMinutes: professional.slotMinutes ?? settings.slotMinutes,
    timeOff: professional.timeOff ?? [],
    ...(service ? { durationMinutes: service.durationMinutes } : {}),
  }
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
  for (let t = window.dayStart; t + window.durationMs <= window.dayEnd; t += window.stepMs) {
    if (t < now) continue
    if (overlapsBusy(t, t + window.durationMs, busy, window.bufferMs)) continue
    slots.push({ startsAt: new Date(t).toISOString(), endsAt: new Date(t + window.durationMs).toISOString() })
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
  clinic: ClinicAvailabilityOptions = {},
): Promise<AvailabilityResult> {
  const time = preferredTime && /^\d{2}:\d{2}$/.test(preferredTime) ? preferredTime : undefined
  const empty: AvailabilityResult = time
    ? { requested: { date: dateISO, time, available: false }, slots: [] }
    : { slots: [] }
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return empty
    if (clinic.directory) {
      return await clinicAvailability(db, accountId, dateISO, time, k, clinic.directory, clinic, empty)
    }
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
      return withHoliday({ slots }, settings, dateISO)
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
    return withHoliday({ requested: { date: dateISO, time, available: !!requestedSlot }, slots }, settings, dateISO)
  } catch (err) {
    console.error('[ai booking] checkAvailability failed:', err)
    return empty
  }
}

/** Mark the result when the asked-for date is a holiday, so the model
 *  tells the customer why and offers the slots of other days. */
function withHoliday(result: AvailabilityResult, settings: BookingSettingsRow, dateISO: string): AvailabilityResult {
  const holiday = holidayOn(settings, dateISO)
  return holiday ? { ...result, holiday } : result
}

/** Clinic module: which doctor's agenda to search. With neither field,
 *  every active doctor's. */
export interface ClinicAvailabilityOptions {
  directory?: ClinicDirectory | null
  /** A doctor's id (or a name matching exactly one doctor). */
  professionalId?: string
  /** Search every doctor with this specialty. */
  specialty?: string
  /** A service's id (or exact name): only doctors who offer it, slots of
   *  its length (migration 067). */
  serviceId?: string
}

/** The doctors `check_availability` should search, or why it can't. */
export function pickProfessionals(
  directory: ClinicDirectory,
  professionalId?: string,
  specialty?: string,
): { professionals: ClinicProfessional[] } | { error: string } {
  if (professionalId?.trim()) {
    const professional = resolveProfessional(directory, professionalId)
    if (!professional) {
      return {
        error: `unknown professional_id "${professionalId}": use a professional_id from the doctor list or from find_professionals`,
      }
    }
    return { professionals: [professional] }
  }
  if (specialty?.trim()) {
    const professionals = searchProfessionals(directory, { specialty })
    if (professionals.length === 0) {
      return {
        error: `no doctor offers "${specialty}". Specialties available: ${directory.specialties.join(', ') || 'none listed'}`,
      }
    }
    return { professionals }
  }
  return { professionals: directory.professionals }
}

/** The service `check_availability`/`book_appointment` named, or why it
 *  can't be used. Null when none was named. */
function pickService(
  directory: ClinicDirectory,
  serviceId: string | undefined,
): { service: ClinicService } | { error: string } | null {
  if (!serviceId?.trim()) return null
  const service = resolveService(directory, serviceId)
  if (service) return { service }
  const names = (directory.services ?? []).map((s) => s.name).join(', ')
  return { error: `unknown service_id "${serviceId}": use a service_id from the services list${names ? ` (${names})` : ''}` }
}

/** Take up to `n` slots in order, preferring times not already taken by
 *  `seen` or an earlier pick — so three doctors free at 09:00 don't crowd
 *  out 09:30 and 10:00 — then fill up with the rest. */
function pickVaried(slots: TimeSlot[], n: number, seen: Set<string> = new Set()): TimeSlot[] {
  if (n <= 0) return []
  const times = new Set(seen)
  const picked: TimeSlot[] = []
  for (const s of slots) {
    if (picked.length >= n) break
    if (times.has(s.startsAt)) continue
    times.add(s.startsAt)
    picked.push(s)
  }
  for (const s of slots) {
    if (picked.length >= n) break
    if (!picked.includes(s)) picked.push(s)
  }
  return picked
}

function bySlotStart(a: TimeSlot, b: TimeSlot): number {
  return a.startsAt.localeCompare(b.startsAt) || (a.professionalName ?? '').localeCompare(b.professionalName ?? '')
}

/** `checkAvailability` for the clinic module: the same search run on each
 *  doctor's own agenda and hours, every slot tagged with its doctor. */
async function clinicAvailability(
  db: SupabaseClient,
  accountId: string,
  dateISO: string,
  time: string | undefined,
  k: number,
  directory: ClinicDirectory,
  options: ClinicAvailabilityOptions,
  empty: AvailabilityResult,
): Promise<AvailabilityResult> {
  const picked = pickProfessionals(directory, options.professionalId, options.specialty)
  if ('error' in picked) return { ...empty, error: picked.error }
  const service = pickService(directory, options.serviceId)
  if (service && 'error' in service) return { ...empty, error: service.error }
  const offering = service ? picked.professionals.filter((p) => professionalOffersService(p, service.service)) : picked.professionals
  if (offering.length === 0) {
    return { ...empty, error: `none of those doctors offers "${service?.service.name}"; search by its specialty instead` }
  }
  const settings = await loadBookingSettings(db, accountId)
  if (!settings) return empty

  const now = Date.now()
  const today = businessToday()
  const from = maxDate(today, time ? addDays(dateISO, -SEARCH_DAYS_BEFORE) : dateISO)
  const to = addDays(dateISO, SEARCH_DAYS_AFTER + 1)
  const rows = await loadBookedRows(db, accountId, from, to, undefined, true)
  if (!rows) return empty

  const agendas = offering.map((p) => ({
    professional: p,
    settings: settingsFor(settings, p, service?.service ?? null),
    busy: professionalBusy(rows, p.id),
  }))
  const tag = (slot: TimeSlot, p: ClinicProfessional): TimeSlot => ({
    ...slot,
    professionalId: p.id,
    professionalName: p.name,
  })
  const slotsOn = (d: string) =>
    agendas
      .flatMap(({ professional, settings: s, busy }) => {
        const window = dayWindow(s, d)
        return window ? freeSlotsOnDay(window, busy, now).map((slot) => tag(slot, professional)) : []
      })
      .sort(bySlotStart)

  if (!time) {
    const slots: TimeSlot[] = []
    for (let d = from; d < to && slots.length < k; d = addDays(d, 1)) {
      slots.push(...pickVaried(slotsOn(d), k - slots.length))
    }
    console.log('[ai booking] checkAvailability (clinic)', { accountId, dateISO, doctors: agendas.length, slotsFound: slots.length })
    return withHoliday({ slots }, settings, dateISO)
  }

  const target = businessLocalToInstant(dateISO, time).getTime()
  let requestedSlot: TimeSlot | null = null
  for (const { professional, settings: s, busy } of agendas) {
    const window = dayWindow(s, dateISO)
    if (
      window &&
      target >= now &&
      target >= window.dayStart &&
      target + window.durationMs <= window.dayEnd &&
      !overlapsBusy(target, target + window.durationMs, busy, window.bufferMs)
    ) {
      requestedSlot = tag(
        { startsAt: new Date(target).toISOString(), endsAt: new Date(target + window.durationMs).toISOString() },
        professional,
      )
      break
    }
  }

  const candidates: TimeSlot[] = []
  for (let d = from; d < to; d = addDays(d, 1)) candidates.push(...slotsOn(d))
  const distance = (s: TimeSlot) => Math.abs(new Date(s.startsAt).getTime() - target)
  const nearest = pickVaried(
    candidates
      .filter((s) => !(s.startsAt === requestedSlot?.startsAt && s.professionalId === requestedSlot?.professionalId))
      .sort((a, b) => distance(a) - distance(b) || bySlotStart(a, b)),
    requestedSlot ? k - 1 : k,
    new Set(requestedSlot ? [requestedSlot.startsAt] : []),
  ).sort(bySlotStart)

  const slots = requestedSlot ? [requestedSlot, ...nearest] : nearest
  console.log('[ai booking] checkAvailability (clinic)', {
    accountId,
    dateISO,
    time,
    doctors: agendas.length,
    requestedAvailable: !!requestedSlot,
    slotsFound: slots.length,
  })
  return withHoliday({ requested: { date: dateISO, time, available: !!requestedSlot }, slots }, settings, dateISO)
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
  professional: ClinicProfessional | null = null,
): Promise<string | null> {
  const start = new Date(startsAt).getTime()
  const end = new Date(endsAt).getTime()

  if (start < Date.now()) return 'that time is in the past'

  const loaded = await loadBookingSettings(db, accountId)
  const settings = loaded ? settingsFor(loaded, professional) : null
  const date = businessDate(startsAt)
  const holiday = holidayOn(loaded, date)
  if (holiday) return `${holidayLabel(loaded ?? {}, date)} is a holiday: the business is closed that day, offer another day`
  if (professional && isOnTimeOff(professional, date)) return `${professional.name} is not available that day (time off)`
  const window = settings ? dayWindow(settings, date) : null
  if (!window) return professional ? `${professional.name} does not work that day` : 'the business is closed that day'
  if (start < window.dayStart || end > window.dayEnd) {
    return professional ? `that time is outside the hours of ${professional.name}` : 'that time is outside business hours'
  }

  let busy: Busy | null
  if (professional) {
    const rows = await loadBookedRows(db, accountId, date, addDays(date, 1), excludeId, true)
    busy = rows ? professionalBusy(rows, professional.id) : null
  } else {
    busy = await loadBusy(db, accountId, date, addDays(date, 1), excludeId)
  }
  if (!busy) return 'the booking could not be checked'
  if (overlapsBusy(start, end, busy, window.bufferMs)) return 'that time is already taken'

  return null
}

export type ScheduleProblem = 'holiday' | 'day_off' | 'time_off' | 'outside_hours'

/**
 * Whether a manual booking (Agenda form, bookings API) falls on an open
 * day and inside the hours: the doctor's in clinic mode, else the
 * business's. Null when it does, or when there is nothing to check
 * against (no hours saved, unknown doctor). Overlaps are not checked
 * here — the exclusion constraint does that for doctors.
 */
export async function checkBookingSchedule(
  db: SupabaseClient,
  accountId: string,
  professionalId: string | null,
  startsAt: string,
  endsAt: string,
): Promise<ScheduleProblem | null> {
  try {
    const loaded = await loadBookingSettings(db, accountId)
    const date = businessDate(startsAt)
    if (holidayOn(loaded, date)) return 'holiday'

    let settings: BookingSettingsRow | null = loaded
    if (professionalId) {
      const directory = await getClinicDirectory(db, accountId)
      const professional = directory?.professionals.find((p) => p.id === professionalId)
      if (professional) {
        if (isOnTimeOff(professional, date)) return 'time_off'
        if (!loaded?.hours && !professional.hours) return null
        settings = settingsFor(loaded ?? {}, professional)
      }
    }
    if (!settings?.hours || !Object.values(settings.hours).some((h) => !!h)) return null

    const window = dayWindow(settings, date)
    if (!window) return 'day_off'
    const start = new Date(startsAt).getTime()
    const end = new Date(endsAt).getTime()
    if (start < window.dayStart || end > window.dayEnd) return 'outside_hours'
    return null
  } catch (err) {
    console.error('[ai booking] checkBookingSchedule failed:', err)
    return null
  }
}

/** Postgres exclusion violation: the doctor already has an overlapping
 *  appointment (bookings_no_professional_overlap, migration 066). */
const OVERLAP_VIOLATION = '23P01'

const PROFESSIONAL_REQUIRED =
  'professional_id is required: pass the professional_id of the doctor of the slot the customer chose (from check_availability or the doctor list).'

/** The doctor an appointment is with, in clinic mode: the one asked for,
 *  else `fallbackId` (the doctor it already had), else the only doctor. */
function appointmentProfessional(
  directory: ClinicDirectory,
  requested: string | undefined,
  fallbackId?: string | null,
): { professional: ClinicProfessional } | { error: string } {
  if (requested?.trim()) {
    const professional = resolveProfessional(directory, requested)
    return professional
      ? { professional }
      : { error: `unknown professional_id "${requested}": use a professional_id from the doctor list or from find_professionals` }
  }
  const fallback = fallbackId ? directory.professionals.find((p) => p.id === fallbackId) : undefined
  if (fallback) return { professional: fallback }
  if (directory.professionals.length === 1) return { professional: directory.professionals[0] }
  return { error: PROFESSIONAL_REQUIRED }
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
    /** Clinic module: the appointment must be with one of these doctors. */
    directory?: ClinicDirectory | null
  },
): Promise<{ confirmed: boolean; error?: string; reference?: string; professional?: string }> {
  const { accountId, contactId, conversationId, appointment, directory } = args

  try {
    let professional: ClinicProfessional | null = null
    let service: ClinicService | null = null
    let endsAt = appointment.endsAt
    const insurance = appointment.insurance?.trim() || null
    if (directory) {
      const picked = appointmentProfessional(directory, appointment.professionalId)
      if ('error' in picked) return { confirmed: false, error: picked.error }
      professional = picked.professional
      const pickedService = pickService(directory, appointment.serviceId)
      if (pickedService && 'error' in pickedService) return { confirmed: false, error: pickedService.error }
      service = pickedService?.service ?? null
      if (service && !professionalOffersService(professional, service)) {
        return { confirmed: false, error: `${professional.name} does not offer "${service.name}"` }
      }
      // The service decides how long the appointment is.
      if (service) endsAt = new Date(new Date(appointment.startsAt).getTime() + service.durationMinutes * 60_000).toISOString()
      if (directory.insurance?.ask && !insurance) {
        return {
          confirmed: false,
          error: 'insurance is required: ask the customer which health insurance (ARS) they will use and their affiliate number, or "privado" if they pay themselves',
        }
      }
    }
    const conflict = await validateSlot(db, accountId, appointment.startsAt, endsAt, undefined, professional)
    if (conflict) {
      console.log('[ai booking] book_appointment rejected', { accountId, conflict, appointment })
      return { confirmed: false, error: conflict }
    }

    const serviceName = service?.name ?? appointment.service
    const row = {
      account_id: accountId,
      contact_id: contactId,
      conversation_id: conversationId,
      service: serviceName,
      starts_at: appointment.startsAt,
      ends_at: endsAt,
      notes: appointment.notes ?? null,
      created_by: null,
      ...(professional ? { professional_id: professional.id } : {}),
    }
    const customer = {
      customer_name: appointment.customerName ?? null,
      customer_phone: appointment.customerPhone ?? null,
    }
    const clinicColumns = service || insurance ? { clinic_service_id: service?.id ?? null, insurance } : null
    let { data: inserted, error: bookingErr } = await db
      .from('bookings')
      .insert({ ...row, ...customer, ...(clinicColumns ?? {}) })
      .select('id')
      .single()
    if (bookingErr?.code === '42703' && clinicColumns) {
      // Migration 067 not applied yet: keep the insurance in the notes.
      const notes = [insurance ? `Seguro: ${insurance}` : null, appointment.notes].filter(Boolean).join(' — ') || null
      ;({ data: inserted, error: bookingErr } = await db
        .from('bookings')
        .insert({ ...row, ...customer, notes })
        .select('id')
        .single())
    }
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
    if (bookingErr?.code === OVERLAP_VIOLATION) {
      return { confirmed: false, error: 'that time is already taken' }
    }
    if (bookingErr || !inserted) {
      console.error('[ai booking] booking insert failed:', bookingErr)
      return { confirmed: false, error: 'the booking could not be saved' }
    }
    const reference = bookingReference((inserted as { id: string }).id)
    const withWhom = professional ? ` with ${professional.name}` : ''
    void syncBookingToGoogle((inserted as { id: string }).id)

    // Thread annotation is cosmetic — a failure here must not turn a
    // booking that really was saved into a "no" for the customer.
    try {
      await db.from('messages').insert({
        conversation_id: conversationId,
        sender_type: 'bot',
        content_type: 'system_event',
        content_text: `Booked ${serviceName}${withWhom} for ${businessDate(appointment.startsAt)} ${businessTime(appointment.startsAt)} (${reference})`,
        metadata: {
          kind: 'booking_created',
          ...appointment,
          service: serviceName,
          endsAt,
          reference,
          ...(professional ? { professionalId: professional.id, professionalName: professional.name } : {}),
        },
      })
    } catch (err) {
      console.error('[ai booking] booking system_event insert failed:', err)
    }

    console.log('[ai booking] booked', { accountId, contactId, startsAt: appointment.startsAt, reference, professional: professional?.id })
    return professional ? { confirmed: true, reference, professional: professional.name } : { confirmed: true, reference }
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
  professional_id?: string | null
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
  // Newest columns first, dropping them while the migrations that add
  // them (066, then 062) haven't run.
  let { data, error } = await query(`${base}, customer_name, customer_phone, professional_id`)
  if (error?.code === '42703') ({ data, error } = await query(`${base}, customer_name, customer_phone`))
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

function toManaged(b: CustomerBookingRow, directory?: ClinicDirectory | null): ManagedBooking {
  const professional =
    directory && b.professional_id ? directory.professionals.find((p) => p.id === b.professional_id) : undefined
  return {
    reference: bookingReference(b.id),
    service: b.service,
    startsAt: b.starts_at,
    endsAt: b.ends_at,
    date: businessDate(b.starts_at),
    time: businessTime(b.starts_at),
    customerName: b.customer_name || b.contact?.name || null,
    ...(professional ? { professional: professional.name } : {}),
  }
}

/** Upcoming confirmed appointments booked with this phone number (or
 *  from this same contact). */
export async function findCustomerBookings(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; phone: string; directory?: ClinicDirectory | null },
): Promise<ManagedBooking[]> {
  const rows = await loadCustomerBookings(db, args.accountId, args.contactId, args.phone)
  return (rows ?? []).map((b) => toManaged(b, args.directory))
}

/** Pick the one booking a reschedule/cancel refers to, or explain why
 *  it can't be picked. */
async function pickCustomerBooking(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; phone: string; reference?: string; directory?: ClinicDirectory | null },
): Promise<{ booking: CustomerBookingRow } | { error: string; appointments?: ManagedBooking[] }> {
  const managed = (b: CustomerBookingRow) => toManaged(b, args.directory)
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
      appointments: rows.map(managed),
    }
  }
  if (rows.length === 1) return { booking: rows[0] }
  return {
    error: 'several appointments match; ask the customer which one (by reference, date or service)',
    appointments: rows.map(managed),
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
    /** Clinic module: move it to this doctor (default: the same one). */
    professionalId?: string
    directory?: ClinicDirectory | null
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

    let professional: ClinicProfessional | null = null
    if (args.directory) {
      const pickedDoctor = appointmentProfessional(args.directory, args.professionalId, booking.professional_id)
      if ('error' in pickedDoctor) return { rescheduled: false, error: pickedDoctor.error }
      professional = pickedDoctor.professional
    }

    const conflict = await validateSlot(db, accountId, startsAt, endsAt, booking.id, professional)
    if (conflict) return { rescheduled: false, error: conflict }

    const { data: rows, error } = await db
      .from('bookings')
      .update({
        starts_at: startsAt,
        ends_at: endsAt,
        updated_at: new Date().toISOString(),
        ...(professional ? { professional_id: professional.id } : {}),
      })
      .eq('id', booking.id)
      .eq('account_id', accountId)
      .select('id')
    if (error?.code === OVERLAP_VIOLATION) return { rescheduled: false, error: 'that time is already taken' }
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
        ...(professional ? { professionalId: professional.id, professionalName: professional.name } : {}),
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
  args: {
    accountId: string
    contactId: string
    conversationId: string
    phone: string
    reference?: string
    directory?: ClinicDirectory | null
  },
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
