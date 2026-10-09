"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Ban, MessageCircle } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useAccountPlan } from "@/hooks/use-account-plan";
import { Card } from "@/components/ui/card";

/**
 * Blocks the app while the account's plan is suspended (by hand, or
 * unpaid past the grace days — migration 074). The AI, broadcasts and
 * invites are already refused on the server; customers' messages keep
 * arriving and are stored. A super admin still sees the pages (with a
 * notice) so they can support the account.
 */
export function PlanGate({ children }: { children: ReactNode }) {
  const { isSuperAdmin } = useAuth();
  const { info } = useAccountPlan();
  const t = useTranslations("Plan.suspended");

  if (info?.state !== "suspended") return <>{children}</>;

  if (isSuperAdmin) {
    return (
      <>
        <div
          role="status"
          className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-foreground"
        >
          <Ban className="h-4 w-4 shrink-0 text-destructive" />
          <p className="min-w-0 flex-1">{t("superAdminNotice")}</p>
        </div>
        {children}
      </>
    );
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="w-full max-w-md p-6 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-destructive/10">
          <Ban className="size-6 text-destructive" />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-foreground">{t("title")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t("body")}</p>
        <a
          href={info.upgrade_url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-5 inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <MessageCircle className="size-4" />
          {t("cta")}
        </a>
      </Card>
    </div>
  );
}
