"use client";

import { useMemo } from "react";
import type { Booking } from "@/types";
import { CalendarClock } from "lucide-react";
import { cn } from "@/lib/utils";
import { businessDate, businessTime, businessToday } from "@/lib/business-timezone";
import { bookingDisplayName } from "@/lib/bookings/ranges";
import { bookingReference } from "@/lib/bookings/reference";
import { useTranslations } from "next-intl";

interface TodayPanelProps {
  bookings: Booking[];
  onBookingClick: (booking: Booking) => void;
}

export function TodayPanel({ bookings, onBookingClick }: TodayPanelProps) {
  const t = useTranslations("Agenda.todayPanel");

  const todaysBookings = useMemo(
    () =>
      bookings
        .filter((b) => businessDate(b.starts_at) === businessToday())
        .sort(
          (a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(),
        ),
    [bookings],
  );

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
        <CalendarClock className="h-4 w-4 text-primary" />
        {t("title")}
      </h3>

      {todaysBookings.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("noBookings")}</p>
      ) : (
        <ul className="space-y-2">
          {todaysBookings.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => onBookingClick(b)}
                className={cn(
                  "w-full rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-left hover:bg-muted",
                  b.status === "cancelled" && "opacity-60",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">
                    {businessTime(b.starts_at)}–{businessTime(b.ends_at)}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {bookingReference(b.id, b.kind)}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-sm text-foreground">
                  {bookingDisplayName(b)}
                </p>
                {b.service && (
                  <p className="truncate text-xs text-muted-foreground">{b.service}</p>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
