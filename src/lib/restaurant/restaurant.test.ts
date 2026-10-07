import { describe, expect, it } from 'vitest'
import { freeTableIds, maxSeatable, occupancyRate, pickTables, type FloorTable } from './tables'
import { DEFAULT_RESTAURANT_SETTINGS, normalizeRestaurantSettings, normalizeWeeklyHours, reservationMinutes } from './settings'

function table(id: string, max: number, opts: Partial<FloorTable> = {}): FloorTable {
  return { id, name: `Mesa ${id}`, areaId: 'salon', areaName: 'Salón', minParty: 1, maxParty: max, combinable: true, ...opts }
}

const FLOOR = [table('1', 2), table('2', 2), table('3', 4), table('4', 4), table('5', 6, { areaId: 'terraza', areaName: 'Terraza' })]
const ALL = new Set(FLOOR.map((t) => t.id))
const HOUR = 3_600_000

describe('pickTables', () => {
  it('gives the smallest single table that seats the party', () => {
    expect(pickTables(FLOOR, ALL, 3, { allowCombine: true })).toMatchObject({ combined: false, tables: [{ id: '3' }] })
    expect(pickTables(FLOOR, ALL, 2, { allowCombine: true })?.tables[0].id).toBe('1')
  })

  it('joins tables of one area when no single table fits, and says so', () => {
    const pick = pickTables(FLOOR, ALL, 8, { allowCombine: true })
    expect(pick).toMatchObject({ combined: true, seats: 8 })
    expect(pick?.tables.map((t) => t.id)).toEqual(['3', '4'])
    expect(new Set(pick?.tables.map((t) => t.areaId))).toEqual(new Set(['salon']))
  })

  it('never combines when the restaurant turned it off, or with non-combinable tables', () => {
    expect(pickTables(FLOOR, ALL, 8, { allowCombine: false })).toBeNull()
    const fixed = FLOOR.map((t) => ({ ...t, combinable: false }))
    expect(pickTables(fixed, ALL, 8, { allowCombine: true })).toBeNull()
  })

  it('respects the area asked for and the minimum party of a table', () => {
    expect(pickTables(FLOOR, ALL, 2, { allowCombine: true, area: 'Terraza' })?.tables[0].id).toBe('5')
    const big = [table('9', 10, { minParty: 6 })]
    expect(pickTables(big, new Set(['9']), 2, { allowCombine: false })).toBeNull()
  })
})

describe('freeTableIds', () => {
  const held = [{ tableIds: ['3'], start: 10 * HOUR, end: 11.5 * HOUR, bookingId: 'b1' }]

  it('frees tables outside the reservation and keeps the buffer clear', () => {
    expect(freeTableIds(FLOOR, held, 11.5 * HOUR, 13 * HOUR).has('3')).toBe(true)
    expect(freeTableIds(FLOOR, held, 11.5 * HOUR, 13 * HOUR, 15 * 60_000).has('3')).toBe(false)
    expect(freeTableIds(FLOOR, held, 11 * HOUR, 12 * HOUR).has('3')).toBe(false)
  })

  it('ignores the reservation being moved', () => {
    expect(freeTableIds(FLOOR, held, 10 * HOUR, 11 * HOUR, 0, 'b1').has('3')).toBe(true)
  })
})

describe('maxSeatable / occupancyRate', () => {
  it('counts the biggest area when combining', () => {
    expect(maxSeatable(FLOOR, false)).toBe(6)
    expect(maxSeatable(FLOOR, true)).toBe(12)
  })

  it('measures seat time used over the open window', () => {
    const window = [{ start: 0, end: 2 * HOUR }]
    expect(occupancyRate(FLOOR, [], window)).toBe(0)
    // Table 5 (6 of 18 seats) for the whole window = 1/3.
    expect(occupancyRate(FLOOR, [{ tableIds: ['5'], start: 0, end: 2 * HOUR }], window)).toBeCloseTo(1 / 3)
  })
})

describe('restaurant settings', () => {
  it('defaults to 90-minute reservations', () => {
    expect(normalizeRestaurantSettings(null).default_duration_minutes).toBe(90)
    expect(reservationMinutes(DEFAULT_RESTAURANT_SETTINGS)).toBe(90)
  })

  it('lets the customer ask for more or less time, within the limits', () => {
    expect(reservationMinutes(DEFAULT_RESTAURANT_SETTINGS, 150)).toBe(150)
    expect(reservationMinutes(DEFAULT_RESTAURANT_SETTINGS, 60)).toBe(60)
    expect(reservationMinutes(DEFAULT_RESTAURANT_SETTINGS, 5)).toBe(DEFAULT_RESTAURANT_SETTINGS.min_duration_minutes)
    expect(reservationMinutes(DEFAULT_RESTAURANT_SETTINGS, 9999)).toBe(DEFAULT_RESTAURANT_SETTINGS.max_duration_minutes)
  })

  it('clamps whatever is stored and keeps the default inside min/max', () => {
    const s = normalizeRestaurantSettings({ default_duration_minutes: 500, min_duration_minutes: 60, max_duration_minutes: 120, allow_combine: false })
    expect(s).toMatchObject({ default_duration_minutes: 120, min_duration_minutes: 60, max_duration_minutes: 120, allow_combine: false })
  })

  it('keeps only well-formed open days', () => {
    expect(normalizeWeeklyHours({ monday: { open: '12:00', close: '23:00' }, tuesday: { open: '25:00', close: '23:00' } })).toMatchObject({
      monday: { open: '12:00', close: '23:00' },
      tuesday: null,
    })
    expect(normalizeWeeklyHours({ monday: null })).toBeNull()
  })
})
