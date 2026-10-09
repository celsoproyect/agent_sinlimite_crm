"use client";

import { useLocale, useTranslations } from "next-intl";

import { usageLevel } from "@/lib/plans/limits";
import { cn } from "@/lib/utils";

/** One resource's usage against its plan limit (null = unlimited). */
export function UsageBar({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number | null;
}) {
  const t = useTranslations("Plan");
  const locale = useLocale();
  const n = (v: number) => new Intl.NumberFormat(locale).format(v);
  const level = usageLevel(used, limit);
  const pct = limit === null ? 0 : limit === 0 ? 100 : Math.min(100, (used / limit) * 100);

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
    </div>
  );
}
