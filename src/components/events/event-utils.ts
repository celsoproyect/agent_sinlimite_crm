import type { EventStatus } from "@/types";

/** Pipeline columns, in order. */
export const EVENT_COLUMNS: EventStatus[] = [
  "requested",
  "quoted",
  "deposit_paid",
  "confirmed",
  "completed",
  "cancelled",
];

/** Badge colors per status (tokens only, so both color modes work). */
export const EVENT_STATUS_TONE: Record<EventStatus, string> = {
  requested: "bg-amber-500/15 text-amber-600",
  quoted: "bg-sky-500/15 text-sky-600",
  deposit_paid: "bg-violet-500/15 text-violet-600",
  confirmed: "bg-primary/15 text-primary",
  completed: "bg-emerald-500/15 text-emerald-600",
  cancelled: "bg-muted text-muted-foreground",
};

/** "DOP 25,000" in the viewer's locale; null when there's no amount. */
export function formatMoney(amount: number | null | undefined, currency: string, locale: string): string | null {
  if (amount == null || !Number.isFinite(Number(amount))) return null;
  return `${currency} ${Number(amount).toLocaleString(locale, { maximumFractionDigits: 2 })}`;
}

/** Send JSON to an events route; returns the parsed body and the error code when it failed. */
export async function sendJson<T = Record<string, unknown>>(
  url: string,
  method: string,
  body?: unknown,
): Promise<{ ok: true; data: T } | { ok: false; code: string; message?: string }> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).catch(() => null);
  if (!res) return { ok: false, code: "network" };
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      code: typeof json.error === "string" ? json.error : "failed",
      message: typeof json.message === "string" ? json.message : undefined,
    };
  }
  return { ok: true, data: json as T };
}

/** API error codes that have their own message under Events.errors. */
export const KNOWN_ERRORS = new Set([
  "needs_migration",
  "module_disabled",
  "name_required",
  "invalid_capacity",
  "invalid_capacity_max",
  "invalid_capacity_min",
  "invalid_price",
  "invalid_min_hours",
  "invalid_deposit_percent",
  "invalid_guests",
  "invalid_duration",
  "invalid_hours",
  "invalid_date",
  "invalid_amount",
  "invalid_transition",
  "hall_busy",
  "no_halls",
  "missing_fields",
  "contact_not_found",
  "unavailable",
]);
