import type { SupabaseClient } from '@supabase/supabase-js'
import type { EventHall, EventPackage, EventSettings, EventStatus } from '@/types'
import { accountModuleEnabled } from '@/lib/modules-server'
import { businessLocalToInstant, businessTime, businessToday, businessWeekday } from '@/lib/business-timezone'
import { addDaysISO } from '@/lib/bookings/ranges'
import { bookingReference } from '@/lib/bookings/reference'
import { holidayOn, loadBookingSettings, type BookingSettingsRow } from '@/lib/ai/booking'
import { notifyOwner } from '@/lib/telegram/send'
import { isMissingRestaurantSchema } from '@/lib/restaurant/engine'
import { preferReal } from '@/lib/samples/prefer-real'
import { effectivePolicy, initialEventStatus, normalizeEventSettings, quoteEvent, type EventPolicy, type EventQuote } from './settings'

// ============================================================
// Events module (migration 068): halls and event requests.
//
// An event is a `bookings` row with kind 'event' on one hall. The row's
// `status` stays 'confirmed' so the hall is held from the moment of the
// request (bookings_no_hall_overlap), and `event_status` carries the
// pipeline: Solicitud → Cotizado → Depósito pagado → Confirmado →
// Realizado (or Cancelado, which also sets status 'cancelled' and frees
// the hall).
// ============================================================

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const
const OVERLAP_VIOLATION = '23P01'
const DEFAULT_EVENT_HOURS = 4

export interface EventDirectory {
  settings: EventSettings
  halls: EventHall[]
  packages: EventPackage[]
  business: BookingSettingsRow | null
}

/** Halls, packages and settings, or null unless the events module is on,
 *  migration 068 has run and there is at least one active hall. */
export async function getEventDirectory(db: SupabaseClient, accountId: string): Promise<EventDirectory | null> {
  try {
    if (!(await accountModuleEnabled(db, accountId, 'events'))) return null
    const [hallsRes, packagesRes, settingsRes, business] = await Promise.all([
      db.from('event_halls').select('*').eq('account_id', accountId).eq('active', true).order('sort_order').order('name'),
      db.from('event_packages').select('*').eq('account_id', accountId).eq('active', true).order('sort_order').order('name'),
      db.from('accounts').select('event_settings').eq('id', accountId).maybeSingle(),
      loadBookingSettings(db, accountId),
    ])
    if (hallsRes.error) {
      if (!isMissingRestaurantSchema(hallsRes.error.code)) console.error('[events] halls load failed:', hallsRes.error)
      return null
    }
    const halls = preferReal((hallsRes.data ?? []) as EventHall[])
    if (halls.length === 0) return null
    return {
      settings: normalizeEventSettings(settingsRes.data?.event_settings),
      halls,
      packages: preferReal((packagesRes.data ?? []) as EventPackage[]),
      business,
    }
  } catch (err) {
    console.error('[events] directory load failed:', err)
    return null
  }
}

function money(n: number | null | undefined, currency: string): string | null {
  return n == null ? null : `${currency} ${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

/** Halls, packages and the policy, for the system prompt. */
export function formatEventRoster(dir: EventDirectory): string {
  const s = dir.settings
  const halls = dir.halls.map((h) => {
    const policy = effectivePolicy(s, h)
    const price = h.price_per_hour != null ? `, ${money(h.price_per_hour, s.currency)}/hour (min ${h.min_hours} h)` : ''
    const rules = [
      policy.requiresApproval ? 'owner approval' : 'no approval needed',
      policy.depositRequired ? `${policy.depositPercent}% deposit` : 'no deposit',
    ].join(', ')
    return `- ${h.name} (hall_id ${h.id}): ${h.capacity_min}-${h.capacity_max} guests${price}; ${rules}${h.description ? ` — ${h.description}` : ''}`
  })
  const packages = dir.packages.map((p) => {
    const hall = p.hall_id ? dir.halls.find((h) => h.id === p.hall_id)?.name : null
    const price = [money(p.price, s.currency), p.price_per_person != null ? `${money(p.price_per_person, s.currency)} per guest` : null]
      .filter(Boolean)
      .join(' + ')
    const guests = p.min_guests || p.max_guests ? `, ${p.min_guests ?? 1}-${p.max_guests ?? '∞'} guests` : ''
    return `- ${p.name} (package_id ${p.id})${hall ? ` [${hall}]` : ''}: ${price || 'price on request'}${guests}${p.duration_hours ? `, ${p.duration_hours} h` : ''}${p.description ? ` — ${p.description}` : ''}`
  })
  return [
    'Event halls:',
    ...halls,
    ...(packages.length ? ['Event packages:', ...packages] : []),
    `Event types offered: ${s.event_types.join(', ') || 'any'}.`,
    `Events need at least ${s.min_notice_days} days of notice.`,
    s.deposit_instructions ? `How to pay the deposit: ${s.deposit_instructions}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Hours the halls can be used on a date, as instants. */
function eventWindow(dir: Pick<EventDirectory, 'settings' | 'business'>, dateISO: string): { open: number; close: number } | null {
  if (holidayOn(dir.business, dateISO)) return null
  const hours = (dir.settings.hours ?? dir.business?.hours)?.[WEEKDAYS[businessWeekday(dateISO)]]
  if (!hours) return null
  const open = businessLocalToInstant(dateISO, hours.open).getTime()
  const close = businessLocalToInstant(dateISO, hours.close).getTime()
  return close > open ? { open, close } : null
}

interface HallBusy {
  hallId: string
  start: number
  end: number
  bookingId: string
}

async function loadHallBusy(db: SupabaseClient, accountId: string, from: number, to: number): Promise<HallBusy[] | null> {
  const { data, error } = await db
    .from('bookings')
    .select('id, event_hall_id, starts_at, ends_at')
    .eq('account_id', accountId)
    .not('event_hall_id', 'is', null)
    .not('status', 'in', '(cancelled,no_show)')
    .lt('starts_at', new Date(to).toISOString())
    .gt('ends_at', new Date(from).toISOString())
  if (error) {
    console.error('[events] hall bookings load failed:', error)
    return null
  }
  return ((data ?? []) as { id: string; event_hall_id: string; starts_at: string; ends_at: string }[]).map((r) => ({
    hallId: r.event_hall_id,
    start: new Date(r.starts_at).getTime(),
    end: new Date(r.ends_at).getTime(),
    bookingId: r.id,
  }))
}

/** Whether `hall` is free for [start, end), keeping its setup before and
 *  cleanup after clear of every other event. */
export function hallFree(hall: Pick<EventHall, 'id' | 'setup_minutes' | 'cleanup_minutes'>, busy: HallBusy[], start: number, end: number, excludeBookingId?: string): boolean {
  const padBefore = hall.setup_minutes * 60_000
  const padAfter = hall.cleanup_minutes * 60_000
  return !busy.some(
    (b) => b.hallId === hall.id && b.bookingId !== excludeBookingId && start - padBefore < b.end + padAfter && end + padAfter > b.start - padBefore,
  )
}

export function hallsForGuests(halls: EventHall[], guests: number): EventHall[] {
  return halls.filter((h) => guests <= h.capacity_max && guests >= Math.max(1, Math.floor(h.capacity_min * 0.5)))
}

function findPackage(dir: EventDirectory, ref: string | undefined): EventPackage | null {
  if (!ref) return null
  const wanted = ref.trim().toLowerCase()
  return dir.packages.find((p) => p.id === ref || p.name.toLowerCase() === wanted) ?? null
}

function findHall(dir: EventDirectory, ref: string | undefined): EventHall | null {
  if (!ref) return null
  const wanted = ref.trim().toLowerCase()
  return dir.halls.find((h) => h.id === ref || h.name.toLowerCase() === wanted) ?? null
}

export interface EventAvailabilityArgs {
  date: string
  time?: string
  hours?: number
  guests: number
  hallId?: string
  packageId?: string
}

export interface EventHallOption {
  hall_id: string
  hall: string
  capacity: string
  free: boolean
  quote: string | null
  deposit: string | null
  needs_approval: boolean
}

export interface EventAvailability {
  date: string
  time?: string
  hours: number
  guests: number
  options: EventHallOption[]
  /** Other dates when the requested time is taken in every fitting hall. */
  alternatives?: { date: string; halls: string[] }[]
  error?: string
  holiday?: { date: string; name?: string }
}

function hoursFor(dir: EventDirectory, args: { hours?: number; packageId?: string }): number {
  if (typeof args.hours === 'number' && args.hours > 0) return Math.min(24, args.hours)
  const pkg = findPackage(dir, args.packageId)
  return pkg?.duration_hours ? Number(pkg.duration_hours) : DEFAULT_EVENT_HOURS
}

function quoteFor(dir: EventDirectory, hall: EventHall, pkg: EventPackage | null, guests: number, hours: number): { quote: EventQuote; policy: EventPolicy } {
  const policy = effectivePolicy(dir.settings, hall)
  const usable = pkg && (!pkg.hall_id || pkg.hall_id === hall.id) ? pkg : null
  return { quote: quoteEvent({ hall, pkg: usable, guests, hours, policy }), policy }
}

/**
 * Which halls fit the guests and are free on that date (at that time, for
 * that many hours). Without a time it says which halls have the whole
 * day free. When nothing fits, the next dates with a free hall at that
 * time.
 */
export async function checkHallAvailability(
  db: SupabaseClient,
  accountId: string,
  dir: EventDirectory,
  args: EventAvailabilityArgs,
): Promise<EventAvailability> {
  const hours = hoursFor(dir, args)
  const guests = Math.round(args.guests)
  const base: EventAvailability = { date: args.date, ...(args.time ? { time: args.time } : {}), hours, guests, options: [] }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) return { ...base, error: 'date must be YYYY-MM-DD' }
  if (!(guests >= 1)) return { ...base, error: 'guests is required: ask how many guests' }
  const earliest = addDaysISO(businessToday(), dir.settings.min_notice_days)
  if (args.date < earliest) {
    return { ...base, error: `events need at least ${dir.settings.min_notice_days} days of notice: the earliest date is ${earliest}` }
  }
  const holiday = holidayOn(dir.business, args.date)
  if (holiday) return { ...base, holiday, error: 'that day is a holiday and the business is closed' }
  const hall = findHall(dir, args.hallId)
  const fitting = hall ? [hall] : hallsForGuests(dir.halls, guests)
  if (fitting.length === 0) return { ...base, error: 'no hall fits that many guests: hand off to a person' }
  if (hall && guests > hall.capacity_max) return { ...base, error: `${hall.name} holds at most ${hall.capacity_max} guests` }
  const window = eventWindow(dir, args.date)
  if (!window) return { ...base, error: 'events are not held on that day' }

  const durationMs = hours * 3_600_000
  const start = args.time ? businessLocalToInstant(args.date, args.time).getTime() : window.open
  const end = args.time ? start + durationMs : window.close
  if (args.time && (start < window.open || end > window.close)) {
    return { ...base, error: `events on that day must run between ${businessTime(new Date(window.open))} and ${businessTime(new Date(window.close))}` }
  }
  const busy = await loadHallBusy(db, accountId, start - 86_400_000, addDays(end, 16))
  if (!busy) return { ...base, error: 'the halls could not be looked up' }

  const pkg = findPackage(dir, args.packageId)
  const options = fitting.map((h) => {
    const { quote, policy } = quoteFor(dir, h, pkg, guests, hours)
    return {
      hall_id: h.id,
      hall: h.name,
      capacity: `${h.capacity_min}-${h.capacity_max}`,
      free: hallFree(h, busy, start, end),
      quote: money(quote.total, dir.settings.currency),
      deposit: money(quote.deposit, dir.settings.currency),
      needs_approval: policy.requiresApproval,
    }
  })
  const result: EventAvailability = { ...base, options }
  if (!options.some((o) => o.free)) {
    const alternatives: { date: string; halls: string[] }[] = []
    for (let i = 1; i <= 14 && alternatives.length < 3; i++) {
      const day = addDaysISO(args.date, i)
      const w = eventWindow(dir, day)
      if (!w) continue
      const s = args.time ? businessLocalToInstant(day, args.time).getTime() : w.open
      const e = args.time ? s + durationMs : w.close
      if (args.time && e > w.close) continue
      const free = fitting.filter((h) => hallFree(h, busy, s, e)).map((h) => h.name)
      if (free.length) alternatives.push({ date: day, halls: free })
    }
    result.alternatives = alternatives
  }
  return result
}

function addDays(ms: number, days: number): number {
  return ms + days * 86_400_000
}

export interface EventRequestInput {
  hallId: string
  packageId?: string
  date: string
  time: string
  hours?: number
  guests: number
  eventType?: string
  customerName: string
  customerPhone?: string | null
  notes?: string | null
}

export interface EventRequestResult {
  requested: boolean
  error?: string
  reference?: string
  bookingId?: string
  status?: EventStatus
  hall?: string
  quote?: string | null
  deposit?: string | null
  depositInstructions?: string
}

/**
 * Save an event request on a hall. Where it starts depends on the
 * business: waiting for the owner's approval, waiting for the deposit, or
 * confirmed. The owner hears about it on Telegram.
 */
export async function requestEvent(
  db: SupabaseClient,
  args: {
    accountId: string
    contactId: string
    conversationId?: string | null
    dir: EventDirectory
    input: EventRequestInput
    createdBy?: string | null
    isSample?: boolean
    /** Manual entry: skip notice and hours checks, set this status. */
    force?: boolean
    status?: EventStatus
  },
): Promise<EventRequestResult> {
  const { accountId, dir, input } = args
  try {
    const hall = findHall(dir, input.hallId)
    if (!hall) return { requested: false, error: 'hall_id must be one of the halls listed' }
    const guests = Math.round(input.guests)
    if (!(guests >= 1)) return { requested: false, error: 'guests is required' }
    if (guests > hall.capacity_max) return { requested: false, error: `${hall.name} holds at most ${hall.capacity_max} guests` }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{2}:\d{2}$/.test(input.time)) {
      return { requested: false, error: 'date (YYYY-MM-DD) and time (HH:mm) are required' }
    }
    const hours = hoursFor(dir, input)
    const start = businessLocalToInstant(input.date, input.time).getTime()
    const end = start + hours * 3_600_000
    if (!args.force) {
      const earliest = addDaysISO(businessToday(), dir.settings.min_notice_days)
      if (input.date < earliest) return { requested: false, error: `events need at least ${dir.settings.min_notice_days} days of notice` }
      const window = eventWindow(dir, input.date)
      if (!window || start < window.open || end > window.close) {
        return { requested: false, error: 'the hall is not available at those hours: check availability first' }
      }
    }
    const busy = await loadHallBusy(db, accountId, start - 86_400_000, end + 86_400_000)
    if (!busy) return { requested: false, error: 'the request could not be saved' }
    if (!hallFree(hall, busy, start, end)) return { requested: false, error: 'that hall is already taken at that time: offer another hall or date' }

    const pkg = findPackage(dir, input.packageId)
    const { quote, policy } = quoteFor(dir, hall, pkg, guests, hours)
    const status = args.status ?? initialEventStatus(policy)
    const eventType = input.eventType?.trim().slice(0, 60) || null
    const service = `${eventType ?? 'Evento'} · ${hall.name} · ${guests} invitados`
    const { data: inserted, error } = await db
      .from('bookings')
      .insert({
        account_id: accountId,
        contact_id: args.contactId,
        conversation_id: args.conversationId ?? null,
        kind: 'event',
        service,
        starts_at: new Date(start).toISOString(),
        ends_at: new Date(end).toISOString(),
        status: 'confirmed',
        party_size: guests,
        event_type: eventType,
        event_status: status,
        event_hall_id: hall.id,
        event_package_id: pkg && (!pkg.hall_id || pkg.hall_id === hall.id) ? pkg.id : null,
        quote_amount: quote.total,
        deposit_amount: quote.deposit,
        currency: dir.settings.currency,
        notes: [input.notes?.trim(), quote.breakdown ? `Cotización: ${quote.breakdown}` : null].filter(Boolean).join('\n') || null,
        customer_name: input.customerName.trim().slice(0, 100),
        customer_phone: input.customerPhone?.trim().slice(0, 40) || null,
        created_by: args.createdBy ?? null,
        is_sample: !!args.isSample,
      })
      .select('id')
      .single()
    if (error?.code === OVERLAP_VIOLATION) return { requested: false, error: 'that hall was just taken at that time' }
    if (error || !inserted) {
      console.error('[events] request insert failed:', error)
      return { requested: false, error: 'the request could not be saved' }
    }
    const bookingId = (inserted as { id: string }).id
    const reference = bookingReference(bookingId, 'event')
    const total = money(quote.total, dir.settings.currency)
    const deposit = money(quote.deposit, dir.settings.currency)
    const when = `${input.date} ${input.time} (${hours} h)`

    if (args.conversationId) {
      try {
        await db.from('messages').insert({
          conversation_id: args.conversationId,
          sender_type: 'bot',
          content_type: 'system_event',
          content_text: `Evento ${reference}: ${service}, ${when}`,
          metadata: { kind: 'event_requested', reference, status },
        })
      } catch (err) {
        console.error('[events] system_event insert failed:', err)
      }
    }
    if (!args.isSample && !args.createdBy) {
      void notifyOwner(
        db,
        accountId,
        [
          `🎉 Nueva solicitud de evento ${reference}`,
          `${input.customerName}${input.customerPhone ? ` · ${input.customerPhone}` : ''}`,
          `${service}`,
          `${when}`,
          total ? `Cotización: ${total}${deposit ? ` (depósito ${deposit})` : ''}` : 'Cotización: pendiente',
          status === 'requested' ? 'Pendiente de tu aprobación en Eventos.' : status === 'quoted' ? 'Esperando el depósito.' : 'Confirmado.',
        ].join('\n'),
      )
    }
    return {
      requested: true,
      reference,
      bookingId,
      status,
      hall: hall.name,
      quote: total,
      deposit,
      ...(quote.deposit && dir.settings.deposit_instructions ? { depositInstructions: dir.settings.deposit_instructions } : {}),
    }
  } catch (err) {
    console.error('[events] requestEvent failed:', err)
    return { requested: false, error: 'the request could not be saved' }
  }
}

/** Event status → what to tell the customer, for the tool result. */
export function eventStatusNote(status: EventStatus): string {
  switch (status) {
    case 'requested':
      return 'The request is saved and the hall is held, but the team must approve it: tell the customer they will be contacted to confirm. Do not say it is confirmed.'
    case 'quoted':
      return 'The hall is held pending the deposit: give the customer the deposit amount and how to pay it. It is confirmed once the deposit is received.'
    case 'confirmed':
      return 'The event is confirmed.'
    default:
      return ''
  }
}

