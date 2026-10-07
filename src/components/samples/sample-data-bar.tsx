"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SampleDataBarProps {
  module: "restaurant" | "events" | "clinic";
  /** Whether example rows already exist (shows "Quitar ejemplos"). */
  hasSamples: boolean;
  onChanged: () => Promise<void> | void;
}

/** "Cargar ejemplos" / "Quitar ejemplos" (migration 068): example tables,
 *  halls, doctors and bookings, flagged `is_sample`, so the owner can see
 *  how the module works and remove them in one click. */
export function SampleDataBar({ module, hasSamples, onChanged }: SampleDataBarProps) {
  const t = useTranslations("Samples");
  const [busy, setBusy] = useState(false);

  async function run(method: "POST" | "DELETE") {
    if (method === "DELETE" && !confirm(t("confirmRemove"))) return;
    if (method === "POST" && hasSamples && !confirm(t("confirmReload"))) return;
    setBusy(true);
    const res = await fetch("/api/samples", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      const json = await res?.json().catch(() => null);
      const code = json?.code as string | undefined;
      toast.error(
        code === "needs_migration" || code === "clinic_not_migrated"
          ? t("needsMigration")
          : code === "module_disabled"
            ? t("moduleDisabled")
            : t("failed"),
      );
      return;
    }
    toast.success(method === "POST" ? t("loaded") : t("removed"));
    await onChanged();
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border p-2">
      <Sparkles className="h-4 w-4 shrink-0 text-primary" />
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t(`hint.${module}`)}</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => run("POST")} className="border-border">
        {hasSamples ? t("reload") : t("load")}
      </Button>
      {hasSamples && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => run("DELETE")} className="text-muted-foreground">
          {t("remove")}
        </Button>
      )}
    </div>
  );
}
