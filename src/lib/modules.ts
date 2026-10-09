// ============================================================
// Togglable sidebar modules — account-level feature flags.
//
// A super admin can enable/disable each of these per account
// (accounts.enabled_modules JSONB, migration 048). Absence of a
// key means enabled — every account is fully-featured until a
// super admin explicitly flips one off.
//
// `dashboard` and `settings` are intentionally excluded: they're
// baseline navigation, not optional features, so they never appear
// in the super-admin toggle UI and are never gated on a page.
//
// Page modules must match the sidebar's `navSections[].items` hrefs
// (src/components/layout/sidebar.tsx), minus the leading slash — the
// sidebar filter and each page's `useModuleGate` call both key off this
// list. Feature modules (`ai_messages`, `telegram`, `widget_booking`,
// `google_calendar`, `clinic`) have no menu entry: their UI hides itself and the
// server checks them with `accountModuleEnabled` (modules-server.ts).
// `telegram` covers everything Telegram: handoff and lead alerts, the
// owner assistant and the weekly summary. `clinic` adds doctors with
// specialties, each with their own agenda (Agenda → Doctores).
// `restaurant` (/restaurant: tables, reservations, waitlist) and `events`
// (/events: halls, packages, event requests) are page modules that start
// OFF (DEFAULT_OFF_MODULES): most businesses don't need them, so they're
// only on once a super admin switches them on. `waitlist` is a feature
// module on top of `restaurant`. `leads` (/leads) lists every deal across
// pipelines and the raw web form submissions (migration 070).
// `web_push` sends handoff alerts as Web Push notifications to the
// owners'/admins' phones (Notificaciones page).
// ============================================================

export const MODULE_KEYS = [
  "inbox",
  "agenda",
  "notifications",
  "contacts",
  "pipelines",
  "leads",
  "broadcasts",
  "reports",
  "ai_messages",
  "telegram",
  "widget_booking",
  "google_calendar",
  "web_push",
  "clinic",
  "restaurant",
  "events",
  "waitlist",
  "automations",
  "flows",
  "agents",
  "catalog",
  "channels",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export function isModuleKey(value: string): value is ModuleKey {
  return (MODULE_KEYS as readonly string[]).includes(value);
}

/** Shape of `accounts.enabled_modules`. */
export type EnabledModules = Partial<Record<ModuleKey, boolean>>;

/** Modules that are off until a super admin switches them on. */
export const DEFAULT_OFF_MODULES: ReadonlySet<ModuleKey> = new Set<ModuleKey>([
  "restaurant",
  "events",
]);

/** Missing key = enabled, except for DEFAULT_OFF_MODULES, which need an
 *  explicit `true`. */
export function isModuleEnabled(
  enabledModules: EnabledModules | null | undefined,
  key: ModuleKey,
): boolean {
  if (DEFAULT_OFF_MODULES.has(key)) return enabledModules?.[key] === true;
  return enabledModules?.[key] !== false;
}
