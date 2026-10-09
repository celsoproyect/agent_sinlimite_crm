"use client";

import { useMemo, useState } from "react";
import { Loader2, RotateCcw, Search, Trophy, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Deal } from "@/types";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import { businessDate, businessToday } from "@/lib/business-timezone";
import { addDaysISO, type DayRange } from "@/lib/bookings/ranges";
import { LOST_REASONS, isLostReason } from "@/lib/deals/reasons";
import { cn } from "@/lib/utils";

type StatusFilter = "all" | "won" | "lost";
type RangeKind = "month" | "lastMonth" | "last30" | "last90" | "year" | "all" | "custom";

const RANGES: RangeKind[] = ["month", "lastMonth", "last30", "last90", "year", "all"];

/** Business-local day the deal was closed. Deals closed before
 *  migration 063 have no `closed_at`; their last update stands in. */
export function dealClosedDay(deal: Deal): string {
  return businessDate(deal.closed_at || deal.updated_at || deal.created_at);
}

function rangeFor(kind: RangeKind, custom: DayRange, today: string): DayRange | null {
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (kind) {
    case "month":
      return { from: monthStart, to: today };
    case "lastMonth": {
      const lastDay = addDaysISO(monthStart, -1);
      return { from: `${lastDay.slice(0, 7)}-01`, to: lastDay };
    }
    case "last30":
      return { from: addDaysISO(today, -29), to: today };
    case "last90":
      return { from: addDaysISO(today, -89), to: today };
    case "year":
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case "all":
      return null;
    case "custom":
      return custom;
  }
}

interface ClosedDealsProps {
  /** Every deal of the pipeline; open ones are ignored. */
  deals: Deal[];
  onOpenDeal: (deal: Deal) => void;
  onReopen: (deal: Deal) => Promise<void>;
}

/**
 * Won and lost deals of the pipeline, newest close first, filterable by
 * outcome, close date (business-local days), lost reason and free text.
 */
export function ClosedDeals({ deals, onOpenDeal, onReopen }: ClosedDealsProps) {
  const t = useTranslations("Pipelines.closed");
  const { defaultCurrency } = useAuth();
  const today = businessToday();

  const [status, setStatus] = useState<StatusFilter>("all");
  const [rangeKind, setRangeKind] = useState<RangeKind>("month");
  const [custom, setCustom] = useState<DayRange>({ from: `${today.slice(0, 7)}-01`, to: today });
  const [reason, setReason] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [reopening, setReopening] = useState<string | null>(null);

  const range = rangeFor(rangeKind, custom, today);

  // Deals in the date range, before the status/reason/search filters —
  // the summary cards describe the period, not the narrowed list.
  const inRange = useMemo(
    () =>
      deals
        .filter((d) => d.status === "won" || d.status === "lost")
        .filter((d) => {
          if (!range) return true;
          const day = dealClosedDay(d);
          return day >= range.from && day <= range.to;
        }),
    [deals, range],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, "");
    return inRange
      .filter((d) => status === "all" || d.status === status)
      .filter((d) => reason === "all" || (d.status === "lost" && (d.lost_reason || "other") === reason))
      .filter((d) => {
        if (!q) return true;
        const hay = [d.title, d.contact?.name, d.close_note, d.notes].join(" ").toLowerCase();
        if (hay.includes(q)) return true;
        return qDigits.length >= 3 && (d.contact?.phone ?? "").replace(/\D/g, "").includes(qDigits);
      })
      .sort((a, b) =>
        (b.closed_at || b.updated_at || "").localeCompare(a.closed_at || a.updated_at || ""),
      );
  }, [inRange, status, reason, query]);

  const summary = useMemo(() => {
    const won = inRange.filter((d) => d.status === "won");
    const lost = inRange.filter((d) => d.status === "lost");
    const sum = (list: Deal[]) => list.reduce((s, d) => s + Number(d.value || 0), 0);
    const reasonCounts = new Map<string, number>();
    for (const d of lost) {
      const r = d.lost_reason || "other";
      reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
    }
    const top = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const closed = won.length + lost.length;
    return {
      wonCount: won.length,
      wonValue: sum(won),
      lostCount: lost.length,
      lostValue: sum(lost),
      winRate: closed > 0 ? Math.round((won.length / closed) * 100) : null,
      topReason: top ? { reason: top[0], count: top[1] } : null,
    };
  }, [inRange]);

  const reasonLabel = (r: string | null | undefined) =>
    isLostReason(r) ? t(`reasons.${r}`) : t("reasons.other");

  const dayLabel = (iso: string) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });

  async function reopen(deal: Deal) {
    setReopening(deal.id);
    try {
      await onReopen(deal);
    } finally {
      setReopening(null);
    }
  }

  const chip = (active: boolean) =>
    cn(
      "rounded-full border px-3 py-2 text-xs font-medium transition-colors sm:py-1",
      active
        ? "border-primary bg-primary text-primary-foreground"
        : "border-border bg-background text-muted-foreground hover:text-foreground",
    );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard
          icon={<Trophy className="size-4 text-emerald-500" />}
          label={t("summaryWon")}
          value={String(summary.wonCount)}
          sub={formatCurrency(summary.wonValue, defaultCurrency)}
        />
        <SummaryCard
          icon={<XCircle className="size-4 text-rose-500" />}
          label={t("summaryLost")}
          value={String(summary.lostCount)}
          sub={formatCurrency(summary.lostValue, defaultCurrency)}
        />
        <SummaryCard
          label={t("summaryWinRate")}
          value={summary.winRate === null ? "–" : `${summary.winRate}%`}
          sub={t("summaryWinRateSub")}
        />
        <SummaryCard
          label={t("summaryTopReason")}
          value={summary.topReason ? reasonLabel(summary.topReason.reason) : "–"}
          sub={summary.topReason ? t("count", { count: summary.topReason.count }) : t("noLost")}
        />
      </div>

      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap gap-1.5">
          {RANGES.map((r) => (
            <button key={r} type="button" onClick={() => setRangeKind(r)} className={chip(rangeKind === r)}>
              {t(`range.${r}`)}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              if (range) setCustom(range);
              setRangeKind("custom");
            }}
            className={chip(rangeKind === "custom")}
          >
            {t("range.custom")}
          </button>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          {rangeKind === "custom" && (
            <>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {t("from")}
                <input
                  type="date"
                  value={custom.from}
                  onChange={(e) => setCustom({ ...custom, from: e.target.value })}
                  className="h-10 min-w-0 rounded-md border border-border bg-background px-2 text-sm text-foreground sm:h-8"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {t("to")}
                <input
                  type="date"
                  value={custom.to}
                  min={custom.from}
                  onChange={(e) => setCustom({ ...custom, to: e.target.value })}
                  className="h-10 min-w-0 rounded-md border border-border bg-background px-2 text-sm text-foreground sm:h-8"
                />
              </label>
            </>
          )}
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t("status")}
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
              className="h-10 min-w-0 rounded-md border border-border bg-background px-2 text-sm text-foreground sm:h-8"
            >
              <option value="all">{t("statusAll")}</option>
              <option value="won">{t("won")}</option>
              <option value="lost">{t("lost")}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t("reason")}
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="h-10 min-w-0 rounded-md border border-border bg-background px-2 text-sm text-foreground sm:h-8"
            >
              <option value="all">{t("reasonAll")}</option>
              {LOST_REASONS.map((r) => (
                <option key={r} value={r}>
                  {t(`reasons.${r}`)}
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
              className="h-10 w-full rounded-md border border-border bg-background pr-2 pl-8 text-sm text-foreground sm:h-8"
            />
          </div>
        </div>

        {visible.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">{t("count", { count: visible.length })}</p>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {visible.map((d) => {
                const won = d.status === "won";
                return (
                  <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 hover:bg-muted/50">
                    <span className="w-24 shrink-0 text-xs tabular-nums text-muted-foreground">
                      {dayLabel(dealClosedDay(d))}
                    </span>
                    <button
                      type="button"
                      onClick={() => onOpenDeal(d)}
                      className="min-w-40 flex-1 text-left"
                    >
                      <span className="block truncate text-sm font-medium text-foreground">{d.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {d.contact?.name || d.contact?.phone || t("noContact")}
                      </span>
                    </button>
                    <span className="min-w-40 flex-[2] text-xs">
                      {won ? (
                        <span className="text-muted-foreground">{d.close_note || "—"}</span>
                      ) : (
                        <>
                          <span className="font-medium text-foreground">{reasonLabel(d.lost_reason)}</span>
                          {d.close_note && (
                            <span className="block text-muted-foreground">{d.close_note}</span>
                          )}
                        </>
                      )}
                    </span>
                    <span className="w-28 shrink-0 text-right text-sm font-semibold tabular-nums text-foreground">
                      {formatCurrency(Number(d.value || 0), d.currency || defaultCurrency)}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                        won ? "bg-emerald-500/10 text-emerald-600" : "bg-rose-500/10 text-rose-600",
                      )}
                    >
                      {won ? t("won") : t("lost")}
                    </span>
                    <button
                      type="button"
                      onClick={() => reopen(d)}
                      disabled={reopening === d.id}
                      title={t("reopen")}
                      aria-label={t("reopen")}
                      className="inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground sm:min-h-0 sm:min-w-0 hover:bg-muted hover:text-foreground disabled:opacity-60"
                    >
                      {reopening === d.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="size-3.5" />
                      )}
                      <span className="hidden sm:inline">{t("reopen")}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  sub,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon}
        {label}
      </p>
      <p className="mt-1 truncate text-xl font-bold text-foreground">{value}</p>
      <p className="truncate text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}
