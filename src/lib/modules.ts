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
// Keys must match the sidebar's `navSections[].items` hrefs
// (src/components/layout/sidebar.tsx), minus the leading slash — the
// sidebar filter and each page's `useModuleGate` call both key off this
// list.
// ============================================================

export const MODULE_KEYS = [
  "inbox",
  "agenda",
  "notifications",
  "contacts",
  "pipelines",
  "broadcasts",
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

/** Shape of `accounts.enabled_modules`. Only `false` is meaningful. */
export type EnabledModules = Partial<Record<ModuleKey, boolean>>;

/** Missing key = enabled. Only an explicit `false` disables a module. */
export function isModuleEnabled(
  enabledModules: EnabledModules | null | undefined,
  key: ModuleKey,
): boolean {
  return enabledModules?.[key] !== false;
}
