"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";

import {
  planErrorFromBody,
  planErrorFromDb,
  type PlanErrorMessage,
} from "@/lib/plans/client-errors";

/**
 * Message for a plan refusal, or null when the error is something else:
 *   const planError = usePlanError();
 *   const msg = planError.fromBody(json) ?? fallback;
 */
export function usePlanError() {
  const t = useTranslations("Plan");

  const format = useCallback(
    (e: PlanErrorMessage | null): string | null => {
      if (!e) return null;
      if (e.key === "suspended") return t("errors.suspended");
      const resource = t(`resourceShort.${e.resource}`);
      return e.limit !== null
        ? t("errors.limitReached", { limit: e.limit, resource })
        : t("errors.limitReachedNoNumber", { resource });
    },
    [t],
  );

  const fromBody = useCallback(
    (body: unknown) => format(planErrorFromBody(body)),
    [format],
  );
  const fromDb = useCallback(
    (error: { message?: string | null; details?: string | null } | null | undefined) =>
      format(planErrorFromDb(error)),
    [format],
  );

  return { fromBody, fromDb };
}
