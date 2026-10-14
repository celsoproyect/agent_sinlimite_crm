import type { useTranslations } from "next-intl";
import type { Booking } from "@/types";
import type { Property } from "@/lib/real-estate/search";

// Shared bits of the /properties page (real estate module, migration 077).

export type PropertiesT = ReturnType<typeof useTranslations>;

export interface Advisor {
  id: string;
  name: string;
  bio?: string | null;
  active: boolean;
  slot_minutes?: number | null;
  sort_order: number;
  is_sample?: boolean;
}

/** A visit: an appointment booking with a property_id. */
export type Visit = Booking;

/** "CODE · Title", or the title alone. */
export function propertyLabel(p: Pick<Property, "code" | "title">): string {
  return `${p.code ? `${p.code} · ` : ""}${p.title}`;
}

/** GET /api/properties. */
export interface PropertiesData {
  migrated: boolean;
  properties: Property[];
  advisors: Advisor[];
  visits?: Visit[];
}

export const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary";

export function formatPrice(price: number | null, currency: string, locale: string): string {
  if (price == null) return "—";
  return `${currency} ${price.toLocaleString(locale === "es" ? "es-DO" : "en-US", { maximumFractionDigits: 2 })}`;
}

const KNOWN_ERRORS = new Set([
  "needs_migration",
  "module_disabled",
  "duplicate_code",
  "invalid_values",
  "invalid_advisor",
  "title_required",
  "name_required",
  "invalid_price",
  "invalid_bedrooms",
  "invalid_bathrooms",
  "invalid_parking",
  "invalid_area_m2",
  "not_found",
]);

/** A failed API response as text for a toast. */
export async function apiErrorText(res: Response, t: PropertiesT): Promise<string> {
  const json = (await res.json().catch(() => null)) as { error?: string } | null;
  const code = json?.error ?? "";
  if (code === "clinic_not_migrated") return t("errors.needs_migration");
  if (KNOWN_ERRORS.has(code)) return t(`errors.${code}`);
  if (res.status === 403) return t("errors.forbidden");
  return code || t("errors.generic");
}
