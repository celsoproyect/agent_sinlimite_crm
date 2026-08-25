"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { isModuleEnabled, type ModuleKey } from "@/lib/modules";

/**
 * Client-side gate for a togglable sidebar module (migration 048).
 * Mirrors the /super-admin page's own gate: redirect to /dashboard
 * once the profile settles, so a client whose account had this
 * module disabled never lands on more than a spinner, even via a
 * direct URL.
 *
 * Callers render a loading state while `loading` is true and while
 * `ready` is false (the redirect is in flight) — see the ten pages
 * under MODULE_KEYS for the exact pattern.
 */
export function useModuleGate(moduleKey: ModuleKey) {
  const router = useRouter();
  const { account, profileLoading } = useAuth();
  const enabled = isModuleEnabled(account?.enabled_modules, moduleKey);

  useEffect(() => {
    if (!profileLoading && !enabled) {
      router.replace("/dashboard");
    }
  }, [profileLoading, enabled, router]);

  return { ready: !profileLoading && enabled, loading: profileLoading };
}
