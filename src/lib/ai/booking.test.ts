import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  checkAvailability,
  checkBookingSchedule,
  confirmAiBooking,
  formatBusinessHoursSummary,
  pickProfessionals,
} from './booking'
import type { ClinicDirectory } from '@/lib/clinic/directory'

// Monday 2026-09-07, 10:00 business time (14:00 UTC).
const NOW = new Date('2026-09-07T14:00:00.000Z')

const HOURS = {
  monday: { open: '09:00', close: '17:00' },
  tuesday: { open: '09:00', close: '17:00' },
}

interface FakeOpts {
  bookings?: { starts_at: string; ends_at: string; professional_id?: string | null }[]
  settings?: Record<string, unknown>
  /** Error code the bookings insert fails with (e.g. 23P01). */
  insertErrorCode?: string
  /** Error codes for successive bookings inserts, in order (then success). */
  insertErrorCodes?: string[]
}

/** Minimal stand-in for the two tables booking.ts touches. Records every
 *  insert so a test can assert what (if anything) was written. */
function makeDb(opts: FakeOpts = {}) {
  const inserts: { table: string; row: Record<string, unknown> }[] = []
  const settings = opts.settings ?? { hours: HOURS, slotMinutes: 60 }
  const queuedErrors = [...(opts.insertErrorCodes ?? [])]

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
        // Any chain of filters (eq/not/gte/lt…) resolves to the bookings.
        const chain: Record<string, unknown> = {}
        for (const m of ['eq', 'neq', 'not', 'gte', 'lt', 'in']) chain[m] = () => chain
        chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: opts.bookings ?? [], error: null })
        return {
          select: () => chain,
          insert: (row: Record<string, unknown>) => {
            inserts.push({ table, row })
            const code = queuedErrors.shift() ?? opts.insertErrorCode
            return {
              select: () => ({
                single: async () =>
                  code
                    ? { data: null, error: { code, message: 'insert failed' } }
                    : { data: { id: '3f9a2c1e-0000-4000-8000-000000000000' }, error: null },
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

// ---- Holidays ----------------------------------------------------------

const HOLIDAY_SETTINGS = {
  hours: HOURS,
  slotMinutes: 60,
  holidays: ['2026-09-08'],
  holidayNames: { '2026-09-08': 'Día de prueba' },
}

describe('holidays', () => {
  it('flags a holiday in the availability result, with its name', async () => {
    const { db } = makeDb({ settings: HOLIDAY_SETTINGS })
    const res = await checkAvailability(db, 'acct-1', '2026-09-08', '11:00')
    expect(res.holiday).toEqual({ date: '2026-09-08', name: 'Día de prueba' })
    expect(res.requested?.available).toBe(false)
    expect(res.slots.every((s) => !s.startsAt.startsWith('2026-09-08'))).toBe(true)

    const open = await checkAvailability(makeDb().db, 'acct-1', '2026-09-08', '11:00')
    expect(open.holiday).toBeUndefined()
  })

  it('refuses to book on a holiday, naming it', async () => {
    const { db, inserts } = makeDb({ settings: HOLIDAY_SETTINGS })
    const result = await confirmAiBooking(db, { ...ARGS, appointment: APPOINTMENT })
    expect(result).toEqual({
      confirmed: false,
      error: '2026-09-08 (Día de prueba) is a holiday: the business is closed that day, offer another day',
    })
    expect(inserts).toEqual([])
  })

  it('lists upcoming holidays with their names in the hours summary', () => {
    const summary = formatBusinessHoursSummary({
      ...HOLIDAY_SETTINGS,
      holidays: ['2026-01-01', '2026-09-08', '2026-12-25'],
    })
    expect(summary).toContain('2026-09-08 (Día de prueba), 2026-12-25.')
    expect(summary).not.toContain('2026-01-01')
    expect(summary).toContain('Never book')
  })
})

describe('checkBookingSchedule (no doctor)', () => {
  const check = (db: SupabaseClient, startsAt: string, endsAt: string) =>
    checkBookingSchedule(db, 'acct-1', null, startsAt, endsAt)

  it('reports a holiday, a closed day and a time outside the hours', async () => {
    const { db } = makeDb({ settings: HOLIDAY_SETTINGS })
    expect(await check(db, APPOINTMENT.startsAt, APPOINTMENT.endsAt)).toBe('holiday')
    // Wednesday: no hours.
    expect(await check(db, '2026-09-09T15:00:00.000Z', '2026-09-09T16:00:00.000Z')).toBe('day_off')
    // Monday 18:00 local.
    expect(await check(db, '2026-09-14T22:00:00.000Z', '2026-09-14T23:00:00.000Z')).toBe('outside_hours')
    // Monday 11:00 local.
    expect(await check(db, '2026-09-14T15:00:00.000Z', '2026-09-14T16:00:00.000Z')).toBeNull()
  })

  it('checks nothing but holidays when no hours are saved', async () => {
    const { db } = makeDb({ settings: { holidays: ['2026-09-08'] } })
    expect(await check(db, APPOINTMENT.startsAt, APPOINTMENT.endsAt)).toBe('holiday')
    expect(await check(db, '2026-09-09T15:00:00.000Z', '2026-09-09T16:00:00.000Z')).toBeNull()
  })
})

// ---- Clinic module: one agenda per doctor -------------------------------

const ANA = 'pro-ana'
const LUIS = 'pro-luis'
const DIRECTORY: ClinicDirectory = {
  professionals: [
    { id: ANA, name: 'Dra. Ana Pérez', bio: null, hours: null, slotMinutes: null, specialties: ['Pediatría'] },
    {
      id: LUIS,
      name: 'Dr. Luis Gómez',
      bio: null,
      // Tuesdays from 14:00 only, 30-minute appointments.
      hours: { tuesday: { open: '14:00', close: '16:00' } },
      slotMinutes: 30,
      specialties: ['Cardiología'],
    },
  ],
  specialties: ['Cardiología', 'Pediatría'],
}

describe('pickProfessionals', () => {
  it('narrows by doctor id, by name, or by specialty (accent-insensitive)', () => {
    expect(pickProfessionals(DIRECTORY, LUIS)).toEqual({ professionals: [DIRECTORY.professionals[1]] })
    expect(pickProfessionals(DIRECTORY, 'Ana Perez')).toEqual({ professionals: [DIRECTORY.professionals[0]] })
    expect(pickProfessionals(DIRECTORY, undefined, 'pediatria')).toEqual({
      professionals: [DIRECTORY.professionals[0]],
    })
    expect(pickProfessionals(DIRECTORY)).toEqual({ professionals: DIRECTORY.professionals })
  })

  it('explains an unknown doctor or a specialty nobody offers', () => {
    expect(pickProfessionals(DIRECTORY, 'nobody')).toHaveProperty('error')
    const res = pickProfessionals(DIRECTORY, undefined, 'Dermatología')
    expect('error' in res && res.error).toContain('Cardiología')
  })
})

describe('checkAvailability (clinic)', () => {
  it("uses each doctor's own hours and slot length and tags every slot", async () => {
    const { db } = makeDb()
    const res = await checkAvailability(db, 'acct-1', '2026-09-08', undefined, 3, {
      directory: DIRECTORY,
      professionalId: LUIS,
    })
    // 14:00 local = 18:00Z, 30-minute steps.
    expect(res.slots[0]).toEqual({
      startsAt: '2026-09-08T18:00:00.000Z',
      endsAt: '2026-09-08T18:30:00.000Z',
      professionalId: LUIS,
      professionalName: 'Dr. Luis Gómez',
    })
    expect(res.slots.every((s) => s.professionalId === LUIS)).toBe(true)
  })

  it("only blocks a doctor with their own bookings", async () => {
    // Ana is booked Tuesday 11:00; Luis's bookings don't touch her.
    const { db } = makeDb({
      bookings: [
        { starts_at: '2026-09-08T15:00:00.000Z', ends_at: '2026-09-08T16:00:00.000Z', professional_id: ANA },
        { starts_at: '2026-09-08T13:00:00.000Z', ends_at: '2026-09-08T14:00:00.000Z', professional_id: LUIS },
      ],
    })
    const busy = await checkAvailability(db, 'acct-1', '2026-09-08', '11:00', 3, {
      directory: DIRECTORY,
      professionalId: ANA,
    })
    expect(busy.requested?.available).toBe(false)

    const free = await checkAvailability(db, 'acct-1', '2026-09-08', '09:00', 3, {
      directory: DIRECTORY,
      professionalId: ANA,
    })
    expect(free.requested?.available).toBe(true)
    expect(free.slots[0]).toMatchObject({ startsAt: '2026-09-08T13:00:00.000Z', professionalId: ANA })
  })

  it('returns an error for a specialty nobody offers', async () => {
    const { db } = makeDb()
    const res = await checkAvailability(db, 'acct-1', '2026-09-08', undefined, 3, {
      directory: DIRECTORY,
      specialty: 'Dermatología',
    })
    expect(res.slots).toEqual([])
    expect(res.error).toBeTruthy()
  })
})

describe('confirmAiBooking (clinic)', () => {
  it('books with the chosen doctor', async () => {
    const { db, inserts } = makeDb()
    const result = await confirmAiBooking(db, {
      ...ARGS,
      appointment: { ...APPOINTMENT, professionalId: ANA },
      directory: DIRECTORY,
    })
    expect(result).toMatchObject({ confirmed: true, professional: 'Dra. Ana Pérez' })
    expect(inserts[0].row).toMatchObject({ professional_id: ANA })
    expect(inserts[1].row.content_text).toContain('with Dra. Ana Pérez')
  })

  it('requires a doctor when there are several', async () => {
    const { db, inserts } = makeDb()
    const result = await confirmAiBooking(db, { ...ARGS, appointment: APPOINTMENT, directory: DIRECTORY })
    expect(result.confirmed).toBe(false)
    expect(result.error).toContain('professional_id')
    expect(inserts).toEqual([])
  })

  it("refuses a time outside the doctor's own hours", async () => {
    const { db, inserts } = makeDb()
    const result = await confirmAiBooking(db, {
      ...ARGS,
      appointment: { ...APPOINTMENT, professionalId: LUIS }, // 11:00, Luis starts at 14:00
      directory: DIRECTORY,
    })
    expect(result.confirmed).toBe(false)
    expect(inserts).toEqual([])
  })

  it('reports a slot taken by a concurrent booking (exclusion constraint)', async () => {
    const { db } = makeDb({ insertErrorCode: '23P01' })
    const result = await confirmAiBooking(db, {
      ...ARGS,
      appointment: { ...APPOINTMENT, professionalId: ANA },
      directory: DIRECTORY,
    })
    expect(result).toEqual({ confirmed: false, error: 'that time is already taken' })
  })
})

// ---- Clinic module, migration 067: services, days off, insurance --------

const ECO = {
  id: 'svc-eco',
  name: 'Ecocardiograma',
  description: null,
  specialty: 'Cardiología',
  durationMinutes: 45,
  price: null,
}
const CONSULTA = { ...ECO, id: 'svc-consulta', name: 'Consulta', specialty: null, durationMinutes: 20 }
const EXTENDED: ClinicDirectory = {
  ...DIRECTORY,
  professionals: DIRECTORY.professionals.map((p) =>
    p.id === ANA ? { ...p, timeOff: [{ from: '2026-09-08', to: '2026-09-08' }] } : p,
  ),
  services: [ECO, CONSULTA],
}

describe('checkAvailability (clinic services and days off)', () => {
  it('gives a doctor on time off no slots that day', async () => {
    const { db } = makeDb()
    const res = await checkAvailability(db, 'acct-1', '2026-09-08', '11:00', 3, {
      directory: EXTENDED,
      professionalId: ANA,
    })
    expect(res.requested?.available).toBe(false)
    expect(res.slots.every((s) => !s.startsAt.startsWith('2026-09-08'))).toBe(true)
  })

  it('only searches the doctors who offer the service, with its length', async () => {
    const { db } = makeDb()
    const res = await checkAvailability(db, 'acct-1', '2026-09-08', undefined, 3, {
      directory: EXTENDED,
      serviceId: 'svc-eco',
    })
    expect(res.slots.length).toBeGreaterThan(0)
    expect(res.slots.every((s) => s.professionalId === LUIS)).toBe(true)
    // 45 minutes, not Luis's 30-minute grid step.
    expect(res.slots[0]).toMatchObject({ startsAt: '2026-09-08T18:00:00.000Z', endsAt: '2026-09-08T18:45:00.000Z' })
  })

  it('explains a service the chosen doctor does not offer', async () => {
    const { db } = makeDb()
    const res = await checkAvailability(db, 'acct-1', '2026-09-08', undefined, 3, {
      directory: EXTENDED,
      professionalId: ANA,
      serviceId: 'svc-eco',
    })
    expect(res.slots).toEqual([])
    expect(res.error).toBeTruthy()
  })
})

describe('confirmAiBooking (clinic services, days off, insurance)', () => {
  it('refuses a doctor on time off', async () => {
    const { db, inserts } = makeDb()
    const result = await confirmAiBooking(db, {
      ...ARGS,
      appointment: { ...APPOINTMENT, professionalId: ANA },
      directory: EXTENDED,
    })
    expect(result.confirmed).toBe(false)
    expect(result.error).toContain('time off')
    expect(inserts).toEqual([])
  })

  it("sets the end from the service length and saves the service", async () => {
    const { db, inserts } = makeDb()
    const result = await confirmAiBooking(db, {
      ...ARGS,
      // Tuesday 14:00 local with Luis.
      appointment: {
        ...APPOINTMENT,
        startsAt: '2026-09-08T18:00:00.000Z',
        endsAt: '2026-09-08T18:30:00.000Z',
        professionalId: LUIS,
        serviceId: 'svc-eco',
      },
      directory: EXTENDED,
    })
    expect(result.confirmed).toBe(true)
    expect(inserts[0].row).toMatchObject({
      service: 'Ecocardiograma',
      ends_at: '2026-09-08T18:45:00.000Z',
      clinic_service_id: 'svc-eco',
      insurance: null,
    })
  })

  it("refuses a service the doctor doesn't offer", async () => {
    const { db, inserts } = makeDb()
    const result = await confirmAiBooking(db, {
      ...ARGS,
      appointment: { ...APPOINTMENT, startsAt: '2026-09-09T15:00:00.000Z', endsAt: '2026-09-09T16:00:00.000Z', professionalId: ANA, serviceId: 'svc-eco' },
      directory: EXTENDED,
    })
    expect(result).toEqual({ confirmed: false, error: 'Dra. Ana Pérez does not offer "Ecocardiograma"' })
    expect(inserts).toEqual([])
  })

  it('requires the insurance when the clinic asks for it', async () => {
    const directory = { ...DIRECTORY, insurance: { ask: true, insurers: [] } }
    const { db, inserts } = makeDb()
    const missing = await confirmAiBooking(db, {
      ...ARGS,
      appointment: { ...APPOINTMENT, professionalId: ANA },
      directory,
    })
    expect(missing.confirmed).toBe(false)
    expect(missing.error).toContain('insurance is required')
    expect(inserts).toEqual([])

    const ok = await confirmAiBooking(db, {
      ...ARGS,
      appointment: { ...APPOINTMENT, professionalId: ANA, insurance: 'Humano, afiliado 123' },
      directory,
    })
    expect(ok.confirmed).toBe(true)
    expect(inserts[0].row).toMatchObject({ insurance: 'Humano, afiliado 123', clinic_service_id: null })
  })

  it('keeps the insurance in the notes before migration 067', async () => {
    const { db, inserts } = makeDb({ insertErrorCodes: ['42703'] })
    const result = await confirmAiBooking(db, {
      ...ARGS,
      appointment: { ...APPOINTMENT, professionalId: ANA, insurance: 'privado', notes: 'primera vez' },
      directory: DIRECTORY,
    })
    expect(result.confirmed).toBe(true)
    expect(inserts[1].row).not.toHaveProperty('insurance')
    expect(inserts[1].row).toMatchObject({ notes: 'Seguro: privado — primera vez' })
  })
})
