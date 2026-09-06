import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Dummy secrets — encryption.ts / webhook-signature.ts read these
    // at module load. Tests never hit a real Meta/Supabase service, so
    // any 32-byte hex / non-empty string will do; keep them lexically
    // identical to the CI build env so behaviour matches.
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
      // Deliberately NOT the business zone. The app runs in
      // America/Santo_Domingo (see src/lib/business-timezone.ts), but
      // scheduling code must produce the same answer wherever the
      // process happens to boot — that is the whole point of the
      // business-timezone helpers. Running the suite in UTC keeps that
      // honest: any code that slips back into reading the host clock
      // (`new Date("2026-09-07T09:00:00")`, `date.getDay()`,
      // `toLocaleTimeString()` with no zone) goes four hours off here
      // and fails loudly, instead of passing on a developer machine
      // that happens to sit at UTC-4 too.
      TZ: "UTC",
    },
    clearMocks: true,
  },
});
