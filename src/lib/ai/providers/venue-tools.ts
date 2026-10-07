import type { PreorderItem, TableSeating } from '@/types'
import { businessDate, businessTime, businessWeekday, normalizeAiTimestamp } from '@/lib/business-timezone'
import type {
  TableAvailability,
  TableAvailabilityArgs,
  TableReservationInput,
  TableReservationResult,
  WaitlistInput,
} from '@/lib/restaurant/engine'
import type { EventAvailability, EventAvailabilityArgs, EventRequestInput, EventRequestResult } from '@/lib/events/engine'

// ============================================================
// Restaurant and events tools (migration 068), shared by both adapters
// through `bookingToolDefinitions` / `runBookingTool` in shared.ts.
//
// Table offers are text only (no WhatsApp buttons): a table depends on
// the party size and possibly the customer's consent to several tables,
// which a one-tap button can't carry.
// ============================================================

export const CHECK_TABLE_AVAILABILITY_TOOL_NAME = 'check_table_availability'
export const BOOK_TABLE_TOOL_NAME = 'book_table'
export const JOIN_WAITLIST_TOOL_NAME = 'join_waitlist'
export const CHECK_EVENT_AVAILABILITY_TOOL_NAME = 'check_event_availability'
export const REQUEST_EVENT_TOOL_NAME = 'request_event'

export interface RestaurantToolExec {
  check: (args: TableAvailabilityArgs) => Promise<TableAvailability>
  /** Saves the reservation. Absent in the Playground, where the tool
   *  only acknowledges. */
  book?: (input: TableReservationInput) => Promise<TableReservationResult>
  /** Present when the waitlist module is on. */
  waitlist?: (input: WaitlistInput) => Promise<{ added: boolean; error?: string; position?: number }>
  waitlistEnabled: boolean
  allowPreorder: boolean
  allowCombine: boolean
  areas: string[]
}

export interface EventToolExec {
  check: (args: EventAvailabilityArgs) => Promise<EventAvailability>
  /** Saves the request. Absent in the Playground. */
  request?: (input: EventRequestInput) => Promise<EventRequestResult & { note?: string }>
  eventTypes: string[]
}

export interface VenueTools {
  restaurant?: RestaurantToolExec
  events?: EventToolExec
}

interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

const NAME_PARAM = { type: 'string', description: "The customer's full name." }
const PHONE_PARAM = { type: 'string', description: 'The phone number the customer gave. It is how they find the reservation again.' }

export function venueToolDefinitions(venue: VenueTools): ToolDef[] {
  const defs: ToolDef[] = []
  const r = venue.restaurant
  if (r) {
    defs.push({
      name: CHECK_TABLE_AVAILABILITY_TOOL_NAME,
      description:
        'Look up free restaurant tables for a party. Pass the date, the number of people and the time whenever the customer named one: the result says whether that exact time works and lists the closest alternatives (possibly other days). Pass duration_minutes only when the customer asked for a longer or shorter reservation than the default. An option with combined: true needs several tables.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD.' },
          time: { type: 'string', description: 'Optional. 24-hour HH:mm, business local time.' },
          party_size: { type: 'integer', description: 'How many people.' },
          duration_minutes: { type: 'integer', description: 'Optional. How long they want the table, in minutes.' },
          ...(r.areas.length ? { area: { type: 'string', description: `Optional. Only this area: ${r.areas.join(', ')}.` } } : {}),
        },
        required: ['date', 'party_size'],
      },
    })
    defs.push({
      name: BOOK_TABLE_TOOL_NAME,
      description:
        'Reserve a table once the customer accepted one of the times check_table_availability offered and gave their full name and phone.' +
        (r.allowCombine
          ? ' When the option needs several tables (combined), you MUST first ask the customer whether they mind, and whether they prefer the tables joined together or separate tables side by side; only then call it with customer_agreed true and seating.'
          : ''),
      parameters: {
        type: 'object',
        properties: {
          startsAt: { type: 'string', description: 'ISO 8601 start, exactly as offered.' },
          party_size: { type: 'integer', description: 'How many people.' },
          duration_minutes: { type: 'integer', description: 'Optional. The same length you checked with, when the customer asked for one.' },
          customerName: NAME_PARAM,
          customerPhone: PHONE_PARAM,
          ...(r.allowCombine
            ? {
                customer_agreed: { type: 'boolean', description: 'True once the customer said they don\'t mind several tables.' },
                seating: {
                  type: 'string',
                  enum: ['joined', 'separate'],
                  description: 'For several tables: joined together, or separate tables side by side — as the customer prefers.',
                },
              }
            : {}),
          ...(r.areas.length ? { area: { type: 'string', description: 'Optional. The area they asked for.' } } : {}),
          occasion: { type: 'string', description: 'Optional. Birthday, anniversary, business dinner…' },
          notes: { type: 'string', description: 'Optional. Allergies, high chair, other requests.' },
          ...(r.allowPreorder
            ? {
                preorder: {
                  type: 'array',
                  description: 'Optional. Dishes the customer wants ready on arrival, from the catalog.',
                  items: {
                    type: 'object',
                    properties: {
                      item: { type: 'string' },
                      qty: { type: 'integer' },
                      notes: { type: 'string' },
                    },
                    required: ['item', 'qty'],
                  },
                },
              }
            : {}),
        },
        required: ['startsAt', 'party_size', 'customerName', 'customerPhone'],
      },
    })
    if (r.waitlistEnabled) {
      defs.push({
        name: JOIN_WAITLIST_TOOL_NAME,
        description:
          'Put the customer on the waitlist for a day when no table works for them and they want to be told if one frees up. Never promise a table: the team contacts them if one opens.',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'YYYY-MM-DD.' },
            party_size: { type: 'integer', description: 'How many people.' },
            preferred_time: { type: 'string', description: 'Optional. The time they wanted, HH:mm or a range like 20:00-21:30.' },
            customerName: NAME_PARAM,
            customerPhone: PHONE_PARAM,
            notes: { type: 'string', description: 'Optional.' },
          },
          required: ['date', 'party_size', 'customerName', 'customerPhone'],
        },
      })
    }
  }
  const e = venue.events
  if (e) {
    defs.push({
      name: CHECK_EVENT_AVAILABILITY_TOOL_NAME,
      description:
        'Check which event halls fit the guests and are free on a date (at a time, for some hours), with the price quote and deposit when there is one. Use it for parties, weddings, corporate events and other private events — not for normal table reservations.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD.' },
          time: { type: 'string', description: 'Optional. Start time, 24-hour HH:mm.' },
          hours: { type: 'number', description: 'Optional. How many hours (default: the package length, else 4).' },
          guests: { type: 'integer', description: 'How many guests.' },
          hall_id: { type: 'string', description: 'Optional. Only this hall.' },
          package_id: { type: 'string', description: 'Optional. The package they chose, to quote it.' },
        },
        required: ['date', 'guests'],
      },
    })
    defs.push({
      name: REQUEST_EVENT_TOOL_NAME,
      description:
        'Save an event request on a free hall once the customer agreed to the hall, date, time and quote, and gave their full name and phone. The result says whether it still needs the owner\'s approval or a deposit: tell the customer exactly that, never more.',
      parameters: {
        type: 'object',
        properties: {
          hall_id: { type: 'string' },
          package_id: { type: 'string', description: 'Optional.' },
          date: { type: 'string', description: 'YYYY-MM-DD.' },
          time: { type: 'string', description: 'Start, 24-hour HH:mm.' },
          hours: { type: 'number', description: 'Optional. How many hours.' },
          guests: { type: 'integer' },
          event_type: {
            type: 'string',
            description: e.eventTypes.length ? `The kind of event, e.g. ${e.eventTypes.join(', ')}.` : 'The kind of event.',
          },
          customerName: NAME_PARAM,
          customerPhone: PHONE_PARAM,
          notes: { type: 'string', description: 'Optional. Decoration, menu, music, other requests.' },
        },
        required: ['hall_id', 'date', 'time', 'guests', 'customerName', 'customerPhone'],
      },
    })
  }
  return defs
}

type Args = Record<string, unknown>

function str(args: Args, key: string): string {
  return typeof args[key] === 'string' ? (args[key] as string).trim() : ''
}

function int(args: Args, key: string): number | undefined {
  const v = args[key]
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function hhmm(raw: string): string | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw)
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : undefined
}

function phoneOk(phone: string): boolean {
  return phone.replace(/\D/g, '').length >= 7
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function tableOfferToToolResult(result: TableAvailability): string {
  if (result.error) return JSON.stringify({ available: false, error: result.error, ...(result.holiday ? { holiday: result.holiday } : {}) })
  const options = result.slots.map((s) => ({
    startsAt: s.startsAt,
    date: businessDate(s.startsAt),
    weekday: WEEKDAY_NAMES[businessWeekday(businessDate(s.startsAt))],
    time: businessTime(s.startsAt),
    until: businessTime(s.endsAt),
    tables: s.tables.join(' + '),
    ...(s.area ? { area: s.area } : {}),
    ...(s.combined
      ? { combined: true, note: 'Needs several tables: ask whether they mind and whether they prefer them joined or separate before booking.' }
      : {}),
  }))
  return JSON.stringify({
    party_size: result.partySize,
    duration_minutes: result.durationMinutes,
    ...(result.requested ? { requested: result.requested } : {}),
    ...(result.holiday ? { holiday: { ...result.holiday, note: 'Closed for a holiday that day.' } } : {}),
    options,
    note:
      options.length === 0
        ? 'No table is free for that party on or near that date.'
        : result.requested && !result.requested.available
          ? 'The requested time is NOT available; the options are the closest free times. Offer them as text.'
          : 'Offer these as text; when the requested time is free it is the first option.',
  })
}

function parsePreorder(raw: unknown): PreorderItem[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const items = raw
    .map((r) => (typeof r === 'object' && r !== null ? (r as Args) : {}))
    .map((r) => ({ item: str(r, 'item').slice(0, 120), qty: Math.min(99, Math.round(int(r, 'qty') ?? 1)), notes: str(r, 'notes').slice(0, 200) || null }))
    .filter((r) => r.item)
  return items.length ? items.slice(0, 30) : undefined
}

/** Run a venue tool, or null when `name` isn't one. */
export async function runVenueTool(venue: VenueTools, name: string, rawArgs: unknown): Promise<string | null> {
  const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Args
  const r = venue.restaurant
  const e = venue.events
  try {
    if (r && name === CHECK_TABLE_AVAILABILITY_TOOL_NAME) {
      const date = str(args, 'date')
      const partySize = int(args, 'party_size')
      if (!date || !partySize) return JSON.stringify({ error: 'date and party_size are required: ask how many people and which day.' })
      const area = str(args, 'area')
      const result = await r.check({
        date,
        time: hhmm(str(args, 'time')),
        partySize,
        durationMinutes: int(args, 'duration_minutes'),
        ...(area ? { area } : {}),
      })
      return tableOfferToToolResult(result)
    }

    if (r && name === BOOK_TABLE_TOOL_NAME) {
      const startsAt = normalizeAiTimestamp(str(args, 'startsAt'))
      const partySize = int(args, 'party_size')
      const customerName = str(args, 'customerName').slice(0, 100)
      const customerPhone = str(args, 'customerPhone').slice(0, 40)
      if (!startsAt) return JSON.stringify({ confirmed: false, error: 'startsAt must be one of the offered times.' })
      if (!partySize) return JSON.stringify({ confirmed: false, error: 'party_size is required.' })
      if (!customerName) return JSON.stringify({ confirmed: false, error: 'customerName is required: ask for their full name.' })
      if (!phoneOk(customerPhone)) return JSON.stringify({ confirmed: false, error: 'customerPhone is required: ask for their phone number.' })
      const seatingRaw = str(args, 'seating')
      const seating: TableSeating | undefined = seatingRaw === 'joined' || seatingRaw === 'separate' ? seatingRaw : undefined
      const input: TableReservationInput = {
        startsAt,
        partySize,
        durationMinutes: int(args, 'duration_minutes'),
        customerName,
        customerPhone,
        seating,
        customerAgreed: args.customer_agreed === true,
        ...(str(args, 'area') ? { area: str(args, 'area') } : {}),
        occasion: str(args, 'occasion') || null,
        notes: str(args, 'notes') || null,
        preorder: r.allowPreorder ? parsePreorder(args.preorder) ?? null : null,
      }
      if (!r.book) return JSON.stringify({ confirmed: true, note: 'Test mode: nothing was saved.' })
      const out = await r.book(input)
      if (!out.confirmed) return JSON.stringify(out)
      return JSON.stringify({
        confirmed: true,
        reference: out.reference,
        date: businessDate(startsAt),
        time: businessTime(startsAt),
        until: out.endsAt ? businessTime(out.endsAt) : undefined,
        duration_minutes: out.durationMinutes,
        tables: out.tables?.join(' + '),
        seating: out.seating,
        note: 'Give the customer the reference code; they need it with their phone to change or cancel.',
      })
    }

    if (r && name === JOIN_WAITLIST_TOOL_NAME) {
      const date = str(args, 'date')
      const partySize = int(args, 'party_size')
      const customerName = str(args, 'customerName')
      const customerPhone = str(args, 'customerPhone')
      if (!date || !partySize) return JSON.stringify({ added: false, error: 'date and party_size are required.' })
      if (!customerName || !phoneOk(customerPhone)) {
        return JSON.stringify({ added: false, error: 'customerName and customerPhone are required.' })
      }
      if (!r.waitlist) return JSON.stringify({ added: true, note: 'Test mode: nothing was saved.' })
      const out = await r.waitlist({
        date,
        partySize,
        preferredTime: str(args, 'preferred_time') || undefined,
        customerName,
        customerPhone,
        notes: str(args, 'notes') || null,
      })
      return JSON.stringify(
        out.added
          ? { ...out, note: 'They are on the waitlist. Say the team will write if a table frees up; never promise one.' }
          : out,
      )
    }

    if (e && name === CHECK_EVENT_AVAILABILITY_TOOL_NAME) {
      const date = str(args, 'date')
      const guests = int(args, 'guests')
      if (!date || !guests) return JSON.stringify({ error: 'date and guests are required.' })
      const result = await e.check({
        date,
        time: hhmm(str(args, 'time')),
        hours: int(args, 'hours'),
        guests,
        hallId: str(args, 'hall_id') || undefined,
        packageId: str(args, 'package_id') || undefined,
      })
      return JSON.stringify({
        ...result,
        note: result.error
          ? undefined
          : 'Halls with free: true can be requested. quote null means the team sends the price. Mention the deposit when there is one.',
      })
    }

    if (e && name === REQUEST_EVENT_TOOL_NAME) {
      const hallId = str(args, 'hall_id')
      const date = str(args, 'date')
      const time = hhmm(str(args, 'time'))
      const guests = int(args, 'guests')
      const customerName = str(args, 'customerName')
      const customerPhone = str(args, 'customerPhone')
      if (!hallId || !date || !time || !guests) {
        return JSON.stringify({ requested: false, error: 'hall_id, date, time and guests are required.' })
      }
      if (!customerName || !phoneOk(customerPhone)) {
        return JSON.stringify({ requested: false, error: 'customerName and customerPhone are required.' })
      }
      if (!e.request) return JSON.stringify({ requested: true, note: 'Test mode: nothing was saved.' })
      const out = await e.request({
        hallId,
        packageId: str(args, 'package_id') || undefined,
        date,
        time,
        hours: int(args, 'hours'),
        guests,
        eventType: str(args, 'event_type') || undefined,
        customerName,
        customerPhone,
        notes: str(args, 'notes') || null,
      })
      return JSON.stringify(out)
    }
  } catch (err) {
    console.error(`[ai venue] ${name} executor threw:`, err)
    return JSON.stringify({ error: 'that could not be done right now' })
  }
  return null
}
