import type { SupabaseClient } from '@supabase/supabase-js'
import { drainPendingAutomations } from '@/lib/automations/drain-pending'
import { autoLoseStaleDeals } from '@/lib/deals/auto-lose'
import { sendDueWeeklySummaries } from '@/lib/reports/weekly-summary'

type Timers = Record<string, ReturnType<typeof setInterval> | undefined>

/** Run `job` every `seconds`, at most one run at a time, once per process. */
function every(key: string, seconds: number, job: () => Promise<unknown>) {
  const g = globalThis as { __serverSchedulers?: Timers }
  const timers = (g.__serverSchedulers ??= {})
  if (timers[key]) return

  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      await job()
    } catch (err) {
      console.error(`[scheduler:${key}] run failed:`, err)
    } finally {
      running = false
    }
  }
  timers[key] = setInterval(tick, seconds * 1000)
  timers[key]?.unref?.()
}

/**
 * Background jobs that need no external cron, started from
 * `instrumentation.ts` next to the booking reminders (production only):
 *
 * - automations parked on a Wait step resume every minute
 *   (`/api/automations/cron` still works for an external pinger);
 * - stale open deals are closed as lost every hour, for pipelines that
 *   set `auto_lose_days`;
 * - the weekly owner summary goes to Telegram on Monday morning
 *   (checked every 15 minutes, deduped by `weekly_report_sent_at`).
 */
export function startServerSchedulers(getAdmin: () => SupabaseClient) {
  every('automations', 60, async () => {
    const processed = await drainPendingAutomations(getAdmin())
    if (processed > 0) console.log('[automations] resumed', processed)
  })
  every('deal-auto-lose', 60 * 60, async () => {
    const closed = await autoLoseStaleDeals(getAdmin())
    if (closed > 0) console.log('[deals/auto-lose] closed', closed)
  })
  every('weekly-summary', 15 * 60, async () => {
    const sent = await sendDueWeeklySummaries(getAdmin())
    if (sent > 0) console.log('[weekly-summary] sent', sent)
  })
}
