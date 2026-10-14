"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, BellRing, ChevronLeft, ChevronRight, Loader2, Plus, UtensilsCrossed } from "lucide-react";
import { useModuleGate } from "@/hooks/use-module-gate";
import { useCan } from "@/hooks/use-can";
import { useAuth } from "@/hooks/use-auth";
import { isModuleEnabled } from "@/lib/modules";
import { businessDate, businessLocalToInstant, businessToday } from "@/lib/business-timezone";
import { addDaysISO, bookingDisplayName, mondayOf } from "@/lib/bookings/ranges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SampleDataBar } from "@/components/samples/sample-data-bar";
import { ReminderRulesSettings } from "@/components/agenda/reminder-rules-settings";
import { AgendaCalendar } from "@/components/agenda/agenda-calendar";
import { ViewToggle, WeekNav, hourTime, useScheduleView } from "@/components/bookings/schedule-view";
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
  const [formTime, setFormTime] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<Reservation | null>(null);
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [view, setView] = useScheduleView("restaurant");
  const weekStart = mondayOf(day);

  const loadFloor = useCallback(async () => {
    const res = await fetch("/api/restaurant");
    if (res.ok) setData((await res.json()) as RestaurantData);
  }, []);

  // The whole week of the chosen day: the list shows the day, the
  // calendar the week.
  const loadReservations = useCallback(async () => {
    const from = businessLocalToInstant(weekStart, "00:00").toISOString();
    const to = businessLocalToInstant(addDaysISO(weekStart, 7), "00:00").toISOString();
    const res = await fetch(`/api/restaurant/reservations?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    if (res.ok) {
      const json = (await res.json()) as { reservations?: Reservation[] };
      // `to` is inclusive on the server: leave out next day's midnight.
      const end = new Date(to).getTime();
      setReservations((json.reservations ?? []).filter((r) => new Date(r.starts_at).getTime() < end));
    } else {
      setReservations([]);
    }
  }, [weekStart]);

  useEffect(() => {
    if (!ready) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads once the module gate opens
    void Promise.all([loadFloor(), loadReservations()]).then(() => setLoading(false));
  }, [ready, loadFloor, loadReservations]);

  const reload = useCallback(() => {
    void loadFloor();
    void loadReservations();
  }, [loadFloor, loadReservations]);

  const dayReservations = useMemo(
    () => reservations.filter((r) => businessDate(r.starts_at) === day),
    [reservations, day],
  );
  const tableName = useMemo(() => new Map((data?.tables ?? []).map((tb) => [tb.id, tb.name])), [data?.tables]);

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
  const calendarView = tab === "reservations" && view === "calendar";
  const dayPicker = !calendarView && (tab === "reservations" || tab === "occupancy" || tab === "waitlist");

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
            <Button
              size="sm"
              onClick={() => {
                setFormTime(undefined);
                setFormOpen(true);
              }}
            >
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
                  ? "min-h-9 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground sm:min-h-0"
                  : "min-h-9 rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground sm:min-h-0"
              }
            >
              {t(`tabs.${key}`)}
            </button>
          ))}
        </div>

        {tab === "reservations" && <ViewToggle value={view} onChange={setView} />}
        {calendarView && <WeekNav weekStart={weekStart} onChange={setDay} />}

        {dayPicker && (
          <div className="flex max-w-full items-center gap-1 rounded-lg border border-border bg-card p-1">
            <button
              type="button"
              onClick={() => setDay((d) => addDaysISO(d, -1))}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted sm:h-7 sm:w-7"
              aria-label={t("prevDay")}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <Input
              type="date"
              value={day}
              onChange={(e) => e.target.value && setDay(e.target.value)}
              className="h-9 w-36 min-w-0 border-0 bg-transparent px-1 text-sm sm:h-7"
            />
            <button
              type="button"
              onClick={() => setDay((d) => addDaysISO(d, 1))}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted sm:h-7 sm:w-7"
              aria-label={t("nextDay")}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setDay(businessToday())}
              className="min-h-9 shrink-0 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground sm:min-h-0"
            >
              {t("today")}
            </button>
          </div>
        )}
      </div>

      {tab === "reservations" && !calendarView && (
        <ReservationList
          reservations={dayReservations}
          tables={data.tables}
          canEdit={canEdit}
          onOpen={setEditing}
          onChanged={reload}
        />
      )}
      {calendarView && (
        <AgendaCalendar
          weekStart={weekStart}
          bookings={reservations}
          onBookingClick={(b) => canEdit && setEditing(b as Reservation)}
          onSlotClick={
            canEdit && data.migrated
              ? (date, hour) => {
                  setDay(date);
                  setFormTime(hourTime(hour));
                  setFormOpen(true);
                }
              : undefined
          }
          describe={(b) => {
            const r = b as Reservation;
            const names = (r.table_ids ?? []).map((id) => tableName.get(id) ?? "?");
            return {
              title: bookingDisplayName(r) || "—",
              detail: [t("peopleCount", { count: r.party_size ?? 0 }), names.join(", ")].filter(Boolean).join(" · "),
            };
          }}
        />
      )}
      {tab === "occupancy" && (
        <OccupancyView
          date={day}
          reservations={dayReservations}
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
        defaultTime={formTime}
        settings={data.settings}
        tables={data.tables}
        areas={data.areas}
        onSaved={reload}
      />
      <ReservationFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        reservation={editing}
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
