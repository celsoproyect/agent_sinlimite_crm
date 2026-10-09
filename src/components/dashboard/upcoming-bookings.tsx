'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, CalendarClock } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { Booking } from '@/types'
import { businessDate, businessTime, businessToday } from '@/lib/business-timezone'
import { addDaysISO, bookingDisplayName, fetchBookings } from '@/lib/bookings/ranges'
import { bookingReference } from '@/lib/bookings/reference'

const SHOWN = 5

/**
 * Dashboard card with today's appointment count, the next 7 days' count
 * and the next few confirmed appointments, linking to the Agenda.
 */
export function UpcomingBookings() {
  const t = useTranslations('Dashboard.bookings')
  const [bookings, setBookings] = useState<Booking[] | null>(null)
  // When the list was fetched; appointments already over by then drop out.
  const [loadedAt, setLoadedAt] = useState(0)

  useEffect(() => {
    let cancelled = false
    const today = businessToday()
    fetchBookings({ from: today, to: addDaysISO(today, 30) }).then((list) => {
      if (cancelled) return
      setBookings(list)
      setLoadedAt(Date.now())
    })
    return () => {
      cancelled = true
    }
  }, [])

  const today = businessToday()
  const weekEnd = addDaysISO(today, 6)
  const active = (bookings ?? [])
    .filter((b) => b.status === 'confirmed')
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
  const todayCount = active.filter((b) => businessDate(b.starts_at) === today).length
  const weekCount = active.filter((b) => businessDate(b.starts_at) <= weekEnd).length
  const next = active.filter((b) => new Date(b.ends_at).getTime() >= loadedAt).slice(0, SHOWN)

  return (
    <div className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
          <CalendarClock className="size-4 text-primary" />
          {t('title')}
        </h3>
        <Link
          href="/agenda"
          className="inline-flex shrink-0 items-center gap-1 py-2 text-xs font-medium text-primary hover:underline"
        >
          {t('viewAll')}
          <ArrowRight className="size-3" />
        </Link>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-muted/50 px-3 py-2">
          <p className="text-2xl font-bold tabular-nums text-foreground">
            {bookings ? todayCount : '–'}
          </p>
          <p className="text-xs text-muted-foreground">{t('today')}</p>
        </div>
        <div className="rounded-lg bg-muted/50 px-3 py-2">
          <p className="text-2xl font-bold tabular-nums text-foreground">
            {bookings ? weekCount : '–'}
          </p>
          <p className="text-xs text-muted-foreground">{t('next7')}</p>
        </div>
      </div>

      {bookings === null ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded-lg bg-muted/50" />
          ))}
        </div>
      ) : next.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {next.map((b) => {
            const day = businessDate(b.starts_at)
            return (
              <li
                key={b.id}
                className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2"
              >
                <div className="w-16 shrink-0">
                  <p className="text-sm font-semibold tabular-nums text-foreground">
                    {businessTime(b.starts_at)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {day === today
                      ? t('today')
                      : new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
                          day: 'numeric',
                          month: 'short',
                          timeZone: 'UTC',
                        })}
                  </p>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {bookingDisplayName(b) || '—'}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{b.service}</p>
                </div>
                <span className="hidden rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-foreground sm:inline">
                  {bookingReference(b.id, b.kind)}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
