import type { SupabaseClient } from '@supabase/supabase-js'
import { checkBookingSchedule, holidayOn, loadBookingSettings, type ScheduleProblem } from './booking'
import { getClinicDirectory, resolveProfessional } from '@/lib/clinic/directory'
import { bookingReference } from '@/lib/bookings/reference'
import { addDaysISO } from '@/lib/bookings/ranges'
import { findExistingContact } from '@/lib/contacts/dedupe'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { googleBusy, listGoogleEvents, syncBookingToGoogle } from '@/lib/google-calendar/sync'
import { businessDate, businessLocalToInstant, businessTime, businessToday } from '@/lib/business-timezone'
import type { OpsTool } from './ops-assistant'

// ============================================================
// The owner's agenda over Telegram (ops assistant):
// - read (always): list_agenda (bookings + the connected Google
//   Calendar's own events) and list_services_and_prices (catalog and
//   clinic services, text only: never images or file links);
// - write (feature module `telegram_agenda`): create_booking,
//   move_booking and cancel_booking. The owner is the one asking, so
//   clashes (another booking, a Google event, closed hours, a holiday)
//   are reported and only saved when the owner confirms (`force`).
// Bookings made here are attributed to the account owner
// (`created_by`), so reports never count them as the AI's.
// ============================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/
const DEFAULT_MINUTES = 60
const MAX_AGENDA_DAYS = 31

/** Generic name of the contact that holds the owner's own meetings when
 *  they don't say who it is with (bookings need a contact). */
export const PERSONAL_AGENDA_CONTACT = 'Agenda personal'

const SCHEDULE_PROBLEM_TEXT: Record<ScheduleProblem, string> = {
  holiday: 'that day is a holiday',
  day_off: 'the business is closed that day',
  time_off: 'that doctor is away that day',
  outside_hours: 'it is outside business hours',
}

function str(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

function minutesArg(v: unknown, def: number): number | null {
  if (v === undefined || v === null || v === '') return def
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return null
  const m = Math.round(n)
  return m >= 5 && m <= 720 ? m : null
}

/** "9:5" is not a time; "9:05" → "09:05". */
export function normalizeTime(v: unknown): string | null {
  const t = str(v, 5)
  if (!TIME_RE.test(t)) return null
  const [h, m] = t.split(':')
  return `${h.padStart(2, '0')}:${m}`
}

/** "CITA-3F2A1B", "cita 3f2a1b" or just "3f2a1b" → "3f2a1b". */
export function referenceKey(v: unknown): string | null {
  const m = str(v, 40).toLowerCase().match(/([0-9a-f]{6})\s*$/)
  return m ? m[1] : null
}

interface Interval {
  start: number
  end: number
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end
}

interface AgendaRow {
  id: string
  kind?: string | null
  status: string
  service: string | null
  starts_at: string
  ends_at: string
  notes: string | null
  customer_name?: string | null
  customer_phone?: string | null
  professional_id?: string | null
  is_sample?: boolean | null
  contacts?: { name?: string | null; phone?: string | null } | null
}

const AGENDA_SELECT = '*, contacts(name, phone)'

/** Live (not cancelled / no-show), real (not sample) bookings overlapping
 *  [from, to). */
async function liveBookings(db: SupabaseClient, accountId: string, from: number, to: number): Promise<AgendaRow[]> {
  const { data, error } = await db
    .from('bookings')
    .select(AGENDA_SELECT)
    .eq('account_id', accountId)
    .lt('starts_at', new Date(to).toISOString())
    .gt('ends_at', new Date(from).toISOString())
    .order('starts_at', { ascending: true })
    .limit(500)
  if (error) throw error
  return ((data ?? []) as AgendaRow[]).filter(
    (b) => !b.is_sample && b.status !== 'cancelled' && b.status !== 'no_show',
  )
}

function who(b: AgendaRow): string | null {
  return b.customer_name || b.contacts?.name || null
}

function describeBooking(b: AgendaRow, doctors: Map<string, string>) {
  const doctor = b.professional_id ? doctors.get(b.professional_id) : undefined
  return {
    reference: bookingReference(b.id, b.kind ?? undefined),
    date: businessDate(b.starts_at),
    time: businessTime(b.starts_at),
    endsAt: businessTime(b.ends_at),
    what: b.service || null,
    with: who(b),
    phone: b.customer_phone || b.contacts?.phone || null,
    ...(doctor ? { doctor } : {}),
    ...(b.kind && b.kind !== 'appointment' ? { kind: b.kind } : {}),
    ...(b.status !== 'confirmed' ? { status: b.status } : {}),
    ...(b.notes ? { notes: b.notes.slice(0, 200) } : {}),
  }
}

async function doctorNames(db: SupabaseClient, accountId: string): Promise<Map<string, string>> {
  const directory = await getClinicDirectory(db, accountId).catch(() => null)
  return new Map((directory?.professionals ?? []).map((p) => [p.id, p.name]))
}

/** Everything that stands in the way of [start, end): other live
 *  appointments (the same doctor's only, in clinic mode), events in the
 *  connected Google Calendar, closed hours and holidays. */
async function clashes(
  db: SupabaseClient,
  accountId: string,
  slot: Interval,
  opts: { professionalId: string | null; excludeId?: string },
): Promise<string[]> {
  const out: string[] = []
  const [rows, google, problem] = await Promise.all([
    liveBookings(db, accountId, slot.start, slot.end),
    googleBusy(accountId, slot.start, slot.end),
    checkBookingSchedule(
      db,
      accountId,
      opts.professionalId,
      new Date(slot.start).toISOString(),
      new Date(slot.end).toISOString(),
    ),
  ])
  for (const b of rows) {
    if (b.id === opts.excludeId) continue
    // Tables and halls never block the agenda.
    if (b.kind && b.kind !== 'appointment') continue
    if (opts.professionalId && b.professional_id && b.professional_id !== opts.professionalId) continue
    const label = [b.service, who(b)].filter(Boolean).join(' · ')
    out.push(
      `already booked ${businessTime(b.starts_at)}–${businessTime(b.ends_at)}${label ? ` (${label})` : ''} ${bookingReference(b.id, b.kind ?? undefined)}`,
    )
  }
  for (const g of google) {
    if (overlaps(slot, g)) out.push(`busy in Google Calendar ${businessTime(new Date(g.start))}–${businessTime(new Date(g.end))}`)
  }
  if (problem) out.push(SCHEDULE_PROBLEM_TEXT[problem])
  return out
}

/** The contact a booking is filed under: by phone, else by exact name,
 *  else a new one; with nobody named, the owner's own "Agenda personal". */
async function resolveContact(
  db: SupabaseClient,
  accountId: string,
  name: string,
  phone: string,
): Promise<{ id: string } | { error: string }> {
  const digits = normalizePhone(phone)
  if (digits.length >= 7) {
    const existing = await findExistingContact(db, accountId, digits)
    if (existing) return { id: existing.id }
  }
  const lookup = name || (digits ? '' : PERSONAL_AGENDA_CONTACT)
  if (lookup && !digits) {
    const { data } = await db
      .from('contacts')
      .select('id, name')
      .eq('account_id', accountId)
      .ilike('name', lookup.replace(/[%_]/g, ''))
      .limit(5)
    const found = (data ?? []) as { id: string; name: string }[]
    if (found.length === 1) return { id: found[0].id }
    if (found.length > 1) {
      return { error: `several contacts are called "${lookup}": ask the owner for the phone number to tell them apart` }
    }
  }
  const owner = await resolveAuditUserId(db, accountId)
  const { data: created, error } = await db
    .from('contacts')
    .insert({ account_id: accountId, user_id: owner, name: lookup || digits, phone: digits })
    .select('id')
    .single()
  if (error || !created) {
    console.error('[ops agenda] contact insert failed:', error)
    return { error: 'the contact could not be saved' }
  }
  return { id: (created as { id: string }).id }
}

/** The live booking behind a reference, from yesterday onwards. */
async function findByReference(db: SupabaseClient, accountId: string, ref: unknown): Promise<AgendaRow | null> {
  const key = referenceKey(ref)
  if (!key) return null
  const from = businessLocalToInstant(addDaysISO(businessToday(), -1), '00:00').getTime()
  const rows = await liveBookings(db, accountId, from, from + 400 * 86_400_000)
  return rows.find((b) => b.id.toLowerCase().startsWith(key)) ?? null
}

function slotFrom(dateArg: unknown, timeArg: unknown, minutes: number): Interval | { error: string } {
  const date = str(dateArg, 10)
  if (!DATE_RE.test(date)) return { error: 'date must be YYYY-MM-DD' }
  const time = normalizeTime(timeArg)
  if (!time) return { error: 'time must be HH:mm (24 h)' }
  const start = businessLocalToInstant(date, time).getTime()
  if (Number.isNaN(start)) return { error: 'invalid date or time' }
  if (start < Date.now() - 5 * 60_000) return { error: 'that time has already passed' }
  return { start, end: start + minutes * 60_000 }
}

export const OPS_READ_AGENDA_TOOLS: OpsTool[] = [
  {
    name: 'list_agenda',
    description:
      'The owner\'s calendar for a day or a range: every booking (appointments, table reservations, events, visits) with time, who, what and its reference code, plus the events of their connected Google Calendar. Use it for "¿qué tengo hoy?", "¿cómo está mi agenda el jueves?", "¿qué reuniones tengo esta semana?".',
    schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'First day, YYYY-MM-DD (business-local). Default today.' },
        to: { type: 'string', description: 'Last day, inclusive, YYYY-MM-DD. Default the same as from. At most 31 days.' },
      },
    },
    execute: async (db, accountId, args) => {
      const fromDay = DATE_RE.test(str(args.from, 10)) ? str(args.from, 10) : businessToday()
      let toDay = DATE_RE.test(str(args.to, 10)) ? str(args.to, 10) : fromDay
      if (toDay < fromDay) toDay = fromDay
      const cap = addDaysISO(fromDay, MAX_AGENDA_DAYS - 1)
      if (toDay > cap) toDay = cap
      const from = businessLocalToInstant(fromDay, '00:00').getTime()
      const to = businessLocalToInstant(addDaysISO(toDay, 1), '00:00').getTime()
      const [rows, google, doctors, settings] = await Promise.all([
        liveBookings(db, accountId, from, to),
        listGoogleEvents(accountId, from, to),
        doctorNames(db, accountId),
        loadBookingSettings(db, accountId),
      ])
      const holidays: { date: string; name?: string }[] = []
      for (let d = fromDay; d <= toDay; d = addDaysISO(d, 1)) {
        const h = holidayOn(settings, d)
        if (h) holidays.push(h)
      }
      return {
        from: fromDay,
        to: toDay,
        bookings: rows.map((b) => describeBooking(b, doctors)),
        ...(google.length ? { googleCalendar: google } : {}),
        ...(holidays.length ? { holidays } : {}),
        ...(rows.length === 0 && google.length === 0 ? { note: 'Nothing scheduled in that range.' } : {}),
      }
    },
  },
  {
    name: 'list_services_and_prices',
    description:
      'The full list of what the business sells, with prices: every catalog item, and the clinic services with their length when the business uses them. Text only. Use it for "¿qué servicios tengo?", "pásame la lista de precios", "¿cuánto cuesta X?" when you need the whole list.',
    schema: { type: 'object', properties: {} },
    execute: async (db, accountId) => {
      const { data, error } = await db
        .from('ai_attachments')
        .select('name, description, price, currency')
        .eq('account_id', accountId)
        .order('name', { ascending: true })
        .limit(300)
      if (error) throw error
      const catalog = ((data ?? []) as { name: string; description: string | null; price: number | null; currency: string | null }[]).map(
        (row) => ({
          name: row.name,
          price: row.price ?? null,
          currency: row.currency ?? null,
          ...(row.description ? { description: row.description.slice(0, 160) } : {}),
        }),
      )
      // Clinic services (migration 067); missing table = none.
      const { data: services } = await db
        .from('clinic_services')
        .select('name, duration_minutes, price, active')
        .eq('account_id', accountId)
        .order('sort_order', { ascending: true })
      const clinicServices = ((services ?? []) as { name: string; duration_minutes: number; price: number | null; active: boolean }[])
        .filter((s) => s.active)
        .map((s) => ({ name: s.name, minutes: s.duration_minutes, price: s.price ?? null }))
      return {
        catalog,
        ...(clinicServices.length ? { clinicServices } : {}),
        ...(catalog.length === 0 && clinicServices.length === 0 ? { note: 'No services or prices are loaded yet.' } : {}),
      }
    },
  },
]

export const OPS_WRITE_AGENDA_TOOLS: OpsTool[] = [
  {
    name: 'create_booking',
    description:
      'Put an appointment or meeting on the owner\'s agenda (it also goes to their Google Calendar when connected). Call it as soon as you know the day, the time and what it is; the length defaults to 60 minutes. If it answers with clashes, tell the owner what is in the way and only call again with force true when they say to book it anyway.',
    schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Day, YYYY-MM-DD (business-local).' },
        time: { type: 'string', description: 'Start, 24-hour HH:mm.' },
        duration_minutes: { type: 'number', description: 'Length in minutes, default 60.' },
        title: { type: 'string', description: 'What it is, e.g. "Reunión con proveedor", "Consulta", "Llamada de ventas".' },
        with_name: { type: 'string', description: 'Who it is with (person or company), when the owner says it.' },
        with_phone: { type: 'string', description: 'Their phone, when the owner gives it.' },
        notes: { type: 'string', description: 'Anything else the owner said about it.' },
        doctor: { type: 'string', description: 'Clinics only: the doctor or advisor it is with (name).' },
        force: { type: 'boolean', description: 'true only after the owner confirmed booking it despite the clashes.' },
      },
      required: ['date', 'time', 'title'],
    },
    execute: async (db, accountId, args) => {
      const minutes = minutesArg(args.duration_minutes, DEFAULT_MINUTES)
      if (minutes === null) return { error: 'duration_minutes must be between 5 and 720' }
      const slot = slotFrom(args.date, args.time, minutes)
      if ('error' in slot) return slot
      const title = str(args.title, 200) || 'Reunión'
      const name = str(args.with_name, 120)
      const phone = str(args.with_phone, 30)

      let professionalId: string | null = null
      const doctorArg = str(args.doctor, 120)
      if (doctorArg) {
        const directory = await getClinicDirectory(db, accountId)
        const professional = directory ? resolveProfessional(directory, doctorArg) : null
        if (!professional) return { error: `no doctor or advisor matches "${doctorArg}"` }
        professionalId = professional.id
      }

      if (args.force !== true) {
        const found = await clashes(db, accountId, slot, { professionalId })
        if (found.length) {
          return {
            created: false,
            clashes: found,
            note: 'Tell the owner what is in the way and ask whether to book it anyway (then call again with force true) or pick another time.',
          }
        }
      }

      const contact = await resolveContact(db, accountId, name, phone)
      if ('error' in contact) return { created: false, error: contact.error }
      const owner = await resolveAuditUserId(db, accountId).catch(() => null)
      const { data, error } = await db
        .from('bookings')
        .insert({
          account_id: accountId,
          contact_id: contact.id,
          service: title,
          starts_at: new Date(slot.start).toISOString(),
          ends_at: new Date(slot.end).toISOString(),
          notes: str(args.notes, 1000) || null,
          created_by: owner,
          customer_name: name || null,
          customer_phone: phone || null,
          ...(professionalId ? { professional_id: professionalId } : {}),
        })
        .select('id')
        .single()
      if (error || !data) {
        if (error?.code === '23P01') return { created: false, error: 'that doctor already has an appointment at that time' }
        console.error('[ops agenda] booking insert failed:', error)
        return { created: false, error: 'the booking could not be saved' }
      }
      const id = (data as { id: string }).id
      await syncBookingToGoogle(id)
      return {
        created: true,
        reference: bookingReference(id, 'appointment'),
        date: businessDate(new Date(slot.start)),
        time: businessTime(new Date(slot.start)),
        endsAt: businessTime(new Date(slot.end)),
      }
    },
  },
  {
    name: 'move_booking',
    description:
      'Move an appointment on the owner\'s agenda to another day or time, by its reference code (from list_agenda). Same rule as create_booking: clashes are reported, and force true books it anyway once the owner says so. Table reservations and events are moved from the app.',
    schema: {
      type: 'object',
      properties: {
        reference: { type: 'string', description: 'Reference code, e.g. "CITA-3F2A1B".' },
        date: { type: 'string', description: 'New day, YYYY-MM-DD.' },
        time: { type: 'string', description: 'New start, 24-hour HH:mm.' },
        duration_minutes: { type: 'number', description: 'New length; default keeps the current one.' },
        force: { type: 'boolean', description: 'true only after the owner confirmed moving it despite the clashes.' },
      },
      required: ['reference', 'date', 'time'],
    },
    execute: async (db, accountId, args) => {
      const booking = await findByReference(db, accountId, args.reference)
      if (!booking) return { moved: false, error: 'no upcoming booking has that reference: check list_agenda' }
      if (booking.kind && booking.kind !== 'appointment') {
        return { moved: false, error: 'table reservations and events are moved from the app (Restaurante / Eventos)' }
      }
      const current = Math.round((new Date(booking.ends_at).getTime() - new Date(booking.starts_at).getTime()) / 60_000)
      const minutes = minutesArg(args.duration_minutes, current)
      if (minutes === null) return { moved: false, error: 'duration_minutes must be between 5 and 720' }
      const slot = slotFrom(args.date, args.time, minutes)
      if ('error' in slot) return { moved: false, error: slot.error }
      if (args.force !== true) {
        const found = await clashes(db, accountId, slot, {
          professionalId: booking.professional_id ?? null,
          excludeId: booking.id,
        })
        if (found.length) {
          return { moved: false, clashes: found, note: 'Ask the owner whether to move it anyway (force true) or pick another time.' }
        }
      }
      const { data, error } = await db
        .from('bookings')
        .update({
          starts_at: new Date(slot.start).toISOString(),
          ends_at: new Date(slot.end).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', booking.id)
        .eq('account_id', accountId)
        .select('id')
      if (error || !data?.length) {
        if (error?.code === '23P01') return { moved: false, error: 'that doctor already has an appointment at that time' }
        console.error('[ops agenda] booking move failed:', error)
        return { moved: false, error: 'the booking could not be moved' }
      }
      // A new time sends the reminders again.
      await db.from('booking_reminder_sends').delete().eq('booking_id', booking.id)
      await syncBookingToGoogle(booking.id)
      return {
        moved: true,
        reference: bookingReference(booking.id, 'appointment'),
        date: businessDate(new Date(slot.start)),
        time: businessTime(new Date(slot.start)),
        endsAt: businessTime(new Date(slot.end)),
      }
    },
  },
  {
    name: 'cancel_booking',
    description:
      'Cancel a booking on the owner\'s agenda by its reference code (from list_agenda). Only when the owner clearly asked to cancel that one; if it is unclear which, list the agenda and ask first.',
    schema: {
      type: 'object',
      properties: { reference: { type: 'string', description: 'Reference code, e.g. "CITA-3F2A1B".' } },
      required: ['reference'],
    },
    execute: async (db, accountId, args) => {
      const booking = await findByReference(db, accountId, args.reference)
      if (!booking) return { cancelled: false, error: 'no upcoming booking has that reference: check list_agenda' }
      const { data, error } = await db
        .from('bookings')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', booking.id)
        .eq('account_id', accountId)
        .select('id')
      if (error || !data?.length) {
        console.error('[ops agenda] booking cancel failed:', error)
        return { cancelled: false, error: 'the booking could not be cancelled' }
      }
      await syncBookingToGoogle(booking.id)
      return { cancelled: true, ...describeBooking(booking, new Map()) }
    },
  },
]
