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
import { toast } from "sonner";
import { useTranslations } from "next-intl";

interface BusinessHoursSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

export function BusinessHoursSettings({ open, onOpenChange }: BusinessHoursSettingsProps) {
  const t = useTranslations("Agenda.businessHours");
  const supabase = createClient();
  const { accountId } = useAuth();

  const [slotMinutes, setSlotMinutes] = useState(30);
  const [bufferMinutes, setBufferMinutes] = useState(0);
  const [days, setDays] = useState<Record<Weekday, DayState>>(fromSettings(null));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

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
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, accountId, supabase]);

  async function handleSave() {
    if (!accountId) return;
    setSaving(true);

    const hours: BookingSettings["hours"] = {};
    for (const day of WEEKDAYS) {
      const d = days[day];
      hours[day] = d.open ? { open: d.openTime, close: d.closeTime } : null;
    }
    const settings: BookingSettings = { slotMinutes, bufferMinutes, hours };

    const { error } = await supabase
      .from("accounts")
      .update({ booking_settings: settings })
      .eq("id", accountId);

    setSaving(false);
    if (error) {
      toast.error(t("toastFailedSave"));
      return;
    }
    toast.success(t("toastSaved"));
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-popover border-border">
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
                    <button
                      type="button"
                      onClick={() =>
                        setDays((prev) => ({
                          ...prev,
                          [day]: { ...prev[day], open: !prev[day].open },
                        }))
                      }
                      className="w-24 shrink-0 text-left text-xs font-medium text-foreground"
                    >
                      {t(day)}
                    </button>
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
