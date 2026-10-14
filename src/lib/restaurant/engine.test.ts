import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { rescheduleTableReservation, type RestaurantDirectory } from './engine'
import { DEFAULT_RESTAURANT_SETTINGS } from './settings'
import type { FloorTable } from './tables'

function table(id: string, max: number): FloorTable {
  return { id, name: `Mesa ${id}`, areaId: 'salon', areaName: 'Salón', minParty: 1, maxParty: max, combinable: true }
}

const DIR: RestaurantDirectory = {
  settings: { ...DEFAULT_RESTAURANT_SETTINGS, buffer_minutes: 0 },
  tables: [table('1', 2), table('2', 4), table('3', 4)],
  areas: [],
  business: null,
  waitlist: false,
}

interface Hold {
  booking_id: string
  table_id: string
  starts_at: string
  ends_at: string
  account_id?: string
}

/** Just enough of the Supabase client for rescheduleTableReservation:
 *  booking_tables holds, the booking row and reminder sends. */
function fakeDb(holds: Hold[], booking: { id: string; starts_at: string }) {
  const log: { table: string; op: string; payload?: unknown }[] = []
  const db = {
    from(name: string) {
      let op = 'select'
      let payload: unknown
      const filters: [string, unknown][] = []
      const result = () => {
        log.push({ table: name, op, payload })
        if (name === 'booking_tables') {
          if (op === 'delete') {
            const id = filters.find(([k]) => k === 'booking_id')?.[1]
            for (let i = holds.length - 1; i >= 0; i--) if (holds[i].booking_id === id) holds.splice(i, 1)
            return { data: null, error: null }
          }
          if (op === 'insert') {
            holds.push(...(payload as Hold[]))
            return { data: null, error: null }
          }
          const id = filters.find(([k]) => k === 'booking_id')?.[1]
          return { data: id ? holds.filter((h) => h.booking_id === id) : [...holds], error: null }
        }
        if (name === 'bookings') {
          if (op === 'update') return { data: [{ id: booking.id }], error: null }
          return { data: booking, error: null }
        }
        return { data: null, error: null }
      }
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => (filters.push([k, v]), q),
        lt: () => q,
        gt: () => q,
        maybeSingle: () => Promise.resolve(result()),
        delete: () => ((op = 'delete'), q),
        insert: (p: unknown) => ((op = 'insert'), (payload = p), Promise.resolve(result())),
        update: (p: unknown) => ((op = 'update'), (payload = p), q),
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, ko),
      }
      return q
    },
  }
  return { db: db as unknown as SupabaseClient, log }
}

const START = '2020-01-10T23:00:00.000Z'
const END = '2020-01-11T00:30:00.000Z'

describe('rescheduleTableReservation with tables chosen by hand', () => {
  it('holds the chosen tables for the same window, even in the past, without resending reminders', async () => {
    const holds: Hold[] = [{ booking_id: 'ai', table_id: '1', starts_at: START, ends_at: END }]
    const { db, log } = fakeDb(holds, { id: 'ai', starts_at: START })
    const res = await rescheduleTableReservation(db, {
      accountId: 'acc',
      dir: DIR,
      bookingId: 'ai',
      startsAt: START,
      partySize: 6,
      durationMinutes: 90,
      tableIds: ['2', '3'],
      seating: 'separate',
      force: true,
    })
    expect(res).toMatchObject({ rescheduled: true, tables: ['Mesa 2', 'Mesa 3'] })
    expect(holds.map((h) => h.table_id).sort()).toEqual(['2', '3'])
    expect(holds.every((h) => h.starts_at === START && h.ends_at === END)).toBe(true)
    const update = log.find((l) => l.table === 'bookings' && l.op === 'update')?.payload as Record<string, unknown>
    expect(update.seating).toBe('separate')
    expect(log.some((l) => l.table === 'booking_reminder_sends')).toBe(false)
  })

  it('refuses a table another reservation holds at that time and keeps the old one', async () => {
    const holds: Hold[] = [
      { booking_id: 'ai', table_id: '1', starts_at: START, ends_at: END },
      { booking_id: 'other', table_id: '2', starts_at: START, ends_at: END },
    ]
    const { db } = fakeDb(holds, { id: 'ai', starts_at: START })
    const res = await rescheduleTableReservation(db, {
      accountId: 'acc',
      dir: DIR,
      bookingId: 'ai',
      startsAt: START,
      partySize: 2,
      durationMinutes: 90,
      tableIds: ['2'],
      force: true,
    })
    expect(res).toMatchObject({ rescheduled: false, error: 'that table is already taken at that time', tables: ['Mesa 2'] })
    expect(holds.find((h) => h.booking_id === 'ai')?.table_id).toBe('1')
  })

  it('refuses unknown tables, and past times unless forced', async () => {
    const { db } = fakeDb([], { id: 'ai', starts_at: START })
    const base = { accountId: 'acc', dir: DIR, bookingId: 'ai', startsAt: START, partySize: 2, durationMinutes: 90 }
    expect(await rescheduleTableReservation(db, { ...base, tableIds: ['9'], force: true })).toMatchObject({ error: 'unknown table' })
    expect(await rescheduleTableReservation(db, { ...base, tableIds: ['1'] })).toMatchObject({ rescheduled: false })
  })
})
