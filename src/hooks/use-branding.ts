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
    const supabase = createClient();
    supabase
      .from("platform_settings")
      .select("company_name, logo_url")
      .eq("id", true)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (!error && data) {
          setBranding({
            companyName: data.company_name || DEFAULT_BRANDING.companyName,
            logoUrl: data.logo_url || DEFAULT_BRANDING.logoUrl,
          });
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { ...branding, loading };
}
