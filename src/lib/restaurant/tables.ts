// ============================================================
// Restaurant module: choosing tables for a party. Pure, so it is tested
// without a database.
//
// A party gets, in this order:
//   1. the smallest free table that seats it on its own;
//   2. otherwise, when combining is allowed, the fewest free combinable
//      tables of the same area whose seats add up to the party, wasting
//      as few seats as possible. The customer must agree to that (joined
//      tables or separate tables side by side), so the result says
//      `combined: true` and the agent asks before booking.
// ============================================================

export interface FloorTable {
  id: string
  name: string
  areaId: string | null
  areaName: string | null
  minParty: number
  maxParty: number
  combinable: boolean
}

/** A live reservation holding some tables. */
export interface HeldTables {
  tableIds: string[]
  start: number
  end: number
  /** Leave this reservation out (the one being moved). */
  bookingId?: string
}

export interface TablePick {
  tables: FloorTable[]
  combined: boolean
  seats: number
}

/** Most tables joined for one party. */
export const MAX_COMBINED_TABLES = 4

/** Ids of the tables free during [start, end), keeping `bufferMs` clear on
 *  both sides of every other reservation. */
export function freeTableIds(
  tables: FloorTable[],
  held: HeldTables[],
  start: number,
  end: number,
  bufferMs = 0,
  excludeBookingId?: string,
): Set<string> {
  const busy = new Set<string>()
  for (const h of held) {
    if (excludeBookingId && h.bookingId === excludeBookingId) continue
    if (start < h.end + bufferMs && end + bufferMs > h.start) {
      for (const id of h.tableIds) busy.add(id)
    }
  }
  return new Set(tables.filter((t) => !busy.has(t.id)).map((t) => t.id))
}

function combinations<T>(items: T[], size: number, start = 0, acc: T[] = [], out: T[][] = []): T[][] {
  if (acc.length === size) {
    out.push([...acc])
    return out
  }
  for (let i = start; i < items.length; i++) {
    acc.push(items[i])
    combinations(items, size, i + 1, acc, out)
    acc.pop()
    if (out.length > 5000) break
  }
  return out
}

function matchesArea(table: FloorTable, area?: string | null): boolean {
  if (!area) return true
  const wanted = area.trim().toLowerCase()
  return table.areaId === area || (table.areaName ?? '').toLowerCase() === wanted
}

/**
 * The tables to give `partySize` people among `free`, or null when they
 * can't be seated. `area` (an area id or name) restricts the search.
 */
export function pickTables(
  tables: FloorTable[],
  free: Set<string>,
  partySize: number,
  opts: { allowCombine: boolean; area?: string | null },
): TablePick | null {
  const candidates = tables.filter((t) => free.has(t.id) && matchesArea(t, opts.area))

  const single = candidates
    .filter((t) => t.minParty <= partySize && t.maxParty >= partySize)
    .sort((a, b) => a.maxParty - b.maxParty || a.name.localeCompare(b.name))[0]
  if (single) return { tables: [single], combined: false, seats: single.maxParty }
  if (!opts.allowCombine) return null

  // Combine within one area: joined tables, or separate ones close by.
  const byArea = new Map<string, FloorTable[]>()
  for (const t of candidates) {
    if (!t.combinable) continue
    const key = t.areaId ?? ''
    byArea.set(key, [...(byArea.get(key) ?? []), t])
  }
  let best: TablePick | null = null
  for (const group of byArea.values()) {
    const sorted = [...group].sort((a, b) => b.maxParty - a.maxParty || a.name.localeCompare(b.name))
    for (let size = 2; size <= Math.min(MAX_COMBINED_TABLES, sorted.length); size++) {
      for (const combo of combinations(sorted, size)) {
        const seats = combo.reduce((sum, t) => sum + t.maxParty, 0)
        if (seats < partySize) continue
        const better =
          !best ||
          combo.length < best.tables.length ||
          (combo.length === best.tables.length && seats < best.seats)
        if (better) {
          best = {
            tables: [...combo].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
            combined: true,
            seats,
          }
        }
      }
      // Fewer tables always wins: stop growing once this size worked.
      if (best && best.tables.length === size) break
    }
  }
  return best
}

/** The largest party the floor could ever seat (all combinable tables of
 *  the biggest area, or the biggest single table). */
export function maxSeatable(tables: FloorTable[], allowCombine: boolean): number {
  const single = Math.max(0, ...tables.map((t) => t.maxParty))
  if (!allowCombine) return single
  const byArea = new Map<string, number[]>()
  for (const t of tables) {
    if (!t.combinable) continue
    const key = t.areaId ?? ''
    byArea.set(key, [...(byArea.get(key) ?? []), t.maxParty])
  }
  let combined = 0
  for (const seats of byArea.values()) {
    const top = [...seats].sort((a, b) => b - a).slice(0, MAX_COMBINED_TABLES)
    combined = Math.max(combined, top.reduce((s, n) => s + n, 0))
  }
  return Math.max(single, combined)
}

/** Seated share of the floor: seats taken by live reservations over
 *  every seat × hour in the windows given. 0–1. */
export function occupancyRate(
  tables: FloorTable[],
  held: HeldTables[],
  windows: { start: number; end: number }[],
): number {
  const seatsById = new Map(tables.map((t) => [t.id, t.maxParty]))
  const totalSeats = tables.reduce((s, t) => s + t.maxParty, 0)
  const capacity = windows.reduce((s, w) => s + Math.max(0, w.end - w.start) * totalSeats, 0)
  if (capacity <= 0) return 0
  let used = 0
  for (const h of held) {
    for (const w of windows) {
      const overlap = Math.min(h.end, w.end) - Math.max(h.start, w.start)
      if (overlap <= 0) continue
      for (const id of h.tableIds) used += overlap * (seatsById.get(id) ?? 0)
    }
  }
  return Math.min(1, used / capacity)
}
