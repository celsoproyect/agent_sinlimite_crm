"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import type { Booking, BookingSettings } from "@/types";
import { createClient } from "@/lib/supabase/client";
import { addDaysISO, rangeToParams } from "@/lib/bookings/ranges";
import { businessToday, businessWeekday } from "@/lib/business-timezone";
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
import { ClinicDirectoryDialog } from "@/components/agenda/clinic-directory-dialog";
import { useClinicDirectory } from "@/hooks/use-clinic-directory";
import { GatedButton } from "@/components/ui/gated-button";
import { Calendar, ChevronLeft, ChevronRight, Loader2, Plus, Settings, BellRing, CalendarDays, CalendarCheck2, List, Stethoscope, AlertTriangle } from "lucide-react";
import { useCan } from "@/hooks/use-can";
import { useLocale, useTranslations } from "next-intl";
import { useModuleGate } from "@/hooks/use-module-gate";
import { useAuth } from "@/hooks/use-auth";
import { isModuleEnabled } from "@/lib/modules";

/** Doctor filter value for appointments with no doctor. */
const NO_DOCTOR = "__none__";

/** Monday of the Santo Domingo week containing `dateISO`. */
function mondayOf(dateISO: string): string {
  return addDaysISO(dateISO, -((businessWeekday(dateISO) + 6) % 7));
}

/** "5 oct – 11 oct 2026" for business-local dates, whatever the
 *  browser's timezone. */
function weekLabel(from: string, to: string, locale: string): string {
  const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));
  return `${fmt(from, { month: "short", day: "numeric" })} – ${fmt(to, { month: "short", day: "numeric", year: "numeric" })}`;
}

export default function AgendaPage() {
  const t = useTranslations("Agenda.page");
  const canCreateBookings = useCan("send-messages");
  const canEditSettings = useCan("edit-settings");
  const { ready: moduleReady, loading: moduleGateLoading } = useModuleGate("agenda");
  const locale = useLocale();
  const { account, accountId } = useAuth();
  const googleModule = isModuleEnabled(account?.enabled_modules, "google_calendar");
  const clinicModule = isModuleEnabled(account?.enabled_modules, "clinic");
  const clinic = useClinicDirectory(clinicModule);
  const [clinicOpen, setClinicOpen] = useState(false);
  // Clinic module: only this doctor's appointments ("" = everyone).
  const [doctorFilter, setDoctorFilter] = useState("");
  const doctorNames = useMemo(
    () => new Map(clinic.professionals.map((p) => [p.id, p.name])),
    [clinic.professionals],
  );

  // Monday of the week shown, as a Santo Domingo date.
  const [weekStart, setWeekStart] = useState(() => mondayOf(businessToday()));
  // The business's holidays (date -> name), drawn on the week view.
  const [holidays, setHolidays] = useState<Map<string, string>>(new Map());
  const [settingsVersion, setSettingsVersion] = useState(0);
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
  // Clinic module: upcoming appointments that still have no doctor (booked
  // before the doctors existed). They only show under "Sin doctor".
  const [unassigned, setUnassigned] = useState(0);
  const clinicActive = clinicModule && clinic.professionals.length > 0;

  useEffect(() => {
    if (!clinicActive) return;
    let cancelled = false;
    (async () => {
      const params = new URLSearchParams({ from: new Date().toISOString(), kind: "appointment" });
      const res = await fetch(`/api/bookings?${params.toString()}`).catch(() => null);
      if (!res?.ok || cancelled) return;
      const json = await res.json();
      const list = (json.bookings ?? []) as Booking[];
      setUnassigned(list.filter((b) => !b.professional_id && b.status !== "cancelled").length);
    })();
    return () => {
      cancelled = true;
    };
  }, [clinicActive, refreshKey]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      const { data } = await createClient()
        .from("accounts")
        .select("booking_settings")
        .eq("id", accountId)
        .maybeSingle();
      if (cancelled) return;
      const settings = (data?.booking_settings ?? null) as BookingSettings | null;
      setHolidays(
        new Map((settings?.holidays ?? []).map((d) => [d, settings?.holidayNames?.[d] ?? ""])),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, settingsVersion]);

  // Days the doctor being filtered on is away (clinic module, 067).
  const awayDates = useMemo(() => {
    const dates = new Set<string>();
    if (!doctorFilter || doctorFilter === NO_DOCTOR) return dates;
    for (const r of clinic.timeOff) {
      if (r.professional_id !== doctorFilter) continue;
      for (let d = r.starts_on, n = 0; d <= r.ends_on && n < 370; d = addDaysISO(d, 1), n++) dates.add(d);
    }
    return dates;
  }, [clinic.timeOff, doctorFilter]);

  const loadBookings = useCallback(async () => {
    const params = rangeToParams({ from: weekStart, to: addDaysISO(weekStart, 6) });
    params.set("kind", "appointment");
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

  function handleSlotClick(dateISO: string, hour: number) {
    setEditingBooking(null);
    setSlotDefaults({
      date: dateISO,
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

  const visibleBookings = !doctorFilter
    ? bookings
    : doctorFilter === NO_DOCTOR
      ? bookings.filter((b) => !b.professional_id)
      : bookings.filter((b) => b.professional_id === doctorFilter);

  const rangeLabel = weekLabel(weekStart, addDaysISO(weekStart, 6), locale);

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
                onClick={() => setWeekStart((d) => addDaysISO(d, -7))}
                className="rounded p-1 text-muted-foreground hover:bg-muted"
                aria-label={t("prevWeek")}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setWeekStart(mondayOf(businessToday()))}
                className="px-2 text-xs font-medium text-foreground hover:text-primary"
              >
                {t("today")}
              </button>
              <button
                type="button"
                onClick={() => setWeekStart((d) => addDaysISO(d, 7))}
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
          {clinic.professionals.length > 0 && (
            <select
              value={doctorFilter}
              onChange={(e) => setDoctorFilter(e.target.value)}
              aria-label={t("doctorFilter")}
              className="h-8 max-w-56 rounded-lg border border-border bg-card px-2 text-sm text-foreground"
            >
              <option value="">{t("allDoctors")}</option>
              <option value={NO_DOCTOR}>{t("noDoctorFilter")}</option>
              {clinic.professionals.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {clinicModule && (
            <GatedButton
              variant="outline"
              canAct={canEditSettings}
              gateReason="manage doctors"
              onClick={() => setClinicOpen(true)}
              className="border-border bg-card text-foreground hover:bg-muted"
            >
              <Stethoscope className="mr-1 h-4 w-4" />
              {t("doctors")}
            </GatedButton>
          )}
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

      {clinicActive && unassigned > 0 && doctorFilter !== NO_DOCTOR && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
          <span className="min-w-0 flex-1 text-foreground">{t("unassignedBanner", { count: unassigned })}</span>
          <button
            type="button"
            onClick={() => {
              setDoctorFilter(NO_DOCTOR);
              setView("list");
            }}
            className="rounded bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700"
          >
            {t("unassignedView")}
          </button>
        </div>
      )}

      <BookingStats refreshKey={refreshKey} onPick={pickStat} />

      {view === "week" ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_280px]">
          <AgendaCalendar
            weekStart={weekStart}
            bookings={visibleBookings}
            onSlotClick={handleSlotClick}
            onBookingClick={handleBookingClick}
            doctorNames={doctorNames}
            holidays={holidays}
            awayDates={awayDates}
          />
          <TodayPanel bookings={visibleBookings} onBookingClick={handleBookingClick} />
        </div>
      ) : (
        <BookingList
          filter={listFilter}
          onFilterChange={setListFilter}
          refreshKey={refreshKey}
          onBookingClick={handleBookingClick}
          professionals={clinic.professionals}
          professionalId={doctorFilter}
        />
      )}

      <BookingFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        booking={editingBooking}
        defaultDate={slotDefaults?.date}
        defaultStartTime={slotDefaults?.time}
        professionals={clinicModule ? clinic.professionals : []}
        services={clinicModule ? clinic.services : []}
        clinicExtended={clinicModule && clinic.extended}
        onSaved={refreshBookings}
      />

      {canEditSettings && (
        <BusinessHoursSettings
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          onSaved={() => setSettingsVersion((v) => v + 1)}
        />
      )}
      {canEditSettings && (
        <ReminderRulesSettings open={remindersOpen} onOpenChange={setRemindersOpen} scope="appointment" />
      )}
      {canEditSettings && clinicModule && (
        <ClinicDirectoryDialog
          open={clinicOpen}
          onOpenChange={setClinicOpen}
          migrated={clinic.migrated}
          professionals={clinic.professionals}
          specialties={clinic.specialties}
          extended={clinic.extended}
          services={clinic.services}
          timeOff={clinic.timeOff}
          settings={clinic.settings}
          onChanged={clinic.reload}
          onSamplesChanged={refreshBookings}
        />
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
