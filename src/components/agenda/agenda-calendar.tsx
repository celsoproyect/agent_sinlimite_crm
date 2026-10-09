"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Booking } from "@/types";
import { cn } from "@/lib/utils";
import { addDaysISO } from "@/lib/bookings/ranges";
import { businessDate, businessTime, businessToday } from "@/lib/business-timezone";

/** Hours always drawn; widened when a booking falls outside them. */
const FIRST_HOUR = 8;
const LAST_HOUR = 20;

interface AgendaCalendarProps {
  /** Monday of the week shown, as a business-local "YYYY-MM-DD". */
  weekStart: string;
  bookings: Booking[];
  onSlotClick: (dateISO: string, hour: number) => void;
  onBookingClick: (booking: Booking) => void;
  /** Clinic module: doctor id -> name, shown on each appointment. */
  doctorNames?: Map<string, string>;
  /** The business's holidays: date -> name ("" when unnamed). */
  holidays?: Map<string, string>;
  /** Clinic module: dates the doctor being filtered on is away. */
  awayDates?: Set<string>;
}

/** Day label for a business-local date, independent of the browser's
 *  timezone (noon UTC is the same calendar day everywhere it matters). */
function dayLabel(dateISO: string, locale: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(
    new Date(`${dateISO}T12:00:00Z`),
  );
}

export function AgendaCalendar({
  weekStart,
  bookings,
  onSlotClick,
  onBookingClick,
  doctorNames,
  holidays,
  awayDates,
}: AgendaCalendarProps) {
  const t = useTranslations("Agenda.page");
  const locale = useLocale();
  const today = businessToday();
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDaysISO(weekStart, i)),
    [weekStart],
  );

  // Every booking keyed by its Santo Domingo day and hour.
  const byDayHour = useMemo(() => {
    const map = new Map<string, Booking[]>();
    for (const b of bookings) {
      const key = `${businessDate(b.starts_at)}|${Number(businessTime(b.starts_at).slice(0, 2))}`;
      map.set(key, [...(map.get(key) ?? []), b]);
    }
    return map;
  }, [bookings]);

  const hours = useMemo(() => {
    let first = FIRST_HOUR;
    let last = LAST_HOUR;
    for (const b of bookings) {
      if (!days.includes(businessDate(b.starts_at))) continue;
      const h = Number(businessTime(b.starts_at).slice(0, 2));
      first = Math.min(first, h);
      last = Math.max(last, h);
    }
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  }, [bookings, days]);

  const closedLabel = (day: string): string | null => {
    if (holidays?.has(day)) return holidays.get(day) || t("holiday");
    if (awayDates?.has(day)) return t("doctorAway");
    return null;
  };

  return (
    <div className="max-w-full overflow-x-auto overscroll-x-contain rounded-xl border border-border bg-card">
      <div className="grid min-w-[720px] grid-cols-[48px_repeat(7,minmax(0,1fr))] sm:min-w-[840px] sm:grid-cols-[60px_repeat(7,minmax(0,1fr))]">
        <div className="sticky left-0 z-10 border-b border-border bg-card" />
        {days.map((day) => {
          const closed = closedLabel(day);
          return (
            <div
              key={day}
              className={cn(
                "border-b border-l border-border px-2 py-2 text-center",
                day === today && "bg-primary/5",
                closed && "bg-amber-500/10",
              )}
            >
              <div className="text-xs text-muted-foreground">{dayLabel(day, locale, { weekday: "short" })}</div>
              <div
                className={cn(
                  "text-sm font-medium",
                  day === today ? "text-primary" : "text-foreground",
                )}
              >
                {Number(day.slice(8, 10))}
              </div>
              {closed && (
                <div
                  className="mx-auto mt-0.5 line-clamp-2 break-words text-[0.625rem] font-medium leading-tight text-amber-600"
                  title={closed}
                >
                  {closed}
                </div>
              )}
            </div>
          );
        })}

        {hours.map((hour) => (
          <div key={hour} className="contents">
            <div className="sticky left-0 z-10 border-b border-border bg-card px-1.5 py-3 text-right text-[0.6875rem] text-muted-foreground">
              {String(hour).padStart(2, "0")}:00
            </div>
            {days.map((day) => {
              const dayBookings = byDayHour.get(`${day}|${hour}`) ?? [];
              const closed = !!closedLabel(day);
              return (
                <button
                  key={day + hour}
                  type="button"
                  onClick={() =>
                    dayBookings.length === 0
                      ? onSlotClick(day, hour)
                      : undefined
                  }
                  className={cn(
                    "min-h-[52px] border-b border-l border-border p-1 text-left align-top hover:bg-muted/50",
                    day === today && "bg-primary/5",
                    closed &&
                      "bg-[repeating-linear-gradient(135deg,transparent,transparent_6px,rgb(245_158_11/0.08)_6px,rgb(245_158_11/0.08)_12px)]",
                  )}
                >
                  {dayBookings.map((b) => {
                    const doctor = b.professional_id ? doctorNames?.get(b.professional_id) : undefined;
                    return (
                    <div
                      key={b.id}
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        onBookingClick(b);
                      }}
                      className={cn(
                        "mb-1 truncate rounded-md px-1.5 py-1 text-[0.6875rem] font-medium",
                        b.status === "cancelled"
                          ? "bg-muted text-muted-foreground line-through"
                          : "bg-primary/15 text-primary",
                      )}
                    >
                      {businessTime(b.starts_at)}{" "}
                      {b.contact?.name || b.contact?.phone || b.service}
                      {doctor && <span className="block truncate font-normal opacity-80">{doctor}</span>}
                    </div>
                    );
                  })}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
