"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle, Clock } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useAccountPlan } from "@/hooks/use-account-plan";
import { EXPIRING_DAYS } from "@/lib/plans/types";
import { BUSINESS_TIME_ZONE } from "@/lib/business-timezone";
import { cn } from "@/lib/utils";

function formatDay(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: BUSINESS_TIME_ZONE,
    day: "numeric",
    month: "long",
  }).format(new Date(iso));
}

/**
 * Above every page for owners/admins: the trial or the paid period is
 * about to end, or it ended and the account will be suspended after the
 * grace days (migration 074). Renders nothing otherwise.
 */
export function PlanStatusBanner() {
  const { canManageMembers } = useAuth();
  const { info } = useAccountPlan();
  const t = useTranslations("Plan");
  const locale = useLocale();

  if (!info || !canManageMembers) return null;
  const days = info.days_left;

  let text: string | null = null;
  let urgent = false;
  if (info.state === "past_due" && info.suspends_at) {
    text = t("banner.pastDue", { date: formatDay(info.suspends_at, locale) });
    urgent = true;
  } else if (info.state === "expiring" && days !== null) {
    text = t("banner.expiring", { days: Math.max(0, days) });
  } else if (info.state === "trial" && days !== null && days <= EXPIRING_DAYS) {
    text = t("banner.trial", { days: Math.max(0, days) });
  }
  if (!text) return null;

  const Icon = urgent ? AlertTriangle : Clock;
  return (
    <div
      role="status"
      className={cn(
        "mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-4 py-3 text-sm",
        urgent
          ? "border-destructive/40 bg-destructive/10 text-foreground"
          : "border-primary/30 bg-primary/10 text-foreground",
      )}
    >
      <Icon className={cn("h-4 w-4 shrink-0", urgent ? "text-destructive" : "text-primary")} />
      <p className="min-w-0 flex-1">{text}</p>
      <div className="flex flex-wrap gap-2">
        <Link
          href="/settings?tab=plan"
          className="rounded-md px-2.5 py-1 text-xs font-medium text-foreground underline-offset-2 hover:underline"
        >
          {t("banner.view")}
        </Link>
        <a
          href={info.upgrade_url}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          {t("banner.renew")}
        </a>
      </div>
    </div>
  );
}
