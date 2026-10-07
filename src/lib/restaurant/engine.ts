import type { SupabaseClient } from '@supabase/supabase-js'
import type { PreorderItem, RestaurantSettings, TableSeating } from '@/types'
import { accountModuleEnabled } from '@/lib/modules-server'
import {
  businessDate,
  businessLocalToInstant,
  businessTime,
  businessToday,
  businessWeekday,
} from '@/lib/business-timezone'
import { addDaysISO } from '@/lib/bookings/ranges'
import { bookingReference, phonesMatch } from '@/lib/bookings/reference'
import { holidayOn, loadBookingSettings, type BookingSettingsRow } from '@/lib/ai/booking'
import { preferReal } from '@/lib/samples/prefer-real'
import { normalizeRestaurantSettings, reservationMinutes } from './settings'
import { freeTableIds, maxSeatable, pickTables, type FloorTable, type HeldTables, type TablePick } from './tables'

// ============================================================
// Restaurant module (migration 068): table reservations.
//
// A reservation is a `bookings` row with kind 'table' plus one
// `booking_tables` row per table it holds. booking_tables' exclusion
// constraint is the real guard against double-booking a table: a race
// that slips past the availability check fails the insert with 23P01 and
// the reservation is rolled back.
// ============================================================

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const
const OVERLAP_VIOLATION = '23P01'
/** How far before/after the requested day alternatives are looked for. */
const SEARCH_DAYS_BEFORE = 3
const SEARCH_DAYS_AFTER = 10

export function isMissingRestaurantSchema(code: string | undefined): boolean {
  return code === '42P01' || code === '42703' || code === 'PGRST200' || code === 'PGRST205'
}

export interface RestaurantDirectory {
  settings: RestaurantSettings
  tables: FloorTable[]
  areas: { id: string; name: string; description: string | null }[]
  /** Business booking settings: holidays, and the hours when the
   *  restaurant has none of its own. */
  business: BookingSettingsRow | null
  /** Whether the waitlist feature module is on. */
  waitlist: boolean
}

interface TableRow {
  id: string
  name: string
  area_id: string | null
  min_party: number
  max_party: number
  combinable: boolean
  is_sample?: boolean
}

/**
 * The floor plan and settings, or null unless the restaurant module is on,
 * migration 068 has run and there is at least one active table — while
 * it's null the AI has no table tools.
 */
export async function getRestaurantDirectory(
  db: SupabaseClient,
  accountId: string,
): Promise<RestaurantDirectory | null> {
  try {
    if (!(await accountModuleEnabled(db, accountId, 'restaurant'))) return null
    const [tablesRes, areasRes, settingsRes, business, waitlist] = await Promise.all([
      db
        .from('restaurant_tables')
        .select('id, name, area_id, min_party, max_party, combinable, is_sample')
        .eq('account_id', accountId)
        .eq('active', true)
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true }),
      db
        .from('restaurant_areas')
        .select('id, name, description, active')
        .eq('account_id', accountId)
        .order('sort_order', { ascending: true }),
      db.from('accounts').select('restaurant_settings').eq('id', accountId).maybeSingle(),
      loadBookingSettings(db, accountId),
      accountModuleEnabled(db, accountId, 'waitlist'),
    ])
    if (tablesRes.error) {
      if (!isMissingRestaurantSchema(tablesRes.error.code)) console.error('[restaurant] tables load failed:', tablesRes.error)
      return null
    }
    const areaRows = (areasRes.data ?? []) as { id: string; name: string; description: string | null; active: boolean }[]
    const inactiveAreas = new Set(areaRows.filter((a) => !a.active).map((a) => a.id))
    const areaName = new Map(areaRows.map((a) => [a.id, a.name]))
    const tables = preferReal((tablesRes.data ?? []) as TableRow[])
      .filter((t) => !t.area_id || !inactiveAreas.has(t.area_id))
      .map((t) => ({
        id: t.id,
        name: t.name,
        areaId: t.area_id,
        areaName: t.area_id ? areaName.get(t.area_id) ?? null : null,
        minParty: t.min_party,
        maxParty: t.max_party,
        combinable: t.combinable,
      }))
    if (tables.length === 0) return null
    return {
      settings: normalizeRestaurantSettings(settingsRes.data?.restaurant_settings),
      tables,
      areas: areaRows.filter((a) => a.active).map(({ id, name, description }) => ({ id, name, description })),
      business,
      waitlist,
    }
  } catch (err) {
    console.error('[restaurant] directory load failed:', err)
    return null
  }
}

/** The restaurant's weekly hours: its own, else the business's. */
function restaurantHours(dir: RestaurantDirectory): BookingSettingsRow['hours'] {
  return dir.settings.hours ?? dir.business?.hours
}

/** Start window for one day as instants: first seating at opening, last
 *  seating `last_seating_minutes` before closing. Null when closed. */
export function seatingWindow(
  dir: Pick<RestaurantDirectory, 'settings' | 'business'>,
  dateISO: string,
): { first: number; last: number; close: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return null
  if (holidayOn(dir.business, dateISO)) return null
  const hours = (dir.settings.hours ?? dir.business?.hours)?.[WEEKDAYS[businessWeekday(dateISO)]]
  if (!hours) return null
  const open = businessLocalToInstant(dateISO, hours.open).getTime()
  const close = businessLocalToInstant(dateISO, hours.close).getTime()
  if (Number.isNaN(open) || Number.isNaN(close) || close <= open) return null
  const last = close - dir.settings.last_seating_minutes * 60_000
  return last >= open ? { first: open, last, close } : null
}

/** One line per area for the system prompt. */
export function formatRestaurantRoster(dir: RestaurantDirectory): string {
  const s = dir.settings
  const byArea = new Map<string, FloorTable[]>()
  for (const t of dir.tables) {
    const key = t.areaName ?? 'Salón'
    byArea.set(key, [...(byArea.get(key) ?? []), t])
  }
  const areas = [...byArea.entries()].map(([name, tables]) => {
    const sizes = tables.map((t) => `${t.name} (${t.minParty}-${t.maxParty})`).join(', ')
    const description = dir.areas.find((a) => a.name === name)?.description
    return `- ${name}${description ? ` — ${description}` : ''}: ${sizes}`
  })
  const hours = restaurantHours(dir)
  const hoursLine = hours
    ? Object.entries(hours)
        .map(([day, h]) => `${day}: ${h ? `${h.open}-${h.close}` : 'closed'}`)
        .join('; ')
    : 'not set'
  return [
    `Tables by area (name and party size):`,
    ...areas,
    `Restaurant hours: ${hoursLine}. Last seating ${s.last_seating_minutes} minutes before closing.`,
    `A reservation lasts ${s.default_duration_minutes} minutes by default; the customer may ask for between ${s.min_duration_minutes} and ${s.max_duration_minutes} minutes.`,
    `Largest party the AI books: ${s.max_party_ai} people (bigger groups go to a person).`,
    s.allow_combine
      ? `Bigger parties can get several tables of the same area: joined together or separate tables side by side.`
      : `Tables are never combined: a party must fit one table.`,
  ].join('\n')
}

/** Live table holds overlapping [from, to). */
async function loadHeld(
  db: SupabaseClient,
  accountId: string,
  from: number,
  to: number,
): Promise<HeldTables[] | null> {
  const { data, error } = await db
    .from('booking_tables')
    .select('booking_id, table_id, starts_at, ends_at')
    .eq('account_id', accountId)
    .eq('released', false)
    .lt('starts_at', new Date(to).toISOString())
    .gt('ends_at', new Date(from).toISOString())
  if (error) {
    console.error('[restaurant] booking_tables load failed:', error)
    return null
  }
  const byBooking = new Map<string, HeldTables>()
  for (const r of (data ?? []) as { booking_id: string; table_id: string; starts_at: string; ends_at: string }[]) {
    const h = byBooking.get(r.booking_id) ?? {
      bookingId: r.booking_id,
      tableIds: [],
      start: new Date(r.starts_at).getTime(),
      end: new Date(r.ends_at).getTime(),
    }
    h.tableIds.push(r.table_id)
    byBooking.set(r.booking_id, h)
  }
  return [...byBooking.values()]
}

export interface TableSlot {
  startsAt: string
  endsAt: string
  tables: string[]
  tableIds: string[]
  area: string | null
  /** Several tables: the customer must agree (joined or side by side). */
  combined: boolean
  seats: number
}

export interface TableAvailability {
  requested?: { date: string; time: string; available: boolean }
  slots: TableSlot[]
  partySize: number
  durationMinutes: number
  holiday?: { date: string; name?: string }
  error?: string
}

export interface TableAvailabilityArgs {
  date: string
  time?: string
  partySize: number
  durationMinutes?: number
  area?: string
}

function toSlot(start: number, durationMs: number, pick: TablePick): TableSlot {
  return {
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + durationMs).toISOString(),
    tables: pick.tables.map((t) => t.name),
    tableIds: pick.tables.map((t) => t.id),
    area: pick.tables[0]?.areaName ?? null,
    combined: pick.combined,
    seats: pick.seats,
  }
}

/** Tables for a party at one exact start, or null. */
function pickAt(
  dir: RestaurantDirectory,
  held: HeldTables[],
  start: number,
  durationMs: number,
  partySize: number,
  area: string | undefined,
  excludeBookingId?: string,
): TablePick | null {
  const free = freeTableIds(dir.tables, held, start, start + durationMs, dir.settings.buffer_minutes * 60_000, excludeBookingId)
  return pickTables(dir.tables, free, partySize, { allowCombine: dir.settings.allow_combine, area })
}

/**
 * Open reservation times for a party. With a time: whether exactly that
 * time works, plus the nearest alternatives (possibly other days). Without
 * one: the first open times of that date, rolling forward. Prefers single
 * tables: a combined option is only offered when no single table is free
 * at that time.
 */
export async function checkTableAvailability(
  db: SupabaseClient,
  accountId: string,
  dir: RestaurantDirectory,
  args: TableAvailabilityArgs,
  k = 3,
  excludeBookingId?: string,
): Promise<TableAvailability> {
  const durationMinutes = reservationMinutes(dir.settings, args.durationMinutes)
  const durationMs = durationMinutes * 60_000
  const partySize = Math.round(args.partySize)
  const base: TableAvailability = {
    ...(args.time ? { requested: { date: args.date, time: args.time, available: false } } : {}),
    slots: [],
    partySize,
    durationMinutes,
  }
  const holiday = holidayOn(dir.business, args.date)
  if (holiday) base.holiday = holiday
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) return { ...base, error: 'date must be YYYY-MM-DD' }
  if (!(partySize >= 1)) return { ...base, error: 'party_size is required: ask how many people' }
  if (partySize > dir.settings.max_party_ai) {
    return {
      ...base,
      error: `parties over ${dir.settings.max_party_ai} people are handled by the team: take the details and hand off to a person`,
    }
  }
  if (partySize > maxSeatable(dir.tables, dir.settings.allow_combine)) {
    return { ...base, error: 'no table arrangement seats that many people: hand off to a person' }
  }

  const today = businessToday()
  const fromDay = args.time ? (addDaysISO(args.date, -SEARCH_DAYS_BEFORE) > today ? addDaysISO(args.date, -SEARCH_DAYS_BEFORE) : today) : args.date < today ? today : args.date
  const toDay = addDaysISO(args.date, SEARCH_DAYS_AFTER + 1)
  const held = await loadHeld(
    db,
    accountId,
    businessLocalToInstant(fromDay, '00:00').getTime() - 86_400_000,
    businessLocalToInstant(toDay, '00:00').getTime() + 86_400_000,
  )
  if (!held) return { ...base, error: 'the reservations could not be looked up' }

  const now = Date.now()
  const step = dir.settings.slot_minutes * 60_000

  let requestedSlot: TableSlot | null = null
  let target = 0
  if (args.time) {
    target = businessLocalToInstant(args.date, args.time).getTime()
    const window = seatingWindow(dir, args.date)
    if (window && target >= now && target >= window.first && target <= window.last) {
      const pick = pickAt(dir, held, target, durationMs, partySize, args.area, excludeBookingId)
      if (pick) requestedSlot = toSlot(target, durationMs, pick)
    }
  }

  const candidates: TableSlot[] = []
  for (let d = fromDay; d < toDay; d = addDaysISO(d, 1)) {
    const window = seatingWindow(dir, d)
    if (!window) continue
    for (let t = window.first; t <= window.last; t += step) {
      if (t < now) continue
      const pick = pickAt(dir, held, t, durationMs, partySize, args.area, excludeBookingId)
      if (pick) candidates.push(toSlot(t, durationMs, pick))
    }
    if (!args.time && candidates.length >= k * 4) break
  }

  if (!args.time) {
    // Spread the offer: first open time, then later ones of the same day
    // at least an hour apart, before moving to other days.
    const offered: TableSlot[] = []
    for (const s of candidates) {
      if (offered.length >= k) break
      const last = offered[offered.length - 1]
      if (last && new Date(s.startsAt).getTime() - new Date(last.startsAt).getTime() < 60 * 60_000 && businessDate(s.startsAt) === businessDate(last.startsAt)) continue
      offered.push(s)
    }
    return { ...base, slots: offered }
  }

  const distance = (s: TableSlot) => Math.abs(new Date(s.startsAt).getTime() - target)
  const nearest = candidates
    .filter((s) => s.startsAt !== requestedSlot?.startsAt)
    .sort((a, b) => distance(a) - distance(b) || a.startsAt.localeCompare(b.startsAt))
    .slice(0, requestedSlot ? k - 1 : k)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  return {
    ...base,
    requested: { date: args.date, time: args.time, available: !!requestedSlot },
    slots: requestedSlot ? [requestedSlot, ...nearest] : nearest,
  }
}

export interface TableReservationInput {
  startsAt: string
  partySize: number
  durationMinutes?: number
  customerName: string
  customerPhone?: string | null
  /** 'joined' or 'separate' when several tables are needed. */
  seating?: TableSeating | null
  /** The customer said they don't mind several tables. */
  customerAgreed?: boolean
  area?: string
  occasion?: string | null
  notes?: string | null
  preorder?: PreorderItem[] | null
  /** Specific tables (manual reservations); default: picked here. */
  tableIds?: string[]
}

export interface TableReservationResult {
  confirmed: boolean
  error?: string
  reference?: string
  bookingId?: string
  tables?: string[]
  seating?: TableSeating
  endsAt?: string
  durationMinutes?: number
}

function describeReservation(partySize: number, tables: string[]): string {
  return `Mesa para ${partySize} (${tables.join(' + ')})`
}

/**
 * Validate and save a table reservation. Several tables need the
 * customer's consent and a seating choice; without them it answers with
 * `needs_consent` so the agent asks first.
 */
export async function confirmTableReservation(
  db: SupabaseClient,
  args: {
    accountId: string
    contactId: string
    conversationId?: string | null
    dir: RestaurantDirectory
    input: TableReservationInput
    createdBy?: string | null
    isSample?: boolean
    /** Skip the hours check (the team overriding it by hand). */
    force?: boolean
  },
): Promise<TableReservationResult> {
  const { accountId, contactId, conversationId, dir, input } = args
  try {
    const start = new Date(input.startsAt).getTime()
    if (Number.isNaN(start)) return { confirmed: false, error: 'startsAt must be one of the offered times' }
    const durationMinutes = reservationMinutes(dir.settings, input.durationMinutes)
    const durationMs = durationMinutes * 60_000
    const partySize = Math.round(input.partySize)
    if (!(partySize >= 1)) return { confirmed: false, error: 'party_size is required' }
    if (!args.force) {
      if (start < Date.now()) return { confirmed: false, error: 'that time has already passed' }
      const window = seatingWindow(dir, businessDate(input.startsAt))
      if (!window || start < window.first || start > window.last) {
        return { confirmed: false, error: 'the restaurant does not take reservations at that time' }
      }
      if (partySize > dir.settings.max_party_ai && !args.createdBy) {
        return { confirmed: false, error: `parties over ${dir.settings.max_party_ai} are handled by the team: hand off to a person` }
      }
    }

    const held = await loadHeld(db, accountId, start - 86_400_000, start + durationMs + 86_400_000)
    if (!held) return { confirmed: false, error: 'the reservation could not be saved' }

    let tables: FloorTable[]
    if (input.tableIds?.length) {
      const free = freeTableIds(dir.tables, held, start, start + durationMs, dir.settings.buffer_minutes * 60_000)
      tables = dir.tables.filter((t) => input.tableIds!.includes(t.id))
      if (tables.length !== input.tableIds.length) return { confirmed: false, error: 'unknown table' }
      if (tables.some((t) => !free.has(t.id))) return { confirmed: false, error: 'that table is already taken at that time' }
    } else {
      const pick = pickAt(dir, held, start, durationMs, partySize, input.area)
      if (!pick) return { confirmed: false, error: 'no table is free for that party at that time: check availability again and offer the alternatives' }
      if (pick.combined && !input.customerAgreed) {
        return {
          confirmed: false,
          error:
            'needs_consent: this party needs several tables. Ask the customer whether they mind, and whether they prefer the tables joined together or separate tables side by side, then call book_table again with customer_agreed true and seating.',
          tables: pick.tables.map((t) => t.name),
        }
      }
      tables = pick.tables
    }
    const seating: TableSeating =
      tables.length > 1 ? (input.seating === 'separate' ? 'separate' : 'joined') : 'single'
    if (tables.length > 1 && !input.seating && !args.createdBy) {
      return {
        confirmed: false,
        error: 'seating is required for several tables: ask whether they prefer the tables joined together ("joined") or separate tables side by side ("separate")',
        tables: tables.map((t) => t.name),
      }
    }

    const startsAt = new Date(start).toISOString()
    const endsAt = new Date(start + durationMs).toISOString()
    const tableNames = tables.map((t) => t.name)
    const { data: inserted, error } = await db
      .from('bookings')
      .insert({
        account_id: accountId,
        contact_id: contactId,
        conversation_id: conversationId ?? null,
        kind: 'table',
        service: describeReservation(partySize, tableNames),
        starts_at: startsAt,
        ends_at: endsAt,
        party_size: partySize,
        seating,
        occasion: input.occasion?.trim() || null,
        notes: input.notes?.trim() || null,
        preorder: input.preorder?.length && dir.settings.allow_preorder ? input.preorder : null,
        customer_name: input.customerName.trim().slice(0, 100),
        customer_phone: input.customerPhone?.trim().slice(0, 40) || null,
        created_by: args.createdBy ?? null,
        is_sample: !!args.isSample,
      })
      .select('id')
      .single()
    if (error || !inserted) {
      console.error('[restaurant] reservation insert failed:', error)
      return { confirmed: false, error: 'the reservation could not be saved' }
    }
    const bookingId = (inserted as { id: string }).id
    const { data: holds, error: holdError } = await db
      .from('booking_tables')
      .insert(tables.map((t) => ({ booking_id: bookingId, table_id: t.id, account_id: accountId, starts_at: startsAt, ends_at: endsAt })))
      .select('table_id')
    if (holdError || (holds ?? []).length !== tables.length) {
      await db.from('bookings').delete().eq('id', bookingId)
      if (holdError?.code === OVERLAP_VIOLATION) return { confirmed: false, error: 'that table was just taken: check availability again' }
      console.error('[restaurant] booking_tables insert failed:', holdError)
      return { confirmed: false, error: 'the reservation could not be saved' }
    }

    const reference = bookingReference(bookingId, 'table')
    if (conversationId) {
      await annotate(db, conversationId, `Reserva ${reference}: ${describeReservation(partySize, tableNames)}, ${businessDate(startsAt)} ${businessTime(startsAt)} (${durationMinutes} min)`, {
        kind: 'table_reserved',
        reference,
        startsAt,
        endsAt,
        partySize,
        tables: tableNames,
        seating,
      })
    }
    return { confirmed: true, reference, bookingId, tables: tableNames, seating, endsAt, durationMinutes }
  } catch (err) {
    console.error('[restaurant] confirmTableReservation failed:', err)
    return { confirmed: false, error: 'the reservation could not be saved' }
  }
}

/**
 * Move a reservation to a new time (same row), re-picking its tables.
 * Keeps the party size and, unless a new one is given, the length.
 */
export async function rescheduleTableReservation(
  db: SupabaseClient,
  args: {
    accountId: string
    dir: RestaurantDirectory
    bookingId: string
    startsAt: string
    partySize: number
    durationMinutes: number
    customerAgreed?: boolean
    seating?: TableSeating | null
  },
): Promise<{ rescheduled: boolean; error?: string; endsAt?: string; tables?: string[] }> {
  const { accountId, dir, bookingId } = args
  const start = new Date(args.startsAt).getTime()
  if (Number.isNaN(start) || start < Date.now()) return { rescheduled: false, error: 'pick one of the offered times' }
  const window = seatingWindow(dir, businessDate(args.startsAt))
  if (!window || start < window.first || start > window.last) {
    return { rescheduled: false, error: 'the restaurant does not take reservations at that time' }
  }
  const durationMs = args.durationMinutes * 60_000
  const held = await loadHeld(db, accountId, start - 86_400_000, start + durationMs + 86_400_000)
  if (!held) return { rescheduled: false, error: 'the reservation could not be changed' }
  const pick = pickAt(dir, held, start, durationMs, args.partySize, undefined, bookingId)
  if (!pick) return { rescheduled: false, error: 'no table is free for that party at that time' }
  if (pick.combined && !args.customerAgreed) {
    return {
      rescheduled: false,
      error: 'needs_consent: at that time the party needs several tables; ask whether they mind (joined or separate) and try again',
      tables: pick.tables.map((t) => t.name),
    }
  }
  const startsAt = new Date(start).toISOString()
  const endsAt = new Date(start + durationMs).toISOString()
  // Free the old tables first, then hold the new ones; on a race put the
  // old ones back.
  const { data: old } = await db.from('booking_tables').select('table_id, starts_at, ends_at').eq('booking_id', bookingId)
  await db.from('booking_tables').delete().eq('booking_id', bookingId)
  const { error: holdError } = await db
    .from('booking_tables')
    .insert(pick.tables.map((t) => ({ booking_id: bookingId, table_id: t.id, account_id: accountId, starts_at: startsAt, ends_at: endsAt })))
  if (holdError) {
    if (old?.length) {
      await db.from('booking_tables').insert(
        (old as { table_id: string; starts_at: string; ends_at: string }[]).map((o) => ({ ...o, booking_id: bookingId, account_id: accountId })),
      )
    }
    return { rescheduled: false, error: holdError.code === OVERLAP_VIOLATION ? 'that table was just taken' : 'the reservation could not be changed' }
  }
  const tableNames = pick.tables.map((t) => t.name)
  const { data: rows, error } = await db
    .from('bookings')
    .update({
      starts_at: startsAt,
      ends_at: endsAt,
      service: describeReservation(args.partySize, tableNames),
      seating: pick.combined ? (args.seating === 'separate' ? 'separate' : 'joined') : 'single',
      updated_at: new Date().toISOString(),
    })
    .eq('id', bookingId)
    .eq('account_id', accountId)
    .select('id')
  if (error || !rows?.length) {
    console.error('[restaurant] reschedule update failed:', error)
    return { rescheduled: false, error: 'the reservation could not be changed' }
  }
  await db.from('booking_reminder_sends').delete().eq('booking_id', bookingId)
  return { rescheduled: true, endsAt, tables: tableNames }
}

async function annotate(db: SupabaseClient, conversationId: string, text: string, metadata: Record<string, unknown>) {
  try {
    await db.from('messages').insert({
      conversation_id: conversationId,
      sender_type: 'bot',
      content_type: 'system_event',
      content_text: text,
      metadata,
    })
  } catch (err) {
    console.error('[restaurant] system_event insert failed:', err)
  }
}

// ------------------------------------------------------------
// Waitlist
// ------------------------------------------------------------

export interface WaitlistInput {
  date: string
  partySize: number
  preferredTime?: string
  customerName: string
  customerPhone?: string | null
  notes?: string | null
}

/** Put the customer on the waitlist for a day. One live entry per phone
 *  and day: a second request updates it. */
export async function joinWaitlist(
  db: SupabaseClient,
  args: { accountId: string; contactId: string | null; conversationId?: string | null; input: WaitlistInput },
): Promise<{ added: boolean; error?: string; position?: number }> {
  const { accountId, input } = args
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || input.date < businessToday()) {
    return { added: false, error: 'date must be today or later, as YYYY-MM-DD' }
  }
  if (!(input.partySize >= 1)) return { added: false, error: 'party_size is required' }
  try {
    const { data: existing } = await db
      .from('restaurant_waitlist')
      .select('id, customer_phone, contact_id, created_at')
      .eq('account_id', accountId)
      .eq('date', input.date)
      .eq('status', 'waiting')
      .order('created_at', { ascending: true })
    const rows = (existing ?? []) as { id: string; customer_phone: string | null; contact_id: string | null; created_at: string }[]
    const mine = rows.find(
      (r) => (args.contactId && r.contact_id === args.contactId) || phonesMatch(r.customer_phone, input.customerPhone),
    )
    const values = {
      party_size: Math.round(input.partySize),
      preferred_time: input.preferredTime?.trim() || null,
      customer_name: input.customerName.trim().slice(0, 100),
      customer_phone: input.customerPhone?.trim().slice(0, 40) || null,
      notes: input.notes?.trim() || null,
      updated_at: new Date().toISOString(),
    }
    if (mine) {
      const { data, error } = await db.from('restaurant_waitlist').update(values).eq('id', mine.id).select('id')
      if (error || !data?.length) return { added: false, error: 'the waitlist could not be updated' }
      return { added: true, position: rows.indexOf(mine) + 1 }
    }
    const { data, error } = await db
      .from('restaurant_waitlist')
      .insert({
        account_id: accountId,
        contact_id: args.contactId,
        conversation_id: args.conversationId ?? null,
        date: input.date,
        ...values,
      })
      .select('id')
    if (error || !data?.length) {
      console.error('[restaurant] waitlist insert failed:', error)
      return { added: false, error: 'the waitlist could not be saved' }
    }
    if (args.conversationId) {
      await annotate(db, args.conversationId, `Lista de espera: ${values.party_size} personas, ${input.date}${values.preferred_time ? ` ${values.preferred_time}` : ''}`, {
        kind: 'waitlist_joined',
        date: input.date,
        partySize: values.party_size,
      })
    }
    return { added: true, position: rows.length + 1 }
  } catch (err) {
    console.error('[restaurant] joinWaitlist failed:', err)
    return { added: false, error: 'the waitlist could not be saved' }
  }
}

/** Upcoming table reservations for a phone (or this contact), for
 *  find_appointments. */
export function reservationMatches(
  row: { contact_id: string; customer_phone?: string | null; contact?: { phone: string | null } | null },
  contactId: string,
  phone: string,
): boolean {
  return row.contact_id === contactId || phonesMatch(row.customer_phone, phone) || phonesMatch(row.contact?.phone, phone)
}

