"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Booking, EventSettings } from "@/types";
import { businessToday } from "@/lib/business-timezone";
import { addDaysISO } from "@/lib/bookings/ranges";
import { businessDate } from "@/lib/business-timezone";
import { EVENT_COLUMNS, EVENT_STATUS_TONE, formatMoney } from "./event-utils";
import { eventColumn } from "./event-requests-board";

interface Props {
  bookings: Booking[];
  settings: EventSettings;
}

/** The next 30 days at a glance: how many events per status, what's been
 *  quoted and which deposits came in. */
export function EventSummary({ bookings, settings }: Props) {
  const t = useTranslations("Events");
  const locale = useLocale();

  const stats = useMemo(() => {
    const today = businessToday();
    const until = addDaysISO(today, 30);
    const upcoming = bookings.filter((b) => {
      const d = businessDate(b.starts_at);
      return d >= today && d <= until;
    });
    const counts = new Map(EVENT_COLUMNS.map((s) => [s, 0]));
    let quoted = 0;
    let deposits = 0;
    for (const b of upcoming) {
      const col = eventColumn(b);
      counts.set(col, (counts.get(col) ?? 0) + 1);
      if (col === "cancelled") continue;
      quoted += Number(b.quote_amount ?? 0);
      if (b.deposit_paid_at) deposits += Number(b.deposit_amount ?? 0);
    }
    return { counts, quoted, deposits, total: upcoming.length };
  }, [bookings]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("summary.help")}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">{t("summary.events")}</p>
          <p className="mt-1 text-2xl font-semibold text-foreground">{stats.total}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">{t("summary.quoted")}</p>
          <p className="mt-1 break-words text-2xl font-semibold text-foreground">{formatMoney(stats.quoted, settings.currency, locale)}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">{t("summary.deposits")}</p>
          <p className="mt-1 break-words text-2xl font-semibold text-foreground">{formatMoney(stats.deposits, settings.currency, locale)}</p>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {EVENT_COLUMNS.map((s) => (
          <div key={s} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${EVENT_STATUS_TONE[s]}`}>{t(`status.${s}`)}</span>
            <span className="text-sm font-semibold text-foreground">{stats.counts.get(s) ?? 0}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
