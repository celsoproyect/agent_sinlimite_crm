"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { DEFAULT_BRANDING, type PlatformBranding } from "@/lib/branding";

/**
 * Reads this deployment's branding from `platform_settings` (public
 * SELECT, migration 040). Renders the DEFAULT_BRANDING fallback while
 * loading and on error/missing-row (e.g. a pre-migration-040
 * deployment) so callers never need their own null-checks — the
 * login screen in particular reads this while signed out.
 */
export function useBranding(): PlatformBranding & { loading: boolean } {
  const [branding, setBranding] = useState<PlatformBranding>(DEFAULT_BRANDING);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchBranding().then((next) => {
      if (cancelled) return;
      if (next) setBranding(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { ...branding, loading };
}

/**
 * One read of the branding row. Falls back to the pre-061 column set
 * when `logo_light_url` doesn't exist yet (Postgres 42703), so the
 * app keeps its logo until the migration is applied.
 */
export async function fetchBranding(): Promise<PlatformBranding | null> {
  const supabase = createClient();
  let { data, error } = await supabase
    .from("platform_settings")
    .select("company_name, logo_url, logo_light_url")
    .eq("id", true)
    .maybeSingle();
  if (error?.code === "42703") {
    ({ data, error } = await supabase
      .from("platform_settings")
      .select("company_name, logo_url")
      .eq("id", true)
      .maybeSingle());
  }
  if (error || !data) return null;
  const row = data as {
    company_name: string | null;
    logo_url: string | null;
    logo_light_url?: string | null;
  };
  return {
    companyName: row.company_name || DEFAULT_BRANDING.companyName,
    logoUrl: row.logo_url || DEFAULT_BRANDING.logoUrl,
    logoLightUrl: row.logo_light_url || null,
  };
}
