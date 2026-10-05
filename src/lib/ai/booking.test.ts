import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkAvailability, confirmAiBooking } from './booking'

// Monday 2026-09-07, 10:00 business time (14:00 UTC).
const NOW = new Date('2026-09-07T14:00:00.000Z')

const HOURS = {
  monday: { open: '09:00', close: '17:00' },
  tuesday: { open: '09:00', close: '17:00' },
}

interface FakeOpts {
  bookings?: { starts_at: string; ends_at: string }[]
  settings?: Record<string, unknown>
}

/** Minimal stand-in for the two tables booking.ts touches. Records every
 *  insert so a test can assert what (if anything) was written. */
function makeDb(opts: FakeOpts = {}) {
  const inserts: { table: string; row: Record<string, unknown> }[] = []
  const settings = opts.settings ?? { hours: HOURS, slotMinutes: 60 }

  const db = {
    from(table: string) {
      if (table === 'accounts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { booking_settings: settings }, error: null }),
            }),
          }),
        }
      }
      if (table === 'bookings') {
        return {
          select: () => ({
            eq: () => ({
              neq: () => ({
                gte: () => ({
                  lt: async () => ({ data: opts.bookings ?? [], error: null }),
                }),
              }),
            }),
          }),
          insert: (row: Record<string, unknown>) => {
            inserts.push({ table, row })
            return {
              select: () => ({
                single: async () => ({ data: { id: '3f9a2c1e-0000-4000-8000-000000000000' }, error: null }),
              }),
            }
          },
        }
      }
      return {
        insert: async (row: Record<string, unknown>) => {
          inserts.push({ table, row })
          return { error: null }
        },
      }
    },
  } as unknown as SupabaseClient

  return { db, inserts }
}

const ARGS = { accountId: 'acct-1', contactId: 'contact-1', conversationId: 'conv-1' }
const APPOINTMENT = {
  // Tuesday 11:00 business time.
  startsAt: '2026-09-08T15:00:00.000Z',
  endsAt: '2026-09-08T16:00:00.000Z',
  service: 'Corte',
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('checkAvailability', () => {
  it('offers slots inside the configured business hours, in real UTC instants', async () => {
    const { db } = makeDb()
    const { slots, requested } = await checkAvailability(db, 'acct-1', '2026-09-08')
    expect(requested).toBeUndefined()
    // Tuesday 09:00-17:00 local => 13:00Z onwards.
    expect(slots).toEqual([
      { startsAt: '2026-09-08T13:00:00.000Z', endsAt: '2026-09-08T14:00:00.000Z' },
      { startsAt: '2026-09-08T14:00:00.000Z', endsAt: '2026-09-08T15:00:00.000Z' },
      { startsAt: '2026-09-08T15:00:00.000Z', endsAt: '2026-09-08T16:00:00.000Z' },
    ])
  })

  it('skips slots that already passed today', async () => {
    const { db } = makeDb()
    const { slots } = await checkAvailability(db, 'acct-1', '2026-09-07')
    expect(slots[0].startsAt).toBe('2026-09-07T14:00:00.000Z') // 10:00 local, not 09:00
  })

  it('rolls forward to the next open day when the date is closed or a holiday', async () => {
    const { db } = makeDb()
    // Wednesday is unset -> next open day is Monday 2026-09-14.
    const closed = await checkAvailability(db, 'acct-1', '2026-09-09')
    expect(closed.slots[0].startsAt).toBe('2026-09-14T13:00:00.000Z')

    const holiday = makeDb({ settings: { hours: HOURS, slotMinutes: 60, holidays: ['2026-09-08'] } })
    const res = await checkAvailability(holiday.db, 'acct-1', '2026-09-08')
    expect(res.slots[0].startsAt).toBe('2026-09-14T13:00:00.000Z')
  })

  it('treats a booking that started before opening but runs into the day as busy', async () => {
    const { db } = makeDb({
      bookings: [{ starts_at: '2026-09-08T12:30:00.000Z', ends_at: '2026-09-08T13:30:00.000Z' }],
    })
    const { slots } = await checkAvailability(db, 'acct-1', '2026-09-08')
    expect(slots.map((s) => s.startsAt)).not.toContain('2026-09-08T13:00:00.000Z')
  })

  it('confirms a free requested time and lists it first', async () => {
    const { db } = makeDb()
    const res = await checkAvailability(db, 'acct-1', '2026-09-08', '11:00')
    expect(res.requested).toEqual({ date: '2026-09-08', time: '11:00', available: true })
    expect(res.slots).toHaveLength(3)
    expect(res.slots[0]).toEqual({
      startsAt: '2026-09-08T15:00:00.000Z',
      endsAt: '2026-09-08T16:00:00.000Z',
    })
  })

  it('offers the 3 nearest open slots when the requested time is taken', async () => {
    const { db } = makeDb({
      bookings: [{ starts_at: '2026-09-08T15:00:00.000Z', ends_at: '2026-09-08T16:00:00.000Z' }],
    })
    const res = await checkAvailability(db, 'acct-1', '2026-09-08', '11:00')
    expect(res.requested?.available).toBe(false)
    // 10:00 and 12:00 are 1h away, 09:00 and 13:00 are 2h away (tie -> earlier).
    expect(res.slots.map((s) => s.startsAt)).toEqual([
      '2026-09-08T13:00:00.000Z',
      '2026-09-08T14:00:00.000Z',
      '2026-09-08T16:00:00.000Z',
    ])
  })

  it('offers the nearest slots after hours (8 pm) from the same and next day', async () => {
    const { db } = makeDb()
    const res = await checkAvailability(db, 'acct-1', '2026-09-08', '20:00')
    expect(res.requested?.available).toBe(false)
    // Tue 16:00, 15:00, 14:00 local are 4-6h away; Mon 14 is a week out.
    expect(res.slots.map((s) => s.startsAt)).toEqual([
      '2026-09-08T18:00:00.000Z',
      '2026-09-08T19:00:00.000Z',
      '2026-09-08T20:00:00.000Z',
    ])
  })

  it('finds alternatives on nearby open days when the requested day is closed', async () => {
    const { db } = makeDb()
    // Sunday 2026-09-13 at 10:00: nearest open is Monday 09:00, 10:00, 11:00.
    const res = await checkAvailability(db, 'acct-1', '2026-09-13', '10:00')
    expect(res.requested?.available).toBe(false)
    expect(res.slots.map((s) => s.startsAt)).toEqual([
      '2026-09-14T13:00:00.000Z',
      '2026-09-14T14:00:00.000Z',
      '2026-09-14T15:00:00.000Z',
    ])
  })
})

describe('confirmAiBooking', () => {
  it('writes the booking and annotates the thread', async () => {
    const { db, inserts } = makeDb()
    expect(await confirmAiBooking(db, { ...ARGS, appointment: APPOINTMENT })).toEqual({
      confirmed: true,
      reference: 'CITA-3F9A2C',
    })
    expect(inserts.map((i) => i.table)).toEqual(['bookings', 'messages'])
    expect(inserts[0].row).toMatchObject({
      account_id: 'acct-1',
      contact_id: 'contact-1',
      starts_at: APPOINTMENT.startsAt,
      created_by: null,
    })
    expect(inserts[1].row.content_text).toBe('Booked Corte for 2026-09-08 11:00 (CITA-3F9A2C)')
  })

  it('refuses a slot that is already taken, without writing', async () => {
    const { db, inserts } = makeDb({
      bookings: [{ starts_at: APPOINTMENT.startsAt, ends_at: APPOINTMENT.endsAt }],
    })
    expect(await confirmAiBooking(db, { ...ARGS, appointment: APPOINTMENT })).toEqual({
      confirmed: false,
      error: 'that time is already taken',
    })
    expect(inserts).toEqual([])
  })

  it('refuses a time outside business hours', async () => {
    const { db, inserts } = makeDb()
    const result = await confirmAiBooking(db, {
      ...ARGS,
      appointment: {
        ...APPOINTMENT,
        startsAt: '2026-09-08T22:00:00.000Z', // 18:00 local, after close
        endsAt: '2026-09-08T23:00:00.000Z',
      },
    })
    expect(result).toEqual({ confirmed: false, error: 'that time is outside business hours' })
    expect(inserts).toEqual([])
  })

  it('refuses a day the business is closed', async () => {
    const { db } = makeDb()
    const result = await confirmAiBooking(db, {
      ...ARGS,
      appointment: {
        ...APPOINTMENT,
        startsAt: '2026-09-09T15:00:00.000Z', // Wednesday
        endsAt: '2026-09-09T16:00:00.000Z',
      },
    })
    expect(result).toEqual({ confirmed: false, error: 'the business is closed that day' })
  })

  it('refuses a time in the past', async () => {
    const { db } = makeDb()
    const result = await confirmAiBooking(db, {
      ...ARGS,
      appointment: {
        ...APPOINTMENT,
        startsAt: '2026-09-07T13:00:00.000Z', // 09:00 local, an hour ago
        endsAt: '2026-09-07T14:00:00.000Z',
      },
    })
    expect(result).toEqual({ confirmed: false, error: 'that time is in the past' })
  })
})
