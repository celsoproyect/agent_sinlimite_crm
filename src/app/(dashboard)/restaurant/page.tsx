"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, BellRing, ChevronLeft, ChevronRight, Loader2, Plus, UtensilsCrossed } from "lucide-react";
import { useModuleGate } from "@/hooks/use-module-gate";
import { useCan } from "@/hooks/use-can";
import { useAuth } from "@/hooks/use-auth";
import { isModuleEnabled } from "@/lib/modules";
import { businessLocalToInstant, businessToday } from "@/lib/business-timezone";
import { addDaysISO } from "@/lib/bookings/ranges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SampleDataBar } from "@/components/samples/sample-data-bar";
import { ReminderRulesSettings } from "@/components/agenda/reminder-rules-settings";
import { ReservationList } from "@/components/restaurant/reservation-list";
import { ReservationFormDialog } from "@/components/restaurant/reservation-form-dialog";
import { OccupancyView } from "@/components/restaurant/occupancy-view";
import { WaitlistPanel } from "@/components/restaurant/waitlist-panel";
import { FloorManager } from "@/components/restaurant/floor-manager";
import { RestaurantSettingsPanel } from "@/components/restaurant/restaurant-settings-panel";
import type { RestaurantData, Reservation } from "@/components/restaurant/restaurant-utils";

type Tab = "reservations" | "occupancy" | "waitlist" | "floor" | "settings";

// Restaurant module (migration 068): table reservations, occupancy, the
// waitlist, the floor plan and the restaurant's settings.
export default function RestaurantPage() {
  const t = useTranslations("Restaurant");
  const { ready, loading: gateLoading } = useModuleGate("restaurant");
  const { account } = useAuth();
  const isAdmin = useCan("edit-settings");
  const canEdit = useCan("send-messages");
  const waitlistOn = isModuleEnabled(account?.enabled_modules, "waitlist");

  const [tab, setTab] = useState<Tab>("reservations");
  const [day, setDay] = useState(() => businessToday());
  const [data, setData] = useState<RestaurantData | null>(null);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [remindersOpen, setRemindersOpen] = useState(false);

  const loadFloor = useCallback(async () => {
    const res = await fetch("/api/restaurant");
    if (res.ok) setData((await res.json()) as RestaurantData);
  }, []);

  const loadReservations = useCallback(async () => {
    const from = businessLocalToInstant(day, "00:00").toISOString();
    const to = businessLocalToInstant(addDaysISO(day, 1), "00:00").toISOString();
    const res = await fetch(`/api/restaurant/reservations?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    if (res.ok) {
      const json = (await res.json()) as { reservations?: Reservation[] };
      // `to` is inclusive on the server: leave out next day's midnight.
      const end = new Date(to).getTime();
      setReservations((json.reservations ?? []).filter((r) => new Date(r.starts_at).getTime() < end));
    } else {
      setReservations([]);
    }
  }, [day]);

  useEffect(() => {
    if (!ready) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads once the module gate opens
    void Promise.all([loadFloor(), loadReservations()]).then(() => setLoading(false));
  }, [ready, loadFloor, loadReservations]);

  const reload = useCallback(() => {
    void loadFloor();
    void loadReservations();
  }, [loadFloor, loadReservations]);

  const hasSamples = useMemo(
    () =>
      !!data &&
      (data.tables.some((x) => x.is_sample) ||
        data.areas.some((x) => x.is_sample) ||
        reservations.some((x) => x.is_sample)),
    [data, reservations],
  );

  if (gateLoading || !ready) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="h-96 animate-pulse rounded-xl bg-muted/50" />
      </div>
    );
  }

  const tabs: Tab[] = [
    "reservations",
    "occupancy",
    ...(waitlistOn ? (["waitlist"] as const) : []),
    "floor",
    ...(isAdmin ? (["settings"] as const) : []),
  ];
  const dayPicker = tab === "reservations" || tab === "occupancy" || tab === "waitlist";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <UtensilsCrossed className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold text-foreground">{t("title")}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && (
            <Button variant="outline" size="sm" onClick={() => setRemindersOpen(true)}>
              <BellRing className="mr-1 h-4 w-4" />
              {t("reminders")}
            </Button>
          )}
          {canEdit && data.migrated && (
            <Button size="sm" onClick={() => setFormOpen(true)}>
              <Plus className="mr-1 h-4 w-4" />
              {t("newReservation")}
            </Button>
          )}
        </div>
      </div>

      {isAdmin && data.migrated && <SampleDataBar module="restaurant" hasSamples={hasSamples} onChanged={reload} />}

      {!data.migrated && (
        <div className="flex items-start gap-2 rounded-xl border border-border bg-card p-4 text-sm text-foreground shadow-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          {t("errors.needs_migration")}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-card p-1">
          {tabs.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={
                tab === key
                  ? "rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
                  : "rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              }
            >
              {t(`tabs.${key}`)}
            </button>
          ))}
        </div>

        {dayPicker && (
          <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1">
            <button
              type="button"
              onClick={() => setDay((d) => addDaysISO(d, -1))}
              className="rounded p-1 text-muted-foreground hover:bg-muted"
              aria-label={t("prevDay")}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <Input
              type="date"
              value={day}
              onChange={(e) => e.target.value && setDay(e.target.value)}
              className="h-7 w-36 border-0 bg-transparent px-1 text-sm"
            />
            <button
              type="button"
              onClick={() => setDay((d) => addDaysISO(d, 1))}
              className="rounded p-1 text-muted-foreground hover:bg-muted"
              aria-label={t("nextDay")}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setDay(businessToday())}
              className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {t("today")}
            </button>
          </div>
        )}
      </div>

      {tab === "reservations" && (
        <ReservationList
          reservations={reservations}
          tables={data.tables}
          canEdit={canEdit}
          defaultDuration={data.settings.default_duration_minutes}
          onChanged={reload}
        />
      )}
      {tab === "occupancy" && (
        <OccupancyView
          date={day}
          reservations={reservations}
          tables={data.tables}
          areas={data.areas}
          settings={data.settings}
          business={data.business}
        />
      )}
      {tab === "waitlist" && waitlistOn && <WaitlistPanel date={day} canEdit={canEdit} />}
      {tab === "floor" && (
        <FloorManager areas={data.areas} tables={data.tables} canManage={isAdmin && data.migrated} onChanged={reload} />
      )}
      {tab === "settings" && isAdmin && (
        <RestaurantSettingsPanel
          key={JSON.stringify(data.settings)}
          settings={data.settings}
          onSaved={() => void loadFloor()}
        />
      )}

      <ReservationFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        defaultDate={day}
        settings={data.settings}
        tables={data.tables}
        areas={data.areas}
        onSaved={reload}
      />
      {isAdmin && <ReminderRulesSettings scope="table" open={remindersOpen} onOpenChange={setRemindersOpen} />}
    </div>
  );
}
