"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarCheck, CalendarClock, CalendarDays, CalendarX } from "lucide-react";
import type { ComponentType } from "react";
import { useTranslations } from "next-intl";
import type { Booking } from "@/types";
import { businessDate, businessToday } from "@/lib/business-timezone";
import { addDaysISO, fetchBookings, quickRange } from "@/lib/bookings/ranges";
import type { BookingListFilter } from "./booking-list";
import { cn } from "@/lib/utils";

interface BookingStatsProps {
  /** Bumped by the page after a booking is saved, to reload the counts. */
  refreshKey: number;
  onPick: (filter: Partial<BookingListFilter>) => void;
}

/**
 * Small counters above the agenda: today, the next 7 days, this month and
 * cancelled this month. Each one opens the list filtered to what it
 * counts.
 */
export function BookingStats({ refreshKey, onPick }: BookingStatsProps) {
  const t = useTranslations("Agenda.stats");
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  // When the list was fetched; "upcoming" counts from this instant.
  const [loadedAt, setLoadedAt] = useState(0);

  const today = businessToday();
  const month = quickRange("month", today);
  const weekEnd = addDaysISO(today, 6);

  useEffect(() => {
    let cancelled = false;
    const to = weekEnd > month.to ? weekEnd : month.to;
    fetchBookings({ from: month.from, to }, "appointment").then((list) => {
      if (cancelled) return;
      setBookings(list);
      setLoadedAt(Date.now());
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, month.from, month.to, weekEnd]);

  const counts = useMemo(() => {
    const list = bookings ?? [];
    const day = (b: Booking) => businessDate(b.starts_at);
    const active = list.filter((b) => b.status !== "cancelled");
    return {
      today: active.filter((b) => day(b) === today).length,
      upcoming: active.filter(
        (b) => new Date(b.starts_at).getTime() >= loadedAt && day(b) <= weekEnd,
      ).length,
      month: active.filter((b) => day(b) >= month.from && day(b) <= month.to).length,
      cancelled: list.filter(
        (b) => b.status === "cancelled" && day(b) >= month.from && day(b) <= month.to,
      ).length,
    };
  }, [bookings, loadedAt, today, weekEnd, month.from, month.to]);

  const cards: {
    key: keyof typeof counts;
    icon: ComponentType<{ className?: string }>;
    tone: string;
    filter: Partial<BookingListFilter>;
  }[] = [
    {
      key: "today",
      icon: CalendarClock,
      tone: "bg-primary/10 text-primary",
      filter: { range: "today", status: "active" },
    },
    {
      key: "upcoming",
      icon: CalendarDays,
      tone: "bg-blue-500/10 text-blue-500",
      filter: { range: "custom", from: today, to: weekEnd, status: "active" },
    },
    {
      key: "month",
      icon: CalendarCheck,
      tone: "bg-emerald-500/10 text-emerald-500",
      filter: { range: "month", status: "active" },
    },
    {
      key: "cancelled",
      icon: CalendarX,
      tone: "bg-rose-500/10 text-rose-500",
      filter: { range: "month", status: "cancelled" },
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map(({ key, icon: Icon, tone, filter }) => (
        <button
          key={key}
          type="button"
          onClick={() => onPick(filter)}
          className="flex items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:bg-muted/50"
        >
          <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", tone)}>
            <Icon className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block text-xl leading-tight font-bold tabular-nums text-foreground">
              {bookings ? counts[key] : "–"}
            </span>
            <span className="block text-xs text-muted-foreground">{t(key)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
