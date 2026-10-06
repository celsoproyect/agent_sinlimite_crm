import type { SupabaseClient } from '@supabase/supabase-js'
import { resumePendingExecution, type AutomationContext } from './engine'

/**
 * Resume due `automation_pending_executions` rows (automations parked
 * on a Wait step). Called by `/api/automations/cron` and by the
 * in-process scheduler started from `instrumentation.ts`.
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping runs don't double-process rows.
 */
export async function drainPendingAutomations(admin: SupabaseClient, limit = 50): Promise<number> {
  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(limit)

  if (error) throw new Error(error.message)
  if (!due || due.length === 0) return 0

  let processed = 0
  for (const row of due) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }
  return processed
}
