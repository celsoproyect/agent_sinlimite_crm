"use client";

import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import type { ExtraResource, Limits, PlanState, Usage } from "@/lib/plans/types";

export interface AccountPlanInfo {
  migrated: boolean;
  plan: {
    name: string;
    description: string | null;
    price: number;
    currency: string;
    billing_interval: "month" | "year";
  } | null;
  status: "trial" | "active" | "suspended";
  state: PlanState;
  days_left: number | null;
  suspends_at: string | null;
  expires_at: string | null;
  limits: Limits;
  usage: Usage | null;
  extras: {
    id: string;
    resource: ExtraResource;
    quantity: number;
    module_key: string | null;
    expires_at: string | null;
  }[];
  upgrade_url: string;
}

// One request per account shared by the banner, the suspended screen and
// Configuración → Mi plan.
const cache = new Map<string, Promise<AccountPlanInfo | null>>();

function fetchPlan(accountId: string, fresh: boolean): Promise<AccountPlanInfo | null> {
  const hit = cache.get(accountId);
  if (hit && !fresh) return hit;
  const promise = fetch("/api/account/plan")
    .then((res) => (res.ok ? (res.json() as Promise<AccountPlanInfo>) : null))
    .catch(() => null);
  cache.set(accountId, promise);
  return promise;
}

/** The signed-in account's plan (migration 074); null while loading. */
export function useAccountPlan() {
  const { accountId } = useAuth();
  const [info, setInfo] = useState<AccountPlanInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (fresh = false) => {
      if (!accountId) return;
      setLoading(true);
      const data = await fetchPlan(accountId, fresh);
      setInfo(data);
      setLoading(false);
    },
    [accountId],
  );

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    fetchPlan(accountId, false).then((data) => {
      if (cancelled) return;
      setInfo(data);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  return { info, loading, refresh: () => load(true) };
}
