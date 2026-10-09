"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { LifeBuoy, Loader2, LogOut } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { leaveSupport } from "@/lib/support/client";

interface OpenSession {
  account_id: string;
  account_name: string;
}

/**
 * Support mode banner (migration 073). While a super admin is inside a
 * client's account it stays above the header on every page, naming the
 * account and offering the way back. Renders nothing otherwise.
 */
export function SupportModeBar() {
  const { isSuperAdmin, accountId } = useAuth();
  const t = useTranslations("SupportMode");
  const [session, setSession] = useState<OpenSession | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    fetch("/api/super-admin/support")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { session: OpenSession | null } | null) => {
        if (!cancelled) setSession(data?.session ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isSuperAdmin, accountId]);

  if (!isSuperAdmin || !session) return null;

  const exit = async () => {
    setLeaving(true);
    const result = await leaveSupport();
    if (!result.ok) {
      setLeaving(false);
      toast.error(t("exitFailed"));
    }
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-primary px-3 py-2 text-sm text-primary-foreground sm:px-6"
    >
      <LifeBuoy className="h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">
          {t("banner", { name: session.account_name })}
        </span>{" "}
        <span className="opacity-80">{t("hint")}</span>
      </p>
      <button
        type="button"
        onClick={exit}
        disabled={leaving}
        className="inline-flex items-center gap-1.5 rounded-md bg-primary-foreground px-3 py-1 text-xs font-medium text-primary transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {leaving ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <LogOut className="h-3.5 w-3.5" />
        )}
        {t("exit")}
      </button>
    </div>
  );
}
