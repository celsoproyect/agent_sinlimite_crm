"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { BookingSettings, RestaurantSettings } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { WEEKDAYS, apiErrorText, type Weekday } from "./restaurant-utils";

interface RestaurantSettingsPanelProps {
  settings: RestaurantSettings;
  onSaved: () => void;
}

type NumberField =
  | "default_duration_minutes"
  | "min_duration_minutes"
  | "max_duration_minutes"
  | "slot_minutes"
  | "buffer_minutes"
  | "last_seating_minutes"
  | "max_party_ai";

const NUMBER_FIELDS: NumberField[] = [
  "default_duration_minutes",
  "min_duration_minutes",
  "max_duration_minutes",
  "slot_minutes",
  "buffer_minutes",
  "last_seating_minutes",
  "max_party_ai",
];

interface DayState {
  open: boolean;
  openTime: string;
  closeTime: string;
}

function daysFrom(hours: BookingSettings["hours"] | null | undefined): Record<Weekday, DayState> {
  const out = {} as Record<Weekday, DayState>;
  for (const day of WEEKDAYS) {
    const h = hours?.[day];
    out[day] = h ? { open: true, openTime: h.open, closeTime: h.close } : { open: !hours, openTime: "12:00", closeTime: "23:00" };
  }
  return out;
}

/** Every restaurant setting. Its own weekly hours are optional: off = the
 *  agenda's business hours. */
export function RestaurantSettingsPanel({ settings, onSaved }: RestaurantSettingsPanelProps) {
  const t = useTranslations("Restaurant");
  const [numbers, setNumbers] = useState<Record<NumberField, string>>(
    () => Object.fromEntries(NUMBER_FIELDS.map((f) => [f, String(settings[f])])) as Record<NumberField, string>,
  );
  const [allowCombine, setAllowCombine] = useState(settings.allow_combine);
  const [allowPreorder, setAllowPreorder] = useState(settings.allow_preorder);
  const [ownHours, setOwnHours] = useState(!!settings.hours);
  const [days, setDays] = useState(() => daysFrom(settings.hours));
  const [saving, setSaving] = useState(false);

  function setDay(day: Weekday, patch: Partial<DayState>) {
    setDays((prev) => ({ ...prev, [day]: { ...prev[day], ...patch } }));
  }

  async function save() {
    let hours: BookingSettings["hours"] | null = null;
    if (ownHours) {
      hours = {};
      for (const day of WEEKDAYS) {
        const d = days[day];
        if (d.open && d.closeTime <= d.openTime) {
          toast.error(t("hoursInvalid", { day: t(`weekday.${day}`) }));
          return;
        }
        hours[day] = d.open ? { open: d.openTime, close: d.closeTime } : null;
      }
      if (!WEEKDAYS.some((d) => days[d].open)) {
        toast.error(t("hoursNoneOpen"));
        return;
      }
    }
    setSaving(true);
    const res = await fetch("/api/restaurant/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...Object.fromEntries(NUMBER_FIELDS.map((f) => [f, Number(numbers[f])])),
        allow_combine: allowCombine,
        allow_preorder: allowPreorder,
        hours,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      toast.error(await apiErrorText(res, t));
      return;
    }
    toast.success(t("settingsSaved"));
    onSaved();
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-medium text-foreground">{t("settingsReservations")}</h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {NUMBER_FIELDS.map((f) => (
            <div key={f} className="grid gap-1.5">
              <Label className="text-muted-foreground">{t(`settingsField.${f}`)}</Label>
              <Input
                type="number"
                min={0}
                value={numbers[f]}
                onChange={(e) => setNumbers((prev) => ({ ...prev, [f]: e.target.value }))}
                className="border-border bg-muted"
              />
              <p className="text-xs text-muted-foreground">{t(`settingsHint.${f}`)}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-sm">
        <label className="flex items-center justify-between gap-3 text-sm text-foreground">
          <span>
            {t("settingsField.allow_combine")}
            <span className="block text-xs text-muted-foreground">{t("settingsHint.allow_combine")}</span>
          </span>
          <Switch checked={allowCombine} onCheckedChange={setAllowCombine} />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm text-foreground">
          <span>
            {t("settingsField.allow_preorder")}
            <span className="block text-xs text-muted-foreground">{t("settingsHint.allow_preorder")}</span>
          </span>
          <Switch checked={allowPreorder} onCheckedChange={setAllowPreorder} />
        </label>
      </section>

      <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <label className="flex items-center justify-between gap-3 text-sm text-foreground">
          <span>
            {t("ownHours")}
            <span className="block text-xs text-muted-foreground">{t("ownHoursHint")}</span>
          </span>
          <Switch checked={ownHours} onCheckedChange={setOwnHours} />
        </label>
        {ownHours && (
          <ul className="mt-4 space-y-2">
            {WEEKDAYS.map((day) => {
              const d = days[day];
              return (
                <li key={day} className="flex flex-wrap items-center gap-3">
                  <label className="flex min-w-28 items-center gap-2 text-sm text-foreground">
                    <Switch checked={d.open} onCheckedChange={(v) => setDay(day, { open: v })} />
                    {t(`weekday.${day}`)}
                  </label>
                  {d.open ? (
                    <div className="flex items-center gap-2">
                      <Input
                        type="time"
                        value={d.openTime}
                        onChange={(e) => setDay(day, { openTime: e.target.value })}
                        className="w-28 border-border bg-muted"
                      />
                      <span className="text-muted-foreground">–</span>
                      <Input
                        type="time"
                        value={d.closeTime}
                        onChange={(e) => setDay(day, { closeTime: e.target.value })}
                        className="w-28 border-border bg-muted"
                      />
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground">{t("closed")}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>
          {saving ? t("saving") : t("save")}
        </Button>
      </div>
    </div>
  );
}
