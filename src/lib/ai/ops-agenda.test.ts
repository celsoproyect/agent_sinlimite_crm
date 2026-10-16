import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const { googleBusy, syncBookingToGoogle, checkBookingSchedule } = vi.hoisted(() => ({
  googleBusy: vi.fn(async () => [] as { start: number; end: number }[]),
  syncBookingToGoogle: vi.fn(async () => undefined),
  checkBookingSchedule: vi.fn(async () => null as string | null),
}))
vi.mock('@/lib/google-calendar/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/google-calendar/sync')>()),
  googleBusy,
  syncBookingToGoogle,
  listGoogleEvents: vi.fn(async () => []),
}))
vi.mock('./booking', () => ({ checkBookingSchedule, holidayOn: () => null, loadBookingSettings: async () => null }))
vi.mock('@/lib/clinic/directory', () => ({ getClinicDirectory: async () => null, resolveProfessional: () => null }))
vi.mock('@/lib/contacts/dedupe', () => ({ findExistingContact: async () => null }))
vi.mock('@/lib/api/v1/contacts', () => ({ resolveAuditUserId: async () => 'owner-1' }))

import { normalizeTime, OPS_READ_AGENDA_TOOLS, OPS_WRITE_AGENDA_TOOLS, overlaps, referenceKey } from './ops-agenda'
import { opsTools, runOpsTool } from './ops-assistant'
import { splitTelegramText } from '@/lib/telegram/send'
import { eventsToAgenda } from '@/lib/google-calendar/sync'

interface Row {
  [k: string]: unknown
}

/** Minimal Supabase stand-in: canned rows per table, records writes. */
function fakeDb(tables: Record<string, Row[]>) {
  const writes: { table: string; op: string; payload?: unknown }[] = []
  const db = {
    from(name: string) {
      let op = 'select'
      let payload: unknown
      const result = () => {
        if (op !== 'select') writes.push({ table: name, op, payload })
        if (op === 'insert') return { data: { id: 'abcdef12-0000-0000-0000-000000000000' }, error: null }
        if (op === 'update') return { data: [{ id: 'x' }], error: null }
        return { data: tables[name] ?? [], error: null }
      }
      const q: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'lt', 'gt', 'order', 'limit', 'ilike']) q[m] = () => q
      q.insert = (p: unknown) => ((op = 'insert'), (payload = p), q)
      q.update = (p: unknown) => ((op = 'update'), (payload = p), q)
      q.delete = () => ((op = 'delete'), q)
      q.single = () => Promise.resolve(result())
      q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, ko)
      return q
    },
  }
  return { db: db as unknown as SupabaseClient, writes }
}

const tool = (name: string) => [...OPS_READ_AGENDA_TOOLS, ...OPS_WRITE_AGENDA_TOOLS].find((t) => t.name === name)!
const ctx = { embeddings: { embeddingsApiKey: null } }

beforeEach(() => {
  vi.clearAllMocks()
  googleBusy.mockResolvedValue([])
  checkBookingSchedule.mockResolvedValue(null)
})

describe('agenda helpers', () => {
  it('reads reference codes in any shape', () => {
    expect(referenceKey('CITA-3F2A1B')).toBe('3f2a1b')
    expect(referenceKey('cita 3f2a1b')).toBe('3f2a1b')
    expect(referenceKey('3F2A1B')).toBe('3f2a1b')
    expect(referenceKey('mañana')).toBeNull()
  })

  it('normalizes 24-hour times', () => {
    expect(normalizeTime('9:05')).toBe('09:05')
    expect(normalizeTime('15:30')).toBe('15:30')
    expect(normalizeTime('25:00')).toBeNull()
    expect(normalizeTime('3pm')).toBeNull()
  })

  it('treats touching intervals as free', () => {
    expect(overlaps({ start: 0, end: 10 }, { start: 10, end: 20 })).toBe(false)
    expect(overlaps({ start: 0, end: 11 }, { start: 10, end: 20 })).toBe(true)
  })

  it('splits long Telegram texts at line breaks', () => {
    const text = Array.from({ length: 10 }, (_, i) => `línea ${i} ${'x'.repeat(10)}`).join('\n')
    const parts = splitTelegramText(text, 50)
    expect(parts.every((p) => p.length <= 50)).toBe(true)
    expect(parts.join('\n')).toBe(text)
    expect(splitTelegramText('hola')).toEqual(['hola'])
  })

  it('reads out Google events in business time, without the CRM mirrors', () => {
    const agenda = eventsToAgenda([
      { id: '1', summary: 'Dentista', start: { dateTime: '2026-10-20T14:00:00Z' }, end: { dateTime: '2026-10-20T15:00:00Z' } },
      { id: '2', summary: 'Cita CRM', start: { dateTime: '2026-10-20T13:00:00Z' }, extendedProperties: { private: { wacrmBookingId: 'b' } } },
      { id: '3', summary: 'Feriado', start: { date: '2026-10-19' }, end: { date: '2026-10-20' } },
      { id: '4', status: 'cancelled', start: { dateTime: '2026-10-20T16:00:00Z' } },
    ])
    expect(agenda).toEqual([
      { title: 'Feriado', date: '2026-10-19', allDay: true },
      { title: 'Dentista', date: '2026-10-20', time: '10:00', endsAt: '11:00' },
    ])
  })
})

describe('agenda write tools', () => {
  it('are only offered with the telegram_agenda module on', async () => {
    const names = (agenda: boolean) => opsTools({ agenda }).map((t) => t.name)
    expect(names(false)).toContain('list_agenda')
    expect(names(false)).toContain('list_services_and_prices')
    expect(names(false)).not.toContain('create_booking')
    expect(names(true)).toEqual(expect.arrayContaining(['create_booking', 'move_booking', 'cancel_booking']))
    const { db } = fakeDb({})
    expect(JSON.parse(await runOpsTool(db, 'acc', 'create_booking', {}, ctx))).toEqual({ error: 'unknown tool' })
  })

  it('reports clashes instead of booking, unless forced', async () => {
    const { db, writes } = fakeDb({
      bookings: [
        {
          id: '0123456789',
          kind: 'appointment',
          status: 'confirmed',
          service: 'Consulta',
          starts_at: '2099-01-05T14:00:00Z',
          ends_at: '2099-01-05T15:00:00Z',
          notes: null,
          contacts: { name: 'Ana' },
        },
      ],
    })
    const args = { date: '2099-01-05', time: '10:30', title: 'Reunión con proveedor' }
    const res = (await tool('create_booking').execute(db, 'acc', args, ctx)) as { created: boolean; clashes: string[] }
    expect(res.created).toBe(false)
    expect(res.clashes[0]).toMatch(/already booked 10:00–11:00 \(Consulta · Ana\) CITA-012345/)
    expect(writes).toEqual([])

    const forced = (await tool('create_booking').execute(db, 'acc', { ...args, force: true }, ctx)) as Record<string, unknown>
    expect(forced).toMatchObject({ created: true, reference: 'CITA-ABCDEF', date: '2099-01-05', time: '10:30', endsAt: '11:30' })
    const insert = writes.find((w) => w.table === 'bookings' && w.op === 'insert')?.payload as Record<string, unknown>
    expect(insert).toMatchObject({ service: 'Reunión con proveedor', created_by: 'owner-1', starts_at: '2099-01-05T14:30:00.000Z' })
    expect(syncBookingToGoogle).toHaveBeenCalledWith('abcdef12-0000-0000-0000-000000000000')
  })

  it('counts Google Calendar events and closed hours as clashes', async () => {
    const start = Date.parse('2099-01-05T14:30:00Z')
    googleBusy.mockResolvedValue([{ start, end: start + 30 * 60_000 }])
    checkBookingSchedule.mockResolvedValue('outside_hours')
    const { db } = fakeDb({ bookings: [] })
    const res = (await tool('create_booking').execute(db, 'acc', { date: '2099-01-05', time: '10:30', title: 'Llamada' }, ctx)) as {
      clashes: string[]
    }
    expect(res.clashes).toEqual(['busy in Google Calendar 10:30–11:00', 'it is outside business hours'])
  })

  it('refuses past times and bad input', async () => {
    const { db } = fakeDb({})
    const run = (a: Record<string, unknown>) => tool('create_booking').execute(db, 'acc', { title: 'x', ...a }, ctx)
    expect(await run({ date: '2020-01-01', time: '10:00' })).toEqual({ error: 'that time has already passed' })
    expect(await run({ date: 'mañana', time: '10:00' })).toEqual({ error: 'date must be YYYY-MM-DD' })
    expect(await run({ date: '2099-01-01', time: '10:00', duration_minutes: 2000 })).toEqual({
      error: 'duration_minutes must be between 5 and 720',
    })
  })

  it('cancels only a booking that matches the reference', async () => {
    const row = {
      id: 'abc123ff-1',
      kind: 'appointment',
      status: 'confirmed',
      service: 'Reunión',
      starts_at: '2099-01-05T14:00:00Z',
      ends_at: '2099-01-05T15:00:00Z',
      notes: null,
    }
    const { db, writes } = fakeDb({ bookings: [row] })
    expect(await tool('cancel_booking').execute(db, 'acc', { reference: 'CITA-999999' }, ctx)).toMatchObject({ cancelled: false })
    expect(writes).toEqual([])
    expect(await tool('cancel_booking').execute(db, 'acc', { reference: 'CITA-ABC123' }, ctx)).toMatchObject({
      cancelled: true,
      reference: 'CITA-ABC123',
    })
    expect(writes[0]).toMatchObject({ table: 'bookings', op: 'update', payload: { status: 'cancelled' } })
  })
})

describe('list_services_and_prices', () => {
  it('lists every catalog item and clinic service as text, never media', async () => {
    const { db } = fakeDb({
      ai_attachments: [{ name: 'Limpieza', description: 'Limpieza dental', price: 1500, currency: 'DOP', media_url: 'https://x/img.png' }],
      clinic_services: [
        { name: 'Consulta', duration_minutes: 30, price: 2000, active: true },
        { name: 'Vieja', duration_minutes: 30, price: 1, active: false },
      ],
    })
    const res = await tool('list_services_and_prices').execute(db, 'acc', {}, ctx)
    expect(res).toEqual({
      catalog: [{ name: 'Limpieza', price: 1500, currency: 'DOP', description: 'Limpieza dental' }],
      clinicServices: [{ name: 'Consulta', minutes: 30, price: 2000 }],
    })
    expect(JSON.stringify(res)).not.toContain('http')
  })
})
