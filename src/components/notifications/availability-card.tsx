"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { UserCheck } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { isModuleEnabled } from "@/lib/modules";

/**
 * "Disponible para recibir chats": the person's own switch for the
 * automatic assignment (module `auto_assign`, migration 076). Away
 * people are skipped by the rotation.
 */
export function AvailabilityCard() {
  const t = useTranslations("Assignment");
  const { account, user, accountRole } = useAuth();
  const enabled = isModuleEnabled(account?.enabled_modules, "auto_assign") && accountRole !== "viewer";
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!enabled || !user?.id) return;
    let cancelled = false;
    fetch("/api/account/assignment")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { migrated: boolean; members: { user_id: string; is_available: boolean }[] } | null) => {
        if (cancelled || !data?.migrated) return;
        const me = data.members.find((m) => m.user_id === user.id);
        if (me) setAvailable(me.is_available);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, user?.id]);

  if (!enabled || available === null) return null;

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      const res = await fetch("/api/account/availability", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_available: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setAvailable(next);
      toast.success(next ? t("nowAvailable") : t("nowAway"));
    } catch {
      toast.error(t("availabilityFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <UserCheck className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">{t("myAvailabilityTitle")}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("myAvailabilityHelp")}</p>
          </div>
        </div>
        <Switch
          checked={available}
          disabled={busy}
          onCheckedChange={(v) => void toggle(v)}
          aria-label={t("myAvailabilityTitle")}
        />
      </CardContent>
    </Card>
  );
}
