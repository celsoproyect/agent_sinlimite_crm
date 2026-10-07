"use client";

// Agenda → Google Calendar: connect the owner's calendar so every
// booking shows up there and their own events block the AI's free slots.
// The OAuth round trip is /api/integrations/google-calendar/connect →
// Google → /callback, which comes back to /agenda?google=<status>.

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CalendarCheck2, CheckCircle2, Loader2, Unplug } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button, buttonVariants } from "@/components/ui/button";

interface GoogleStatus {
  configured: boolean;
  migrationPending: boolean;
  connected: boolean;
  email: string | null;
  redirectUri: string;
}

const RESULT_KEYS = ["connected", "error", "denied", "forbidden", "migration", "not_configured"] as const;

export function GoogleCalendarSettings({
  open,
  onOpenChange,
  onStatus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStatus?: (connected: boolean) => void;
}) {
  const t = useTranslations("Agenda.google");
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations/google-calendar/status");
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as GoogleStatus;
      setStatus(json);
      onStatus?.(json.connected);
    } catch (err) {
      console.error("[gcal] status load failed:", err);
    } finally {
      setLoading(false);
    }
  }, [onStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  // Coming back from Google: show the outcome once and clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("google");
    if (!result) return;
    const key = (RESULT_KEYS as readonly string[]).includes(result) ? result : "error";
    if (key === "connected") toast.success(t("result.connected"));
    else toast.error(t(`result.${key}`));
    params.delete("google");
    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, [t]);

  async function disconnect() {
    setDisconnecting(true);
    try {
      const res = await fetch("/api/integrations/google-calendar/disconnect", { method: "DELETE" });
      if (!res.ok) throw new Error(String(res.status));
      toast.success(t("disconnected"));
      await load();
    } catch (err) {
      console.error("[gcal] disconnect failed:", err);
      toast.error(t("disconnectFailed"));
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarCheck2 className="h-5 w-5 text-primary" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : !status ? (
          <p className="text-sm text-muted-foreground">{t("loadFailed")}</p>
        ) : !status.configured ? (
          <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
            <p className="font-medium text-foreground">{t("notConfiguredTitle")}</p>
            <p className="text-muted-foreground">{t("notConfiguredBody")}</p>
            <code className="block break-all rounded bg-background px-2 py-1 text-xs text-foreground">
              {status.redirectUri}
            </code>
          </div>
        ) : status.migrationPending ? (
          <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            {t("migrationPending")}
          </p>
        ) : status.connected ? (
          <div className="space-y-3 text-sm">
            <p className="flex items-start gap-2 text-foreground">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
              <span className="min-w-0 break-words">
                {t("connectedAs", { email: status.email ?? "Google" })}
              </span>
            </p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>{t("benefitSync")}</li>
              <li>{t("benefitBusy")}</li>
            </ul>
          </div>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>{t("benefitSync")}</li>
            <li>{t("benefitBusy")}</li>
            <li>{t("benefitPrivacy")}</li>
          </ul>
        )}

        <DialogFooter>
          {status?.configured && !status.migrationPending && status.connected ? (
            <Button variant="outline" onClick={disconnect} disabled={disconnecting}>
              {disconnecting ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Unplug className="mr-1 h-4 w-4" />
              )}
              {t("disconnect")}
            </Button>
          ) : status?.configured && !status.migrationPending ? (
            <a href="/api/integrations/google-calendar/connect" className={buttonVariants()}>
              {t("connect")}
            </a>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
