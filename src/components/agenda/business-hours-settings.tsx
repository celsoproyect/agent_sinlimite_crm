"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { BookingSettings } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { X } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { addDaysISO } from "@/lib/bookings/ranges";
import { businessToday, businessWeekday } from "@/lib/business-timezone";

interface BusinessHoursSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful save (the agenda redraws its holidays). */
  onSaved?: () => void;
}

/** Longest holiday range added at once, so a typo in the year doesn't add
 *  hundreds of dates. */
const MAX_HOLIDAY_RANGE_DAYS = 60;

const WEEKDAY_SHORT_ES = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

/** "2026-12-25" → "vie 25/12/2026". */
function formatHoliday(dateISO: string): string {
  const [y, m, d] = dateISO.split("-");
  return `${WEEKDAY_SHORT_ES[businessWeekday(dateISO)]} ${d}/${m}/${y}`;
}

type Weekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

const WEEKDAYS: Weekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

interface DayState {
  open: boolean;
  openTime: string;
  closeTime: string;
}

const DEFAULT_DAY: DayState = { open: true, openTime: "09:00", closeTime: "18:00" };

function fromSettings(settings: BookingSettings | null): Record<Weekday, DayState> {
  const result = {} as Record<Weekday, DayState>;
  for (const day of WEEKDAYS) {
    const hours = settings?.hours?.[day];
    if (hours === null) {
      result[day] = { open: false, openTime: DEFAULT_DAY.openTime, closeTime: DEFAULT_DAY.closeTime };
    } else if (hours) {
      result[day] = { open: true, openTime: hours.open, closeTime: hours.close };
    } else {
      result[day] = { ...DEFAULT_DAY };
    }
  }
  return result;
}

export function BusinessHoursSettings({ open, onOpenChange, onSaved }: BusinessHoursSettingsProps) {
  const t = useTranslations("Agenda.businessHours");
  const supabase = createClient();
  const { accountId } = useAuth();

  const [slotMinutes, setSlotMinutes] = useState(30);
  const [bufferMinutes, setBufferMinutes] = useState(0);
  const [days, setDays] = useState<Record<Weekday, DayState>>(fromSettings(null));
  const [holidays, setHolidays] = useState<string[]>([]);
  const [holidayNames, setHolidayNames] = useState<Record<string, string>>({});
  const [newHoliday, setNewHoliday] = useState("");
  const [newHolidayTo, setNewHolidayTo] = useState("");
  const [newHolidayName, setNewHolidayName] = useState("");
  const [showPast, setShowPast] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // False when the account has never saved any hours: the rows below are
  // then only suggested defaults, and the AI agent has no booking tools
  // until something is actually saved — say so instead of letting the
  // defaults pass for a real schedule.
  const [hasSavedHours, setHasSavedHours] = useState(true);

  useEffect(() => {
    if (!open || !accountId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from("accounts")
        .select("booking_settings")
        .eq("id", accountId)
        .maybeSingle();
      if (cancelled) return;
      const settings = (data?.booking_settings ?? null) as BookingSettings | null;
      setSlotMinutes(settings?.slotMinutes ?? 30);
      setBufferMinutes(settings?.bufferMinutes ?? 0);
      setDays(fromSettings(settings));
      setHolidays([...(settings?.holidays ?? [])].sort());
      setHolidayNames({ ...(settings?.holidayNames ?? {}) });
      setNewHoliday("");
      setNewHolidayTo("");
      setNewHolidayName("");
      setHasSavedHours(!!settings?.hours && Object.keys(settings.hours).length > 0);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, accountId, supabase]);

  function addHoliday() {
    if (!newHoliday) return;
    const to = newHolidayTo && newHolidayTo > newHoliday ? newHolidayTo : newHoliday;
    const dates: string[] = [];
    for (let d = newHoliday; d <= to; d = addDaysISO(d, 1)) {
      dates.push(d);
      if (dates.length > MAX_HOLIDAY_RANGE_DAYS) {
        toast.error(t("holidayRangeTooLong", { days: MAX_HOLIDAY_RANGE_DAYS }));
        return;
      }
    }
    const name = newHolidayName.trim();
    setHolidays((prev) => [...new Set([...prev, ...dates])].sort());
    if (name) {
      setHolidayNames((prev) => {
        const next = { ...prev };
        for (const d of dates) next[d] = name;
        return next;
      });
    }
    setNewHoliday("");
    setNewHolidayTo("");
    setNewHolidayName("");
  }

  function removeHoliday(date: string) {
    setHolidays((prev) => prev.filter((d) => d !== date));
    setHolidayNames((prev) => {
      const next = { ...prev };
      delete next[date];
      return next;
    });
  }

  const today = businessToday();
  const pastHolidays = holidays.filter((d) => d < today);
  const shownHolidays = showPast ? holidays : holidays.filter((d) => d >= today);

  async function handleSave() {
    if (!accountId) return;
    setSaving(true);

    const hours: BookingSettings["hours"] = {};
    for (const day of WEEKDAYS) {
      const d = days[day];
      hours[day] = d.open ? { open: d.openTime, close: d.closeTime } : null;
    }
    // Names only for dates still on the list.
    const names = Object.fromEntries(
      Object.entries(holidayNames).filter(([d, n]) => holidays.includes(d) && n.trim()),
    );
    const settings: BookingSettings = { slotMinutes, bufferMinutes, hours, holidays, holidayNames: names };

    // `.select()` so a write that RLS silently filtered out (0 rows, no
    // error) is reported as a failure instead of a false "saved" toast.
    const { data: saved, error } = await supabase
      .from("accounts")
      .update({ booking_settings: settings })
      .eq("id", accountId)
      .select("id");

    setSaving(false);
    if (error || !saved || saved.length === 0) {
      if (error) console.error("[business hours] save failed:", error);
      else console.error("[business hours] save matched no account row", { accountId });
      toast.error(t("toastFailedSave"));
      return;
    }
    toast.success(t("toastSaved"));
    onOpenChange(false);
    onSaved?.();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md bg-popover border-border">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t("title")}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="space-y-2 py-4">
            {WEEKDAYS.map((d) => (
              <div key={d} className="h-9 animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {!hasSavedHours && (
              <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                {t("notSavedYet")}
              </p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">{t("slotMinutes")}</Label>
                <Input
                  type="number"
                  min={5}
                  step={5}
                  value={slotMinutes}
                  onChange={(e) => setSlotMinutes(Number(e.target.value) || 0)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">{t("bufferMinutes")}</Label>
                <Input
                  type="number"
                  min={0}
                  step={5}
                  value={bufferMinutes}
                  onChange={(e) => setBufferMinutes(Number(e.target.value) || 0)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
            </div>

            <div className="space-y-2">
              {WEEKDAYS.map((day) => {
                const d = days[day];
                return (
                  <div
                    key={day}
                    className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2"
                  >
                    <Switch
                      checked={d.open}
                      onCheckedChange={(checked) =>
                        setDays((prev) => ({
                          ...prev,
                          [day]: { ...prev[day], open: checked },
                        }))
                      }
                    />
                    <span className="w-20 shrink-0 text-left text-xs font-medium text-foreground">
                      {t(day)}
                    </span>
                    {d.open ? (
                      <div className="flex flex-1 items-center gap-1.5">
                        <Input
                          type="time"
                          value={d.openTime}
                          onChange={(e) =>
                            setDays((prev) => ({
                              ...prev,
                              [day]: { ...prev[day], openTime: e.target.value },
                            }))
                          }
                          className="h-8 border-border bg-background text-xs text-foreground"
                        />
                        <span className="text-xs text-muted-foreground">–</span>
                        <Input
                          type="time"
                          value={d.closeTime}
                          onChange={(e) =>
                            setDays((prev) => ({
                              ...prev,
                              [day]: { ...prev[day], closeTime: e.target.value },
                            }))
                          }
                          className="h-8 border-border bg-background text-xs text-foreground"
                        />
                      </div>
                    ) : (
                      <span className="flex-1 text-xs text-muted-foreground">
                        {t("closed")}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="space-y-2 border-t border-border/60 pt-3">
              <Label className="text-muted-foreground">{t("holidaysTitle")}</Label>
              <p className="text-xs text-muted-foreground">{t("holidaysDesc")}</p>
              <div className="grid grid-cols-2 gap-1.5">
                <div className="grid gap-1">
                  <span className="text-[0.6875rem] text-muted-foreground">{t("holidayFrom")}</span>
                  <Input
                    type="date"
                    value={newHoliday}
                    onChange={(e) => setNewHoliday(e.target.value)}
                    className="h-8 border-border bg-background text-xs text-foreground"
                  />
                </div>
                <div className="grid gap-1">
                  <span className="text-[0.6875rem] text-muted-foreground">{t("holidayTo")}</span>
                  <Input
                    type="date"
                    value={newHolidayTo}
                    min={newHoliday || undefined}
                    onChange={(e) => setNewHolidayTo(e.target.value)}
                    className="h-8 border-border bg-background text-xs text-foreground"
                  />
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  value={newHolidayName}
                  onChange={(e) => setNewHolidayName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addHoliday();
                    }
                  }}
                  placeholder={t("holidayNamePlaceholder")}
                  maxLength={60}
                  className="h-8 min-w-0 flex-1 border-border bg-background text-xs text-foreground"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={addHoliday}
                  disabled={!newHoliday}
                  className="shrink-0 border-border text-muted-foreground hover:bg-muted"
                >
                  {t("addHoliday")}
                </Button>
              </div>
              {shownHolidays.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("noHolidays")}</p>
              ) : (
                <ul className="max-h-56 space-y-1 overflow-y-auto">
                  {shownHolidays.map((date) => (
                    <li
                      key={date}
                      className={
                        date < today
                          ? "flex items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/20 px-2 py-1 text-xs text-muted-foreground"
                          : "flex items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-xs text-foreground"
                      }
                    >
                      <span className="min-w-0">
                        <span className="font-medium">{formatHoliday(date)}</span>
                        {holidayNames[date] && (
                          <span className="ml-1.5 break-words text-muted-foreground">{holidayNames[date]}</span>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeHoliday(date)}
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        aria-label={t("removeHoliday")}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {pastHolidays.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowPast((v) => !v)}
                  className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {showPast ? t("hidePastHolidays") : t("showPastHolidays", { count: pastHolidays.length })}
                </button>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t("cancel")}
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || loading}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving ? t("saving") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
