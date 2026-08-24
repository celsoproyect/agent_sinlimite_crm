"use client";

import { useMemo } from "react";
import {
  startOfWeek,
  eachDayOfInterval,
  addDays,
  format,
  isSameDay,
  isToday,
} from "date-fns";
import type { Booking } from "@/types";
import { cn } from "@/lib/utils";

const HOURS = Array.from({ length: 13 }, (_, i) => 8 + i); // 08:00–20:00

interface AgendaCalendarProps {
  weekStart: Date;
  bookings: Booking[];
  onSlotClick: (day: Date, hour: number) => void;
  onBookingClick: (booking: Booking) => void;
}

export function AgendaCalendar({
  weekStart,
  bookings,
  onSlotClick,
  onBookingClick,
}: AgendaCalendarProps) {
  const days = useMemo(
    () =>
      eachDayOfInterval({
        start: startOfWeek(weekStart, { weekStartsOn: 1 }),
        end: addDays(startOfWeek(weekStart, { weekStartsOn: 1 }), 6),
      }),
    [weekStart],
  );

  const bookingsByDay = useMemo(() => {
    const map = new Map<string, Booking[]>();
    for (const day of days) {
      map.set(
        format(day, "yyyy-MM-dd"),
        bookings.filter((b) => isSameDay(new Date(b.starts_at), day)),
      );
    }
    return map;
  }, [days, bookings]);

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <div className="grid min-w-[840px] grid-cols-[60px_repeat(7,1fr)]">
        <div className="border-b border-border" />
        {days.map((day) => (
          <div
            key={day.toISOString()}
            className={cn(
              "border-b border-l border-border px-2 py-2 text-center",
              isToday(day) && "bg-primary/5",
            )}
          >
            <div className="text-xs text-muted-foreground">{format(day, "EEE")}</div>
            <div
              className={cn(
                "text-sm font-medium",
                isToday(day) ? "text-primary" : "text-foreground",
              )}
            >
              {format(day, "d")}
            </div>
          </div>
        ))}

        {HOURS.map((hour) => (
          <div key={hour} className="contents">
            <div className="border-b border-border px-1.5 py-3 text-right text-[11px] text-muted-foreground">
              {String(hour).padStart(2, "0")}:00
            </div>
            {days.map((day) => {
              const dayBookings = (
                bookingsByDay.get(format(day, "yyyy-MM-dd")) ?? []
              ).filter((b) => new Date(b.starts_at).getHours() === hour);
              return (
                <button
                  key={day.toISOString() + hour}
                  type="button"
                  onClick={() =>
                    dayBookings.length === 0
                      ? onSlotClick(day, hour)
                      : undefined
                  }
                  className={cn(
                    "min-h-[52px] border-b border-l border-border p-1 text-left align-top hover:bg-muted/50",
                    isToday(day) && "bg-primary/5",
                  )}
                >
                  {dayBookings.map((b) => (
                    <div
                      key={b.id}
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        onBookingClick(b);
                      }}
                      className={cn(
                        "mb-1 truncate rounded-md px-1.5 py-1 text-[11px] font-medium",
                        b.status === "cancelled"
                          ? "bg-muted text-muted-foreground line-through"
                          : "bg-primary/15 text-primary",
                      )}
                    >
                      {format(new Date(b.starts_at), "HH:mm")}{" "}
                      {b.contact?.name || b.contact?.phone || b.service}
                    </div>
                  ))}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
