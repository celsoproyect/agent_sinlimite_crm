import { describe, expect, it, vi } from 'vitest'
import {
  BOOK_TABLE_TOOL_NAME,
  CHECK_TABLE_AVAILABILITY_TOOL_NAME,
  REQUEST_EVENT_TOOL_NAME,
  runVenueTool,
  tableOfferToToolResult,
  venueToolDefinitions,
  type RestaurantToolExec,
} from './venue-tools'

function restaurant(overrides: Partial<RestaurantToolExec> = {}): RestaurantToolExec {
  return {
    check: vi.fn(async (args) => ({ slots: [], partySize: args.partySize, durationMinutes: args.durationMinutes ?? 90 })),
    waitlistEnabled: false,
    allowPreorder: true,
    allowCombine: true,
    areas: ['Salón'],
    ...overrides,
  }
}

const BOOK_ARGS = {
  startsAt: '2026-09-12T00:00:00.000Z',
  party_size: 8,
  customerName: 'Ana Pérez',
  customerPhone: '809-555-1234',
}

describe('venue tools', () => {
  it('only declares the tools of the modules that are on', () => {
    expect(venueToolDefinitions({}).map((t) => t.name)).toEqual([])
    const names = venueToolDefinitions({ restaurant: restaurant() }).map((t) => t.name)
    expect(names).toContain(CHECK_TABLE_AVAILABILITY_TOOL_NAME)
    expect(names).toContain(BOOK_TABLE_TOOL_NAME)
    expect(names).not.toContain(REQUEST_EVENT_TOOL_NAME)
  })

  it('passes a custom duration through to the availability check', async () => {
    const r = restaurant()
    await runVenueTool({ restaurant: r }, CHECK_TABLE_AVAILABILITY_TOOL_NAME, { date: '2026-09-11', party_size: 4, duration_minutes: 150 })
    expect(r.check).toHaveBeenCalledWith(expect.objectContaining({ partySize: 4, durationMinutes: 150 }))
  })

  it('asks for the party size before checking', async () => {
    const out = JSON.parse((await runVenueTool({ restaurant: restaurant() }, CHECK_TABLE_AVAILABILITY_TOOL_NAME, { date: '2026-09-11' }))!)
    expect(out.error).toMatch(/party_size/)
  })

  it('needs the name and phone before booking, and saves nothing in test mode', async () => {
    const missing = JSON.parse((await runVenueTool({ restaurant: restaurant() }, BOOK_TABLE_TOOL_NAME, { ...BOOK_ARGS, customerPhone: '' }))!)
    expect(missing).toMatchObject({ confirmed: false })
    const test = JSON.parse((await runVenueTool({ restaurant: restaurant() }, BOOK_TABLE_TOOL_NAME, BOOK_ARGS))!)
    expect(test.note).toMatch(/Test mode/)
  })

  it('passes the customer consent and seating for several tables', async () => {
    const book = vi.fn(async () => ({ confirmed: true, reference: 'RES-ABC123', tables: ['Mesa 3', 'Mesa 4'], seating: 'separate' as const }))
    const out = JSON.parse(
      (await runVenueTool({ restaurant: restaurant({ book }) }, BOOK_TABLE_TOOL_NAME, { ...BOOK_ARGS, customer_agreed: true, seating: 'separate' }))!,
    )
    expect(book).toHaveBeenCalledWith(expect.objectContaining({ customerAgreed: true, seating: 'separate', partySize: 8 }))
    expect(out).toMatchObject({ confirmed: true, reference: 'RES-ABC123', tables: 'Mesa 3 + Mesa 4' })
  })

  it('is not a venue tool otherwise', async () => {
    expect(await runVenueTool({ restaurant: restaurant() }, 'book_appointment', {})).toBeNull()
  })

  it('flags combined table offers so the agent asks first', () => {
    const out = JSON.parse(
      tableOfferToToolResult({
        partySize: 8,
        durationMinutes: 90,
        slots: [
          {
            startsAt: '2026-09-12T00:00:00.000Z',
            endsAt: '2026-09-12T01:30:00.000Z',
            tables: ['Mesa 3', 'Mesa 4'],
            tableIds: ['3', '4'],
            area: 'Salón',
            combined: true,
            seats: 8,
          },
        ],
      }),
    )
    expect(out.duration_minutes).toBe(90)
    expect(out.options[0]).toMatchObject({ combined: true, tables: 'Mesa 3 + Mesa 4', time: '20:00' })
    expect(out.options[0].note).toMatch(/joined or separate/)
  })
})
