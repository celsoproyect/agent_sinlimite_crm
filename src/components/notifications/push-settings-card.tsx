"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { BellOff, BellRing, Loader2, Send, Smartphone } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { isModuleEnabled } from "@/lib/modules";
import { cn } from "@/lib/utils";

/**
 * "Notificaciones en este dispositivo": subscribe this browser to Web Push
 * so handoff alerts reach the phone even with the app closed (module
 * `web_push`, src/lib/push/send.ts, public/sw.js).
 */

type PushState =
  | "loading"
  | "unsupported"
  | "ios_install"
  | "dev"
  | "not_configured"
  | "blocked"
  | "off"
  | "on";

function isIos(): boolean {
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function pushSupported(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** VAPID key (base64url) → bytes for `applicationServerKey`. */
function keyToBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function currentRegistration(): Promise<ServiceWorkerRegistration | null> {
  return (await navigator.serviceWorker.getRegistration("/")) ?? null;
}

export function PushSettingsCard() {
  const t = useTranslations("Push");
  const { account } = useAuth();
  const enabled = isModuleEnabled(account?.enabled_modules, "web_push");
  const [state, setState] = useState<PushState>("loading");
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  const refresh = useCallback(async () => {
    if (!pushSupported()) {
      setState(isIos() && !isStandalone() ? "ios_install" : "unsupported");
      return;
    }
    let key: string | null = null;
    try {
      const res = await fetch("/api/push/public-key");
      if (res.status === 403) {
        setHidden(true);
        return;
      }
      if (res.ok) key = ((await res.json()) as { publicKey: string | null }).publicKey;
    } catch {
      // Treated as not configured below.
    }
    setPublicKey(key);
    if (!key) {
      setState("not_configured");
      return;
    }
    if (Notification.permission === "denied") {
      setState("blocked");
      return;
    }
    const reg = await currentRegistration();
    if (!reg) {
      // The worker is only registered in production builds.
      setState(process.env.NODE_ENV === "production" ? "off" : "dev");
      return;
    }
    const sub = await reg.pushManager.getSubscription();
    setState(sub && Notification.permission === "granted" ? "on" : "off");
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh().catch(() => setState("unsupported"));
  }, [enabled, refresh]);

  const turnOn = useCallback(async () => {
    if (!publicKey) return;
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "off");
        return;
      }
      let reg = await currentRegistration();
      if (!reg) {
        reg = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });
      }
      await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      const sub =
        existing ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyToBytes(publicKey),
        }));
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({}))) as { error?: string };
        if (!existing) await sub.unsubscribe().catch(() => {});
        toast.error(error === "push_not_migrated" ? t("notMigrated") : t("enableFailed"));
        return;
      }
      setState("on");
      toast.success(t("enabled"));
    } catch (err) {
      console.error("[push] enable failed:", err);
      toast.error(t("enableFailed"));
    } finally {
      setBusy(false);
    }
  }, [publicKey, t]);

  const turnOff = useCallback(async () => {
    setBusy(true);
    try {
      const reg = await currentRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setState("off");
      toast.success(t("disabled"));
    } catch (err) {
      console.error("[push] disable failed:", err);
      toast.error(t("disableFailed"));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const sendTest = useCallback(async () => {
    setTesting(true);
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { sent?: number };
      if (!res.ok) {
        toast.error(t("testFailed"));
      } else if (!data.sent) {
        toast.error(t("testNoDevices"));
      } else {
        toast.success(t("testSent", { count: data.sent }));
      }
    } catch {
      toast.error(t("testFailed"));
    } finally {
      setTesting(false);
    }
  }, [t]);

  if (!enabled || hidden) return null;

  const statusLabel: Record<PushState, string> = {
    loading: t("statusLoading"),
    unsupported: t("statusUnsupported"),
    ios_install: t("statusUnsupported"),
    dev: t("statusOff"),
    not_configured: t("statusUnavailable"),
    blocked: t("statusBlocked"),
    off: t("statusOff"),
    on: t("statusOn"),
  };

  const help: Partial<Record<PushState, string>> = {
    unsupported: t("unsupportedHelp"),
    ios_install: t("iosInstallHelp"),
    dev: t("devHelp"),
    not_configured: t("notConfiguredHelp"),
    blocked: t("blockedHelp"),
  };

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Smartphone className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">{t("title")}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>
            </div>
          </div>
          <span
            className={cn(
              "rounded-full px-2.5 py-0.5 text-xs font-medium",
              state === "on"
                ? "bg-primary/15 text-primary"
                : state === "blocked"
                  ? "bg-destructive/10 text-destructive"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {statusLabel[state]}
          </span>
        </div>

        {help[state] && (
          <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            {help[state]}
          </p>
        )}

        {(state === "off" || state === "on") && (
          <div className="flex flex-wrap gap-2">
            {state === "off" ? (
              <Button size="sm" onClick={turnOn} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellRing className="h-4 w-4" />}
                {t("enable")}
              </Button>
            ) : (
              <>
                <Button size="sm" variant="outline" onClick={sendTest} disabled={testing}>
                  {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {t("sendTest")}
                </Button>
                <Button size="sm" variant="ghost" onClick={turnOff} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellOff className="h-4 w-4" />}
                  {t("disable")}
                </Button>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

