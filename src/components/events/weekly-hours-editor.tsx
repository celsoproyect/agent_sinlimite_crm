"use client";

import { useTranslations } from "next-intl";
import type { BookingSettings } from "@/types";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

export type WeeklyHours = NonNullable<BookingSettings["hours"]>;
type Weekday = keyof WeeklyHours;

const WEEKDAYS: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DEFAULT_OPEN = { open: "10:00", close: "23:00" };

/** Every day open with the default hours, as a starting point. */
export function defaultWeeklyHours(): WeeklyHours {
  return Object.fromEntries(WEEKDAYS.map((d) => [d, { ...DEFAULT_OPEN }])) as WeeklyHours;
}

/** A day per row: open switch plus opening and closing time. */
export function WeeklyHoursEditor({ value, onChange }: { value: WeeklyHours; onChange: (next: WeeklyHours) => void }) {
  const tDays = useTranslations("Agenda.businessHours");
  const set = (day: Weekday, next: { open: string; close: string } | null) => onChange({ ...value, [day]: next });

  return (
    <div className="space-y-2">
      {WEEKDAYS.map((day) => {
        const d = value[day] ?? null;
        return (
          <div key={day} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2">
            <Switch checked={!!d} onCheckedChange={(checked) => set(day, checked ? { ...DEFAULT_OPEN } : null)} />
            <span className="min-w-20 text-left text-xs font-medium text-foreground">{tDays(day)}</span>
            {d ? (
              <div className="flex flex-1 items-center gap-1.5">
                <Input
                  type="time"
                  value={d.open}
                  onChange={(e) => set(day, { ...d, open: e.target.value })}
                  className="h-8 border-border bg-background text-xs text-foreground"
                />
                <span className="text-xs text-muted-foreground">–</span>
                <Input
                  type="time"
                  value={d.close}
                  onChange={(e) => set(day, { ...d, close: e.target.value })}
                  className="h-8 border-border bg-background text-xs text-foreground"
                />
              </div>
            ) : (
              <span className="flex-1 text-xs text-muted-foreground">{tDays("closed")}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
