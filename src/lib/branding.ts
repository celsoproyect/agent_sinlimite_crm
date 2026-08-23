/**
 * Fallback branding — used until `platform_settings` loads (or if a
 * fresh deployment hasn't been migrated/seeded yet). A super admin
 * overrides these at runtime from /super-admin; see migration 040.
 */
export const DEFAULT_COMPANY_NAME = "Sin Limite IA";
export const DEFAULT_LOGO_URL = "/logo.png";

export interface PlatformBranding {
  companyName: string;
  logoUrl: string;
}

export const DEFAULT_BRANDING: PlatformBranding = {
  companyName: DEFAULT_COMPANY_NAME,
  logoUrl: DEFAULT_LOGO_URL,
};
