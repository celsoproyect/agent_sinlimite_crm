"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarDays, ChevronLeft, ChevronRight, List } from "lucide-react";
import { addDaysISO, mondayOf, weekLabel } from "@/lib/bookings/ranges";
import { businessToday } from "@/lib/business-timezone";

// Shared by the restaurant, events and real estate pages: every list of
// bookings can also be seen as a week calendar, and the choice is
// remembered per page in this browser.

export type ScheduleView = "list" | "calendar";

/** The page's view, remembered in localStorage under `storageKey`. */
export function useScheduleView(storageKey: string, fallback: ScheduleView = "list") {
  const key = `schedule-view:${storageKey}`;
  const [view, setViewState] = useState<ScheduleView>(fallback);
  // Read after mounting, so the server render and hydration agree.
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(key);
    } catch {
      // Storage blocked: keep the default.
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restores the saved choice once mounted
    if (saved === "list" || saved === "calendar") setViewState(saved);
  }, [key]);
  const setView = useCallback(
    (next: ScheduleView) => {
      setViewState(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // Private mode or blocked storage: the choice just isn't kept.
      }
    },
    [key],
  );
  return [view, setView] as const;
}

const ON = "flex min-h-9 items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground sm:min-h-0";
const OFF = "flex min-h-9 items-center gap-1 rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground sm:min-h-0";

export function ViewToggle({
  value,
  onChange,
  listLabel,
}: {
  value: ScheduleView;
  onChange: (view: ScheduleView) => void;
  /** Overrides "Lista" (the events page calls its list the board). */
  listLabel?: string;
}) {
  const t = useTranslations("Schedule");
  return (
    <div className="flex w-fit items-center gap-1 rounded-lg border border-border bg-card p-1">
      <button type="button" onClick={() => onChange("list")} className={value === "list" ? ON : OFF}>
        <List className="h-3.5 w-3.5" />
        {listLabel ?? t("list")}
      </button>
      <button type="button" onClick={() => onChange("calendar")} className={value === "calendar" ? ON : OFF}>
        <CalendarDays className="h-3.5 w-3.5" />
        {t("calendar")}
      </button>
    </div>
  );
}

/** Previous / this / next week, with the week's dates. `weekStart` is a
 *  business-local Monday. */
export function WeekNav({ weekStart, onChange }: { weekStart: string; onChange: (monday: string) => void }) {
  const t = useTranslations("Schedule");
  const locale = useLocale();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1">
        <button
          type="button"
          onClick={() => onChange(addDaysISO(weekStart, -7))}
          className="flex h-9 w-9 items-center justify-center rounded text-muted-foreground hover:bg-muted sm:h-7 sm:w-7"
          aria-label={t("prevWeek")}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onChange(mondayOf(businessToday()))}
          className="min-h-9 px-2 text-xs font-medium text-foreground hover:text-primary sm:min-h-0"
        >
          {t("thisWeek")}
        </button>
        <button
          type="button"
          onClick={() => onChange(addDaysISO(weekStart, 7))}
          className="flex h-9 w-9 items-center justify-center rounded text-muted-foreground hover:bg-muted sm:h-7 sm:w-7"
          aria-label={t("nextWeek")}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <span className="text-sm text-muted-foreground">{weekLabel(weekStart, addDaysISO(weekStart, 6), locale)}</span>
    </div>
  );
}

/** "HH:00" for a calendar hour cell. */
export function hourTime(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}
