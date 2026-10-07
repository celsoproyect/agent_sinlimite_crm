// ============================================================
// Date ranges for the Reports page. Every date is a business-local
// calendar day (YYYY-MM-DD, America/Santo_Domingo), never the
// browser's or the server's.
// ============================================================

import { businessLocalToInstant, businessToday } from '@/lib/business-timezone'
import { addDaysISO, quickRange, type DayRange } from '@/lib/bookings/ranges'

export type ReportPreset = 'today' | 'yesterday' | 'week' | 'lastWeek' | 'month' | 'last30'

export const REPORT_PRESETS: ReportPreset[] = ['today', 'yesterday', 'week', 'lastWeek', 'month', 'last30']

export function presetRange(preset: ReportPreset, today: string = businessToday()): DayRange {
  switch (preset) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday': {
      const d = addDaysISO(today, -1)
      return { from: d, to: d }
    }
    case 'week': {
      // Monday of this week up to today.
      return { from: quickRange('week', today).from, to: today }
    }
    case 'lastWeek': {
      const monday = addDaysISO(quickRange('week', today).from, -7)
      return { from: monday, to: addDaysISO(monday, 6) }
    }
    case 'month':
      return { from: `${today.slice(0, 7)}-01`, to: today }
    case 'last30':
      return { from: addDaysISO(today, -29), to: today }
  }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
/** Longest range a report may cover, so one request can't scan years. */
export const MAX_REPORT_DAYS = 366

/** Parse `from`/`to` query params; falls back to this week. */
export function parseReportRange(from: string | null, to: string | null): DayRange {
  if (!from || !to || !DAY_RE.test(from) || !DAY_RE.test(to) || from > to) {
    return presetRange('week')
  }
  if (dayCount({ from, to }) > MAX_REPORT_DAYS) {
    return { from: addDaysISO(to, -(MAX_REPORT_DAYS - 1)), to }
  }
  return { from, to }
}

export function dayCount(range: DayRange): number {
  const a = Date.parse(`${range.from}T12:00:00Z`)
  const b = Date.parse(`${range.to}T12:00:00Z`)
  return Math.round((b - a) / 86_400_000) + 1
}

/** The days of a range, in order. */
export function rangeDays(range: DayRange): string[] {
  const out: string[] = []
  for (let d = range.from; d <= range.to; d = addDaysISO(d, 1)) out.push(d)
  return out
}

/** UTC instants bounding the range: `from` inclusive, `to` exclusive. */
export function rangeInstants(range: DayRange): { fromISO: string; toISO: string } {
  return {
    fromISO: businessLocalToInstant(range.from, '00:00').toISOString(),
    toISO: businessLocalToInstant(addDaysISO(range.to, 1), '00:00').toISOString(),
  }
}

/** The same-length range just before `range`, for "vs previous" deltas. */
export function previousRange(range: DayRange): DayRange {
  const n = dayCount(range)
  return { from: addDaysISO(range.from, -n), to: addDaysISO(range.from, -1) }
}
