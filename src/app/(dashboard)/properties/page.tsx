"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, Building2, Loader2, Plus } from "lucide-react";
import { useModuleGate } from "@/hooks/use-module-gate";
import { useCan } from "@/hooks/use-can";
import type { Property } from "@/lib/real-estate/search";
import { Button } from "@/components/ui/button";
import { SampleDataBar } from "@/components/samples/sample-data-bar";
import { PropertyList } from "@/components/real-estate/property-list";
import { PropertyFormDialog } from "@/components/real-estate/property-form-dialog";
import { AdvisorsPanel } from "@/components/real-estate/advisors-panel";
import { VisitsList } from "@/components/real-estate/visits-list";
import type { PropertiesData } from "@/components/real-estate/properties-utils";

type Tab = "properties" | "visits" | "advisors";

// Real estate module (migration 077): the listings the AI searches (by
// operation, type, zone, budget, rooms and amenities), the advisors who
// show them and the upcoming visits.
export default function PropertiesPage() {
  const t = useTranslations("Properties");
  const { ready, loading: gateLoading } = useModuleGate("properties");
  const isAdmin = useCan("edit-settings");
  const canBook = useCan("send-messages");

  const [tab, setTab] = useState<Tab>("properties");
  const [data, setData] = useState<PropertiesData | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<Property | "new" | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/properties").catch(() => null);
    if (res?.ok) {
      setData((await res.json()) as PropertiesData);
      setFailed(false);
    } else {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads once the module gate opens
    void load();
  }, [ready, load]);

  if (gateLoading || !ready || (!data && !failed)) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground shadow-sm">
        {t("errors.generic")}
      </div>
    );
  }

  const hasSamples = data.properties.some((p) => p.is_sample) || data.advisors.some((a) => a.is_sample);
  const tabs: Tab[] = ["properties", "visits", "advisors"];
  const available = data.properties.filter((p) => p.active && p.status === "available").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Building2 className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold text-foreground">{t("title")}</h1>
          {data.migrated && (
            <span className="text-xs text-muted-foreground">
              {t("summary", { total: data.properties.length, available })}
            </span>
          )}
        </div>
        {isAdmin && data.migrated && tab === "properties" && (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="mr-1 h-4 w-4" />
            {t("newProperty")}
          </Button>
        )}
      </div>

      {isAdmin && data.migrated && <SampleDataBar module="properties" hasSamples={hasSamples} onChanged={load} />}

      {!data.migrated && (
        <div className="flex items-start gap-2 rounded-xl border border-border bg-card p-4 text-sm text-foreground shadow-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          {t("errors.needs_migration")}
        </div>
      )}

      <div className="flex w-fit max-w-full flex-wrap items-center gap-1 rounded-lg border border-border bg-card p-1">
        {tabs.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={
              tab === key
                ? "min-h-9 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground sm:min-h-0"
                : "min-h-9 rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground sm:min-h-0"
            }
          >
            {t(`tabs.${key}`)}
          </button>
        ))}
      </div>

      {tab === "properties" && (
        <PropertyList
          properties={data.properties}
          advisors={data.advisors}
          canManage={isAdmin && data.migrated}
          onEdit={(p) => setEditing(p)}
          onChanged={() => void load()}
        />
      )}
      {tab === "visits" && (
        <VisitsList
          visits={data.visits ?? []}
          properties={data.properties}
          advisors={data.advisors}
          canEdit={canBook && data.migrated}
          onChanged={() => void load()}
        />
      )}
      {tab === "advisors" && (
        <AdvisorsPanel
          advisors={data.advisors}
          properties={data.properties}
          canManage={isAdmin}
          onChanged={() => void load()}
        />
      )}

      <PropertyFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        property={editing && editing !== "new" ? editing : null}
        advisors={data.advisors}
        onSaved={() => void load()}
      />
    </div>
  );
}
