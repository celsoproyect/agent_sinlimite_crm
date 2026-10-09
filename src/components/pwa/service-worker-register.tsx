"use client";

import { useEffect } from "react";

/**
 * Registers `public/sw.js`, which makes the CRM installable and shows an
 * offline page instead of the browser's error. Production only: in dev a
 * worker would keep serving stale build assets between reloads.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch(() => {
        // Non-fatal: the app works the same without the worker.
      });
  }, []);
  return null;
}
