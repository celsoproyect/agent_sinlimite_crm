"use client";

import { useState, useEffect, useCallback } from "react";
import { startOfWeek, endOfWeek, addWeeks, subWeeks, format } from "date-fns";
import type { Booking } from "@/types";
import { AgendaCalendar } from "@/components/agenda/agenda-calendar";
import { TodayPanel } from "@/components/agenda/today-panel";
import { BookingStats } from "@/components/agenda/booking-stats";
import {
  BookingList,
  defaultBookingFilter,
  type BookingListFilter,
} from "@/components/agenda/booking-list";
import { BookingFormDialog } from "@/components/agenda/booking-form-dialog";
import { BusinessHoursSettings } from "@/components/agenda/business-hours-settings";
import { ReminderRulesSettings } from "@/components/agenda/reminder-rules-settings";
import { GoogleCalendarSettings } from "@/components/agenda/google-calendar-settings";
import { GatedButton } from "@/components/ui/gated-button";
import { Calendar, ChevronLeft, ChevronRight, Loader2, Plus, Settings, BellRing, CalendarDays, CalendarCheck2, List } from "lucide-react";
import { useCan } from "@/hooks/use-can";
import { useTranslations } from "next-intl";
import { useModuleGate } from "@/hooks/use-module-gate";
import { useAuth } from "@/hooks/use-auth";
import { isModuleEnabled } from "@/lib/modules";

export default function AgendaPage() {
  const t = useTranslations("Agenda.page");
  const canCreateBookings = useCan("send-messages");
  const canEditSettings = useCan("edit-settings");
  const { ready: moduleReady, loading: moduleGateLoading } = useModuleGate("agenda");
  const { account } = useAuth();
  const googleModule = isModuleEnabled(account?.enabled_modules, "google_calendar");

  const [weekStart, setWeekStart] = useState(() => new Date());
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);

  const [formOpen, setFormOpen] = useState(false);
  const [editingBooking, setEditingBooking] = useState<Booking | null>(null);
  const [slotDefaults, setSlotDefaults] = useState<{ date: string; time: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [googleOpen, setGoogleOpen] = useState(false);
  const [googleConnected, setGoogleConnected] = useState(false);
  const [view, setView] = useState<"week" | "list">("week");
  const [listFilter, setListFilter] = useState<BookingListFilter>(defaultBookingFilter);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadBookings = useCallback(async () => {
    const from = startOfWeek(weekStart, { weekStartsOn: 1 });
    const to = endOfWeek(weekStart, { weekStartsOn: 1 });
    const params = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
    });
    const res = await fetch(`/api/bookings?${params.toString()}`);
    if (!res.ok) return [];
    const json = await res.json();
    return (json.bookings ?? []) as Booking[];
  }, [weekStart]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const list = await loadBookings();
      if (cancelled) return;
      setBookings(list);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadBookings]);

  const refreshBookings = useCallback(async () => {
    setBookings(await loadBookings());
    setRefreshKey((k) => k + 1);
  }, [loadBookings]);

  function pickStat(filter: Partial<BookingListFilter>) {
    setListFilter((f) => ({ ...f, ...filter }));
    setView("list");
  }

  function handleSlotClick(day: Date, hour: number) {
    setEditingBooking(null);
    setSlotDefaults({
      date: format(day, "yyyy-MM-dd"),
      time: `${String(hour).padStart(2, "0")}:00`,
    });
    setFormOpen(true);
  }

  function handleBookingClick(booking: Booking) {
    setEditingBooking(booking);
    setSlotDefaults(null);
    setFormOpen(true);
  }

  function handleNewBooking() {
    setEditingBooking(null);
    setSlotDefaults(null);
    setFormOpen(true);
  }

  const from = startOfWeek(weekStart, { weekStartsOn: 1 });
  const to = endOfWeek(weekStart, { weekStartsOn: 1 });
  const rangeLabel = `${format(from, "MMM d")} – ${format(to, "MMM d, yyyy")}`;

  if (moduleGateLoading || !moduleReady) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-9 w-28 animate-pulse rounded-lg bg-muted" />
        </div>
        <div className="h-96 animate-pulse rounded-xl bg-muted/50" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Calendar className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold text-foreground">{t("title")}</h1>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1">
            {(["week", "list"] as const).map((v) => {
              const Icon = v === "week" ? CalendarDays : List;
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={
                    view === v
                      ? "flex items-center gap-1 rounded bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground"
                      : "flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                  }
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t(v === "week" ? "viewWeek" : "viewList")}
                </button>
              );
            })}
          </div>
          {view === "week" && (
            <div className="flex items-center gap-1 rounded-lg border border-border bg-card px-1 py-1">
              <button
                type="button"
                onClick={() => setWeekStart((d) => subWeeks(d, 1))}
                className="rounded p-1 text-muted-foreground hover:bg-muted"
                aria-label={t("prevWeek")}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setWeekStart(new Date())}
                className="px-2 text-xs font-medium text-foreground hover:text-primary"
              >
                {t("today")}
              </button>
              <button
                type="button"
                onClick={() => setWeekStart((d) => addWeeks(d, 1))}
                className="rounded p-1 text-muted-foreground hover:bg-muted"
                aria-label={t("nextWeek")}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
          {view === "week" && (
            <span className="text-sm text-muted-foreground">{rangeLabel}</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <GatedButton
            variant="outline"
            canAct={canEditSettings}
            gateReason="edit business hours"
            onClick={() => setSettingsOpen(true)}
            className="border-border bg-card text-foreground hover:bg-muted"
          >
            <Settings className="mr-1 h-4 w-4" />
            {t("settings")}
          </GatedButton>
          <GatedButton
            variant="outline"
            canAct={canEditSettings}
            gateReason="edit booking reminders"
            onClick={() => setRemindersOpen(true)}
            className="border-border bg-card text-foreground hover:bg-muted"
          >
            <BellRing className="mr-1 h-4 w-4" />
            {t("reminders")}
          </GatedButton>
          {googleModule && (
            <GatedButton
              variant="outline"
              canAct={canEditSettings}
              gateReason="connect Google Calendar"
              onClick={() => setGoogleOpen(true)}
              className="border-border bg-card text-foreground hover:bg-muted"
            >
              <CalendarCheck2 className="mr-1 h-4 w-4" />
              {t("google")}
              {googleConnected && <span className="ml-1.5 h-2 w-2 rounded-full bg-emerald-500" />}
            </GatedButton>
          )}
          <GatedButton
            canAct={canCreateBookings}
            gateReason="create bookings"
            onClick={handleNewBooking}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t("newBooking")}
          </GatedButton>
        </div>
      </div>

      <BookingStats refreshKey={refreshKey} onPick={pickStat} />

      {view === "week" ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_280px]">
          <AgendaCalendar
            weekStart={weekStart}
            bookings={bookings}
            onSlotClick={handleSlotClick}
            onBookingClick={handleBookingClick}
          />
          <TodayPanel bookings={bookings} onBookingClick={handleBookingClick} />
        </div>
      ) : (
        <BookingList
          filter={listFilter}
          onFilterChange={setListFilter}
          refreshKey={refreshKey}
          onBookingClick={handleBookingClick}
        />
      )}

      <BookingFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        booking={editingBooking}
        defaultDate={slotDefaults?.date}
        defaultStartTime={slotDefaults?.time}
        onSaved={refreshBookings}
      />

      {canEditSettings && (
        <BusinessHoursSettings open={settingsOpen} onOpenChange={setSettingsOpen} />
      )}
      {canEditSettings && (
        <ReminderRulesSettings open={remindersOpen} onOpenChange={setRemindersOpen} />
      )}
      {canEditSettings && googleModule && (
        <GoogleCalendarSettings
          open={googleOpen}
          onOpenChange={setGoogleOpen}
          onStatus={setGoogleConnected}
        />
      )}
    </div>
  );
}
