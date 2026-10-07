import type { useTranslations } from "next-intl";
import type {
  Booking,
  BookingSettings,
  RestaurantArea,
  RestaurantSettings,
  RestaurantTable,
} from "@/types";
import type { FloorTable } from "@/lib/restaurant/tables";

// Shared bits of the /restaurant page (migration 068).

export type RestaurantT = ReturnType<typeof useTranslations>;

/** GET /api/restaurant. */
export interface RestaurantData {
  migrated: boolean;
  settings: RestaurantSettings;
  areas: RestaurantArea[];
  tables: RestaurantTable[];
  business: BookingSettings | null;
}

export type Reservation = Booking & { table_ids?: string[] };

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Quick picks for a reservation's length. */
export const DURATION_PRESETS = [60, 90, 120, 150];

export const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary";

/** The tables a reservation can be given: the active ones, examples hidden
 *  once real tables exist (the server does the same). */
export function bookableTables(tables: RestaurantTable[]): RestaurantTable[] {
  const active = tables.filter((t) => t.active);
  const real = active.filter((t) => !t.is_sample);
  return real.length > 0 ? real : active;
}

export function toFloorTables(tables: RestaurantTable[], areas: RestaurantArea[]): FloorTable[] {
  const areaName = new Map(areas.map((a) => [a.id, a.name]));
  return tables.map((t) => ({
    id: t.id,
    name: t.name,
    areaId: t.area_id ?? null,
    areaName: t.area_id ? areaName.get(t.area_id) ?? null : null,
    minParty: t.min_party,
    maxParty: t.max_party,
    combinable: t.combinable,
  }));
}

/** Minutes between a booking's start and end. */
export function durationOf(b: Pick<Booking, "starts_at" | "ends_at">): number {
  return Math.round((new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime()) / 60_000);
}

/** "1 h 30 min", "45 min", "2 h". */
export function formatMinutes(t: RestaurantT, minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return t("minutesShort", { m });
  if (m === 0) return t("hoursShort", { h });
  return t("hoursMinutesShort", { h, m });
}

const KNOWN_ERRORS = new Set([
  "needs_migration",
  "module_disabled",
  "duplicate_name",
  "table_busy",
  "table_in_use",
  "unavailable",
  "no_tables",
  "invalid_party",
  "invalid_duration",
  "required_fields",
  "contact_not_found",
  "not_found",
  "not_saved",
  "name_required",
  "invalid_values",
]);

/** A failed API response as text for a toast. "unavailable" carries the
 *  engine's own explanation when it gave one. */
export async function apiErrorText(res: Response, t: RestaurantT): Promise<string> {
  const json = (await res.json().catch(() => null)) as { error?: string; message?: string | null } | null;
  const code = json?.error ?? "";
  // The engine's reason is written for the AI (English): shown as detail.
  if (code === "unavailable" && json?.message) return `${t("errors.unavailable")} (${json.message})`;
  if (KNOWN_ERRORS.has(code)) return t(`errors.${code}`);
  if (res.status === 403) return t("errors.forbidden");
  return code || t("errors.generic");
}
