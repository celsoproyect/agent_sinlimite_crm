"use client";

import { useLocale, useTranslations } from "next-intl";

import { monthlyForecast, remaining, usageLevel } from "@/lib/plans/limits";
import { cn } from "@/lib/utils";

/** One resource's usage against its plan limit (null = unlimited). A
 *  `monthly` resource also says when it starts over and, at this month's
 *  pace, when it runs out. */
export function UsageBar({
  label,
  used,
  limit,
  monthly = false,
}: {
  label: string;
  used: number;
  limit: number | null;
  monthly?: boolean;
}) {
  const t = useTranslations("Plan");
  const locale = useLocale();
  const n = (v: number) => new Intl.NumberFormat(locale).format(v);
  const level = usageLevel(used, limit);
  const pct = limit === null ? 0 : limit === 0 ? 100 : Math.min(100, (used / limit) * 100);
  const forecast = monthly ? monthlyForecast(used, limit) : null;
  // Business-local dates (YYYY-MM-DD), shown as "1 de noviembre".
  const day = (iso: string) =>
    new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone: "UTC" }).format(
      new Date(`${iso}T12:00:00Z`),
    );
  const left = remaining(used, limit);

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
        <span className="min-w-0 font-medium text-foreground">{label}</span>
        <span
          className={cn(
            "tabular-nums",
            level === "full"
              ? "font-medium text-destructive"
              : level === "warn"
                ? "font-medium text-foreground"
                : "text-muted-foreground",
          )}
        >
          {limit === null
            ? t("usedUnlimited", { used: n(used) })
            : t("usageOf", { used: n(used), limit: n(limit) })}
        </span>
      </div>
      {limit !== null ? (
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-[width]",
              level === "full" ? "bg-destructive" : level === "warn" ? "bg-amber-500" : "bg-primary",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
      {limit !== null || forecast ? (
        <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {limit !== null && (
            <span className={cn(level === "full" && "font-medium text-destructive")}>
              {left === 0 ? t("usedUp") : t("remainingLeft", { count: n(left) })}
            </span>
          )}
          {forecast && <span>{t("resetsOn", { date: day(forecast.resetsOn) })}</span>}
          {forecast?.runsOutOn && left > 0 && (
            <span className="font-medium text-foreground">
              {t("runsOutOn", { date: day(forecast.runsOutOn) })}
            </span>
          )}
        </p>
      ) : null}
    </div>
  );
}
