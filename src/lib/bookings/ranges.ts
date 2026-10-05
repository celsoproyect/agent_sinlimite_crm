// ============================================================
// Business-local date ranges for the Agenda filters and the dashboard
// appointments card. Every date here is a business-local calendar day
// (YYYY-MM-DD, America/Santo_Domingo), never the browser's.
// ============================================================

import { businessLocalToInstant, businessToday, businessWeekday } from '@/lib/business-timezone'
import type { Booking } from '@/types'

export function addDaysISO(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Inclusive range of business-local days. */
export interface DayRange {
  from: string
  to: string
}

export type QuickRange = 'today' | 'tomorrow' | 'week' | 'next30' | 'month'

export function quickRange(kind: QuickRange, today: string = businessToday()): DayRange {
  switch (kind) {
    case 'today':
      return { from: today, to: today }
    case 'tomorrow': {
      const d = addDaysISO(today, 1)
      return { from: d, to: d }
    }
    case 'week': {
      // Monday to Sunday of the current week.
      const offset = (businessWeekday(today) + 6) % 7
      const monday = addDaysISO(today, -offset)
      return { from: monday, to: addDaysISO(monday, 6) }
    }
    case 'next30':
      return { from: today, to: addDaysISO(today, 29) }
    case 'month': {
      const first = `${today.slice(0, 7)}-01`
      const next = new Date(`${first}T12:00:00Z`)
      next.setUTCMonth(next.getUTCMonth() + 1)
      return { from: first, to: addDaysISO(next.toISOString().slice(0, 10), -1) }
    }
  }
}

/** Query-string bounds for `/api/bookings` (`from` inclusive, `to` the
 *  last millisecond of the last day). */
export function rangeToParams(range: DayRange): URLSearchParams {
  const from = businessLocalToInstant(range.from, '00:00')
  const to = new Date(businessLocalToInstant(addDaysISO(range.to, 1), '00:00').getTime() - 1)
  return new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })
}

export async function fetchBookings(range: DayRange): Promise<Booking[]> {
  const res = await fetch(`/api/bookings?${rangeToParams(range).toString()}`)
  if (!res.ok) return []
  const json = await res.json()
  return (json.bookings ?? []) as Booking[]
}

/** The name to show for a booking: the one the customer gave, else the
 *  contact's. */
export function bookingDisplayName(b: Booking): string {
  return b.customer_name || b.contact?.name || b.contact?.phone || ''
}

/** The phone to show: the one the customer gave, else the contact's. */
export function bookingDisplayPhone(b: Booking): string {
  return b.customer_phone || b.contact?.phone || ''
}
