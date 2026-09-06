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
          insert: async (row: Record<string, unknown>) => {
            inserts.push({ table, row })
            return { error: null }
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
    const slots = await checkAvailability(db, 'acct-1', '2026-09-08')
    // Tuesday 09:00-17:00 local => 13:00Z onwards.
    expect(slots.slice(0, 3)).toEqual([
      { startsAt: '2026-09-08T13:00:00.000Z', endsAt: '2026-09-08T14:00:00.000Z' },
      { startsAt: '2026-09-08T14:00:00.000Z', endsAt: '2026-09-08T15:00:00.000Z' },
      { startsAt: '2026-09-08T15:00:00.000Z', endsAt: '2026-09-08T16:00:00.000Z' },
    ])
  })

  it('skips slots that already passed today', async () => {
    const { db } = makeDb()
    const slots = await checkAvailability(db, 'acct-1', '2026-09-07')
    expect(slots[0].startsAt).toBe('2026-09-07T14:00:00.000Z') // 10:00 local, not 09:00
  })

  it('returns nothing on a closed weekday or a holiday', async () => {
    const { db } = makeDb()
    expect(await checkAvailability(db, 'acct-1', '2026-09-09')).toEqual([]) // Wednesday, unset
    const holiday = makeDb({ settings: { hours: HOURS, holidays: ['2026-09-08'] } })
    expect(await checkAvailability(holiday.db, 'acct-1', '2026-09-08')).toEqual([])
  })

  it('treats a booking that started before opening but runs into the day as busy', async () => {
    const { db } = makeDb({
      bookings: [{ starts_at: '2026-09-08T12:30:00.000Z', ends_at: '2026-09-08T13:30:00.000Z' }],
    })
    const slots = await checkAvailability(db, 'acct-1', '2026-09-08')
    expect(slots.map((s) => s.startsAt)).not.toContain('2026-09-08T13:00:00.000Z')
  })
})

describe('confirmAiBooking', () => {
  it('writes the booking and annotates the thread', async () => {
    const { db, inserts } = makeDb()
    expect(await confirmAiBooking(db, { ...ARGS, appointment: APPOINTMENT })).toEqual({
      confirmed: true,
    })
    expect(inserts.map((i) => i.table)).toEqual(['bookings', 'messages'])
    expect(inserts[0].row).toMatchObject({
      account_id: 'acct-1',
      contact_id: 'contact-1',
      starts_at: APPOINTMENT.startsAt,
      created_by: null,
    })
    expect(inserts[1].row.content_text).toBe('Booked Corte for 2026-09-08 11:00')
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
