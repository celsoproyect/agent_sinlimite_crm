"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import type { BookingSettings, RestaurantArea, RestaurantSettings, RestaurantTable } from "@/types";
import { businessLocalToInstant, businessTime, businessWeekday } from "@/lib/business-timezone";
import { occupancyRate, type HeldTables } from "@/lib/restaurant/tables";
import { bookableTables, toFloorTables, type Reservation } from "./restaurant-utils";

interface OccupancyViewProps {
  date: string;
  reservations: Reservation[];
  tables: RestaurantTable[];
  areas: RestaurantArea[];
  settings: RestaurantSettings;
  business: BookingSettings | null;
}

const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const HOUR = 3_600_000;

/** The day's occupancy: seats held per opening hour, plus the counts. */
export function OccupancyView({ date, reservations, tables, areas, settings, business }: OccupancyViewProps) {
  const t = useTranslations("Restaurant");

  const stats = useMemo(() => {
    const live = reservations.filter((r) => r.status === "confirmed" || r.status === "completed");
    const floor = toFloorTables(bookableTables(tables), areas);
    const held: HeldTables[] = live.map((r) => ({
      tableIds: r.table_ids ?? [],
      start: new Date(r.starts_at).getTime(),
      end: new Date(r.ends_at).getTime(),
    }));

    const holiday = business?.holidays?.includes(date) ?? false;
    const hours = (settings.hours ?? business?.hours)?.[DAY_KEYS[businessWeekday(date)]];
    const rows: { label: string; rate: number }[] = [];
    let dayRate = 0;
    if (!holiday && hours) {
      const open = businessLocalToInstant(date, hours.open).getTime();
      const close = businessLocalToInstant(date, hours.close).getTime();
      for (let s = open; s < close; s += HOUR) {
        const e = Math.min(close, s + HOUR);
        rows.push({ label: businessTime(new Date(s)), rate: occupancyRate(floor, held, [{ start: s, end: e }]) });
      }
      if (close > open) dayRate = occupancyRate(floor, held, [{ start: open, end: close }]);
    }

    return {
      rows,
      dayRate,
      closed: holiday || !hours,
      count: live.length,
      people: live.reduce((s, r) => s + (r.party_size ?? 0), 0),
      noShows: reservations.filter((r) => r.status === "no_show").length,
      cancelled: reservations.filter((r) => r.status === "cancelled").length,
    };
  }, [date, reservations, tables, areas, settings.hours, business]);

  const cards = [
    { label: t("occupancyDay"), value: `${Math.round(stats.dayRate * 100)}%` },
    { label: t("statReservations"), value: stats.count },
    { label: t("statPeople"), value: stats.people },
    { label: t("statNoShows"), value: stats.noShows },
    { label: t("statCancelled"), value: stats.cancelled },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border border-border bg-card p-3 shadow-sm">
            <p className="text-xs text-muted-foreground">{c.label}</p>
            <p className="mt-1 text-xl font-semibold text-foreground">{c.value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4">
        <h3 className="mb-3 text-sm font-medium text-foreground">{t("occupancyByHour")}</h3>
        {stats.closed ? (
          <p className="text-sm text-muted-foreground">{t("closedDay")}</p>
        ) : (
          <ul className="space-y-1.5">
            {stats.rows.map((row) => {
              const pct = Math.round(row.rate * 100);
              return (
                <li key={row.label} className="flex items-center gap-3 text-xs">
                  <span className="w-12 shrink-0 text-muted-foreground">{row.label}</span>
                  <div className="h-3 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className={pct >= 85 ? "h-full bg-destructive" : "h-full bg-primary"}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-10 shrink-0 text-right text-foreground">{pct}%</span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted-foreground">{t("occupancyHint")}</p>
      </div>
    </div>
  );
}
