"use client";

// Agenda → Google Calendar: connect the owner's calendar so every
// booking shows up there and their own events block the AI's free slots.
// The OAuth round trip is /api/integrations/google-calendar/connect →
// Google → /callback. "Conectar" runs it in a popup: the callback page
// posts the outcome back (window.opener or BroadcastChannel) and closes.
// When the browser blocks the popup it falls back to the full-page flow,
// which comes back to /agenda?google=<status>.

import { useCallback, useEffect, useRef, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { GOOGLE_OAUTH_CHANNEL, GOOGLE_OAUTH_RESULTS } from "@/lib/google-calendar/oauth-result";

interface GoogleStatus {
  configured: boolean;
  migrationPending: boolean;
  connected: boolean;
  email: string | null;
  redirectUri: string;
}

const CONNECT_URL = "/api/integrations/google-calendar/connect";

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

  const showResult = useCallback(
    (result: string) => {
      const key = (GOOGLE_OAUTH_RESULTS as readonly string[]).includes(result) ? result : "error";
      if (key === "connected") toast.success(t("result.connected"));
      else toast.error(t(`result.${key}`));
    },
    [t],
  );

  // Coming back from the full-page flow: show the outcome once and clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("google");
    if (!result) return;
    showResult(result);
    params.delete("google");
    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, [showResult]);

  // Popup flow. The result can arrive twice (opener + channel), and the
  // owner can close the popup without finishing, so the first signal wins.
  const [connecting, setConnecting] = useState(false);
  const popupRef = useRef<Window | null>(null);
  const handledRef = useRef(true);
  const finishPopup = useCallback(
    (result: string | null) => {
      if (handledRef.current) return;
      handledRef.current = true;
      popupRef.current = null;
      setConnecting(false);
      if (result) showResult(result);
      void load();
    },
    [showResult, load],
  );

  useEffect(() => {
    function onResult(data: unknown) {
      const msg = data as { source?: unknown; status?: unknown } | null;
      if (msg?.source === GOOGLE_OAUTH_CHANNEL && typeof msg.status === "string") finishPopup(msg.status);
    }
    function onMessage(event: MessageEvent) {
      if (event.origin === window.location.origin) onResult(event.data);
    }
    window.addEventListener("message", onMessage);
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(GOOGLE_OAUTH_CHANNEL);
      channel.onmessage = (event) => onResult(event.data);
    } catch {
      // Old browsers: window.opener still delivers it.
    }
    return () => {
      window.removeEventListener("message", onMessage);
      channel?.close();
    };
  }, [finishPopup]);

  useEffect(() => {
    if (!connecting) return;
    const timer = window.setInterval(() => {
      // Closed by hand: give a late message a moment, then just refresh.
      if (popupRef.current?.closed) window.setTimeout(() => finishPopup(null), 800);
    }, 500);
    return () => window.clearInterval(timer);
  }, [connecting, finishPopup]);

  function connect() {
    const width = 520;
    const height = 660;
    const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
    const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
    const popup = window.open(
      `${CONNECT_URL}?popup=1`,
      GOOGLE_OAUTH_CHANNEL,
      `popup=yes,width=${width},height=${height},left=${Math.round(left)},top=${Math.round(top)}`,
    );
    if (!popup) {
      // Popup blocked: do the round trip in this tab.
      window.location.href = CONNECT_URL;
      return;
    }
    popup.focus();
    popupRef.current = popup;
    handledRef.current = false;
    setConnecting(true);
  }

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
            <Button onClick={connect} disabled={connecting}>
              {connecting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {connecting ? t("connecting") : t("connect")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
