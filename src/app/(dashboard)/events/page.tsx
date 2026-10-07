"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, BellRing, Loader2, PartyPopper, Plus } from "lucide-react";
import type { Booking, EventHall, EventPackage, EventSettings } from "@/types";
import { useModuleGate } from "@/hooks/use-module-gate";
import { useCan } from "@/hooks/use-can";
import { businessLocalToInstant, businessToday } from "@/lib/business-timezone";
import { addDaysISO } from "@/lib/bookings/ranges";
import { Button } from "@/components/ui/button";
import { SampleDataBar } from "@/components/samples/sample-data-bar";
import { ReminderRulesSettings } from "@/components/agenda/reminder-rules-settings";
import { EventRequestsBoard } from "@/components/events/event-requests-board";
import { EventRequestDialog } from "@/components/events/event-request-dialog";
import { EventHallsPanel } from "@/components/events/event-halls-panel";
import { EventPackagesPanel } from "@/components/events/event-packages-panel";
import { EventSettingsPanel } from "@/components/events/event-settings-panel";
import { EventSummary } from "@/components/events/event-summary";

type Tab = "requests" | "halls" | "packages" | "summary" | "settings";

/** How far back the board reaches, so recent events stay visible. */
const PAST_DAYS = 60;

interface EventsData {
  migrated: boolean;
  settings: EventSettings;
  halls: EventHall[];
  packages: EventPackage[];
}

export default function EventsPage() {
  const t = useTranslations("Events");
  const { ready: moduleReady, loading: moduleGateLoading } = useModuleGate("events");
  const canEdit = useCan("edit-settings");
  const canCreate = useCan("send-messages");
  const [tab, setTab] = useState<Tab>("requests");
  const [data, setData] = useState<EventsData | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [remindersOpen, setRemindersOpen] = useState(false);

  const load = useCallback(async () => {
    const from = businessLocalToInstant(addDaysISO(businessToday(), -PAST_DAYS), "00:00").toISOString();
    const [dirRes, reqRes] = await Promise.all([
      fetch("/api/events").catch(() => null),
      fetch(`/api/events/requests?from=${encodeURIComponent(from)}`).catch(() => null),
    ]);
    if (!dirRes?.ok) {
      setLoadFailed(true);
      return;
    }
    const dir = (await dirRes.json()) as EventsData;
    setData(dir);
    setLoadFailed(false);
    if (reqRes?.ok) {
      const json = await reqRes.json();
      setBookings((json.bookings ?? []) as Booking[]);
    } else {
      setBookings([]);
    }
  }, []);

  useEffect(() => {
    if (!moduleReady) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads once the module gate opens
    void load();
  }, [moduleReady, load]);

  if (moduleGateLoading || !moduleReady) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (!data) {
    return loadFailed ? (
      <p className="py-16 text-center text-sm text-muted-foreground">{t("errors.failed")}</p>
    ) : (
      <div className="space-y-6">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="h-96 animate-pulse rounded-xl bg-muted/50" />
      </div>
    );
  }

  const hasSamples =
    data.halls.some((h) => h.is_sample) || data.packages.some((p) => p.is_sample) || bookings.some((b) => b.is_sample);
  const tabs: Tab[] = canEdit ? ["requests", "halls", "packages", "summary", "settings"] : ["requests", "halls", "packages", "summary"];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <PartyPopper className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold text-foreground">{t("page.title")}</h1>
        </div>
        {data.migrated && (
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && (
              <Button variant="outline" size="sm" onClick={() => setRemindersOpen(true)} className="border-border">
                <BellRing className="mr-1 h-4 w-4" />
                {t("page.reminders")}
              </Button>
            )}
            {canCreate && (
              <Button size="sm" onClick={() => setRequestOpen(true)} className="bg-primary text-primary-foreground hover:bg-primary/90">
                <Plus className="mr-1 h-4 w-4" />
                {t("page.newRequest")}
              </Button>
            )}
          </div>
        )}
      </div>

      {!data.migrated ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p>{t("errors.needs_migration")}</p>
        </div>
      ) : (
        <>
          {canEdit && <SampleDataBar module="events" hasSamples={hasSamples} onChanged={load} />}

          <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-card p-1">
            {tabs.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setTab(v)}
                className={
                  tab === v
                    ? "rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
                    : "rounded px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                }
              >
                {t(`tabs.${v}`)}
              </button>
            ))}
          </div>

          {tab === "requests" &&
            (bookings.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{t("board.empty")}</p>
            ) : (
              <EventRequestsBoard bookings={bookings} halls={data.halls} settings={data.settings} canEdit={canCreate} onChanged={load} />
            ))}
          {tab === "halls" && <EventHallsPanel halls={data.halls} settings={data.settings} canEdit={canEdit} onChanged={load} />}
          {tab === "packages" && (
            <EventPackagesPanel packages={data.packages} halls={data.halls} settings={data.settings} canEdit={canEdit} onChanged={load} />
          )}
          {tab === "summary" && <EventSummary bookings={bookings} settings={data.settings} />}
          {tab === "settings" && canEdit && (
            <EventSettingsPanel settings={data.settings} onSaved={(settings) => setData((d) => (d ? { ...d, settings } : d))} />
          )}
        </>
      )}

      <EventRequestDialog
        open={requestOpen}
        onOpenChange={setRequestOpen}
        halls={data.halls}
        packages={data.packages}
        settings={data.settings}
        onCreated={load}
      />
      {canEdit && <ReminderRulesSettings open={remindersOpen} onOpenChange={setRemindersOpen} scope="event" />}
    </div>
  );
}
