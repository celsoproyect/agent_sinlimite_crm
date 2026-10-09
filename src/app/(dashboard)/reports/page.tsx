"use client";

// ============================================================
// Reportes — who answers customers (AI vs people), response times,
// sales by channel, the money the AI helped close, and every message
// the AI sent. Dates are business-local days (America/Santo_Domingo).
// ============================================================

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { BarChart3, Loader2 } from "lucide-react";
import { useModuleGate } from "@/hooks/use-module-gate";
import { useAuth } from "@/hooks/use-auth";
import { isModuleEnabled } from "@/lib/modules";
import { cn } from "@/lib/utils";
import type { DayRange } from "@/lib/bookings/ranges";
import { REPORT_PRESETS, presetRange, type ReportPreset } from "@/lib/reports/range";
import type { ReportChannel, ReportOverview as Overview } from "@/lib/reports/overview";
import { ReportOverview } from "@/components/reports/report-overview";
import { AiMessagesTable } from "@/components/reports/ai-messages-table";

const CHANNELS: ReportChannel[] = ["all", "whatsapp", "web"];

export default function ReportsPage() {
  const t = useTranslations("Reports");
  const { ready, loading: gateLoading } = useModuleGate("reports");
  const { account } = useAuth();
  const aiMessagesModule = isModuleEnabled(account?.enabled_modules, "ai_messages");

  const [preset, setPreset] = useState<ReportPreset | "custom">("week");
  const [range, setRange] = useState<DayRange>(() => presetRange("week"));
  const [channel, setChannel] = useState<ReportChannel>("all");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setFailed(false);
      try {
        const params = new URLSearchParams({ from: range.from, to: range.to, channel });
        const res = await fetch(`/api/reports/overview?${params.toString()}`);
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as Overview;
        if (!cancelled) setOverview(json);
      } catch (err) {
        console.error("[reports] overview load failed:", err);
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, range, channel]);

  function pickPreset(p: ReportPreset) {
    setPreset(p);
    setRange(presetRange(p));
  }

  function setCustom(next: Partial<DayRange>) {
    setPreset("custom");
    setRange((r) => {
      const merged = { ...r, ...next };
      return merged.from > merged.to ? { from: merged.to, to: merged.from } : merged;
    });
  }

  if (gateLoading || !ready) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <BarChart3 className="h-5 w-5 shrink-0 text-primary" />
          <h1 className="min-w-0 text-lg font-semibold text-foreground">{t("title")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3">
        <div className="flex flex-wrap gap-1">
          {REPORT_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => pickPreset(p)}
              className={cn(
                "min-h-9 rounded-md px-2.5 py-1 text-xs font-medium transition-colors sm:min-h-0",
                preset === p
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {t(`presets.${p}`)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <label className="flex items-center gap-1">
            {t("from")}
            <input
              type="date"
              value={range.from}
              onChange={(e) => e.target.value && setCustom({ from: e.target.value })}
              className={cn(
                "h-10 min-w-0 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground sm:h-auto",
                preset === "custom" && "border-primary",
              )}
            />
          </label>
          <label className="flex items-center gap-1">
            {t("to")}
            <input
              type="date"
              value={range.to}
              onChange={(e) => e.target.value && setCustom({ to: e.target.value })}
              className={cn(
                "h-10 min-w-0 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground sm:h-auto",
                preset === "custom" && "border-primary",
              )}
            />
          </label>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-1 rounded-lg bg-muted/60 p-1 sm:ml-auto">
          {CHANNELS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setChannel(c)}
              className={cn(
                "min-h-9 rounded-md px-2.5 py-1 text-xs font-medium transition-colors sm:min-h-0",
                channel === c
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`channels.${c}`)}
            </button>
          ))}
        </div>
      </div>

      {failed ? (
        <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
          {t("loadFailed")}
        </p>
      ) : (
        <ReportOverview overview={overview} loading={loading} />
      )}

      {aiMessagesModule && <AiMessagesTable range={range} channel={channel} />}
    </div>
  );
}
