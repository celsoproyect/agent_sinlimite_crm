"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Phone, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Booking, Professional } from "@/types";
import { businessDate, businessTime, businessToday } from "@/lib/business-timezone";
import {
  bookingDisplayName,
  bookingDisplayPhone,
  fetchBookings,
  quickRange,
  type DayRange,
  type QuickRange,
} from "@/lib/bookings/ranges";
import { bookingReference } from "@/lib/bookings/reference";
import { cn } from "@/lib/utils";

export type BookingStatusFilter = "active" | "all" | "confirmed" | "completed" | "cancelled";

export interface BookingListFilter {
  range: QuickRange | "custom";
  /** Only used when `range` is "custom". */
  from: string;
  to: string;
  status: BookingStatusFilter;
}

export function defaultBookingFilter(): BookingListFilter {
  const today = businessToday();
  return { range: "today", from: today, to: today, status: "active" };
}

export function filterRange(filter: BookingListFilter): DayRange {
  if (filter.range !== "custom") return quickRange(filter.range);
  const from = filter.from || businessToday();
  const to = filter.to && filter.to >= from ? filter.to : from;
  return { from, to };
}

const QUICK_RANGES: QuickRange[] = ["today", "tomorrow", "week", "next30", "month"];
const STATUSES: BookingStatusFilter[] = ["active", "all", "confirmed", "completed", "cancelled"];

const STATUS_TONE: Record<Booking["status"], string> = {
  confirmed: "bg-emerald-500/10 text-emerald-600",
  completed: "bg-blue-500/10 text-blue-600",
  cancelled: "bg-rose-500/10 text-rose-600",
};

interface BookingListProps {
  filter: BookingListFilter;
  onFilterChange: (filter: BookingListFilter) => void;
  refreshKey: number;
  onBookingClick: (booking: Booking) => void;
  /** Clinic module: the doctors, for the doctor filter and labels. */
  professionals?: Professional[];
  /** Clinic module: only this doctor's appointments ("" = all,
   *  "__none__" = the ones without a doctor). */
  professionalId?: string;
}

/** Filterable list of bookings: quick date ranges, a custom from/to,
 *  status and a free-text search over name, phone, service and reference. */
export function BookingList({
  filter,
  onFilterChange,
  refreshKey,
  onBookingClick,
  professionals = [],
  professionalId = "",
}: BookingListProps) {
  const t = useTranslations("Agenda.list");
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [query, setQuery] = useState("");

  const range = filterRange(filter);

  useEffect(() => {
    let cancelled = false;
    fetchBookings(range).then((list) => {
      if (!cancelled) setBookings(list);
    });
    return () => {
      cancelled = true;
      setBookings(null);
    };
  }, [range.from, range.to, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, "");
    return (bookings ?? [])
      .filter((b) =>
        !professionalId
          ? true
          : professionalId === "__none__"
            ? !b.professional_id
            : b.professional_id === professionalId,
      )
      .filter((b) => {
        if (filter.status === "active") return b.status !== "cancelled";
        if (filter.status === "all") return true;
        return b.status === filter.status;
      })
      .filter((b) => {
        if (!q) return true;
        const haystack = [bookingDisplayName(b), b.service, bookingReference(b.id)]
          .join(" ")
          .toLowerCase();
        if (haystack.includes(q)) return true;
        return qDigits.length >= 3 && bookingDisplayPhone(b).replace(/\D/g, "").includes(qDigits);
      })
      .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  }, [bookings, filter.status, query, professionalId]);
  const doctorName = (id: string | null | undefined) =>
    id ? professionals.find((p) => p.id === id)?.name : undefined;

  const today = businessToday();
  const dayLabel = (iso: string) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap gap-1.5">
        {QUICK_RANGES.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => onFilterChange({ ...filter, range: r })}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              filter.range === r
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`range.${r}`)}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onFilterChange({ ...filter, range: "custom", from: range.from, to: range.to })}
          className={cn(
            "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
            filter.range === "custom"
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-background text-muted-foreground hover:text-foreground",
          )}
        >
          {t("range.custom")}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("from")}
          <input
            type="date"
            value={range.from}
            onChange={(e) =>
              onFilterChange({ ...filter, range: "custom", from: e.target.value, to: range.to })
            }
            className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("to")}
          <input
            type="date"
            value={range.to}
            min={range.from}
            onChange={(e) =>
              onFilterChange({ ...filter, range: "custom", from: range.from, to: e.target.value })
            }
            className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("status")}
          <select
            value={filter.status}
            onChange={(e) =>
              onFilterChange({ ...filter, status: e.target.value as BookingStatusFilter })
            }
            className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`statusFilter.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search")}
            className="h-8 w-full rounded-md border border-border bg-background pr-2 pl-8 text-sm text-foreground"
          />
        </div>
      </div>

      {bookings === null ? (
        <div className="flex justify-center py-10 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      ) : visible.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t("count", { count: visible.length })}</p>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {visible.map((b) => {
              const day = businessDate(b.starts_at);
              const phone = bookingDisplayPhone(b);
              return (
                <li key={b.id}>
                  <button
                    type="button"
                    onClick={() => onBookingClick(b)}
                    className={cn(
                      "flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-left hover:bg-muted/50",
                      b.status === "cancelled" && "opacity-60",
                    )}
                  >
                    <span className="w-28 shrink-0">
                      <span className="block text-sm font-semibold tabular-nums text-foreground">
                        {businessTime(b.starts_at)}–{businessTime(b.ends_at)}
                      </span>
                      <span
                        className={cn(
                          "block text-xs",
                          day === today ? "font-medium text-primary" : "text-muted-foreground",
                        )}
                      >
                        {day === today ? t("range.today") : dayLabel(day)}
                      </span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {bookingDisplayName(b) || "—"}
                      </span>
                      <span className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                        {b.service && <span className="truncate">{b.service}</span>}
                        {doctorName(b.professional_id) && (
                          <span className="truncate font-medium text-foreground/80">
                            {doctorName(b.professional_id)}
                          </span>
                        )}
                        {phone && (
                          <span className="inline-flex items-center gap-1">
                            <Phone className="size-3" />
                            {phone}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-foreground">
                      {bookingReference(b.id)}
                    </span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-medium",
                        STATUS_TONE[b.status],
                      )}
                    >
                      {t(`statusFilter.${b.status}`)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
