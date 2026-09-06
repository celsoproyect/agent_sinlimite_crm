import { applyBusinessTimeZone } from '@/lib/business-timezone'

/**
 * Next.js calls this once per server instance, before the first request
 * is served — in `next dev`, in `next start`, and in the standalone
 * bundle the Docker image runs.
 *
 * We use it for one thing: pinning the process clock to the business
 * timezone. `next.config.ts` sets it too, but `output: "standalone"`
 * inlines the resolved config at build time and never evaluates that
 * file again at runtime, so the config alone would leave the production
 * server on whatever zone its host booted in. This hook is the one place
 * that runs in every environment.
 *
 * Edge runtime has no `process.env.TZ` to speak of and no Node date
 * cache to reset, so the assignment is skipped there.
 */
export function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  applyBusinessTimeZone()
}
