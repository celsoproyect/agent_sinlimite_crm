import type { SupabaseClient } from '@supabase/supabase-js'
import { closeDeal } from './close'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Close open deals that have gone quiet as lost ("no_response"). Each
 * pipeline opts in with `pipelines.auto_lose_days` (migration 063; NULL
 * = off). A deal counts as quiet when neither the deal itself nor any of
 * its contact's conversations changed within that many days. Runs hourly
 * from the in-process scheduler (see `startServerSchedulers`).
 *
 * Returns how many deals were closed.
 */
export async function autoLoseStaleDeals(admin: SupabaseClient, now = Date.now()): Promise<number> {
  const { data: pipelines, error } = await admin
    .from('pipelines')
    .select('id, account_id, auto_lose_days')
    .not('auto_lose_days', 'is', null)
  if (error) {
    if (error.code === '42703') return 0 // migration 063 not applied yet
    throw new Error(error.message)
  }

  let closed = 0
  for (const p of pipelines ?? []) {
    const days = Number(p.auto_lose_days)
    if (!Number.isFinite(days) || days < 1) continue
    const cutoff = new Date(now - days * DAY_MS).toISOString()

    const { data: deals, error: dealsErr } = await admin
      .from('deals')
      .select('id, contact_id')
      .eq('pipeline_id', p.id)
      .eq('account_id', p.account_id)
      .eq('status', 'open')
      .lt('updated_at', cutoff)
      .limit(100)
    if (dealsErr) {
      console.error('[deals/auto-lose] loading deals failed:', dealsErr.message)
      continue
    }

    for (const deal of deals ?? []) {
      if (deal.contact_id) {
        const { data: recent } = await admin
          .from('conversations')
          .select('id')
          .eq('account_id', p.account_id)
          .eq('contact_id', deal.contact_id)
          .gte('last_message_at', cutoff)
          .limit(1)
        if (recent?.length) continue
      }
      try {
        const res = await closeDeal(admin, {
          accountId: p.account_id as string,
          dealId: deal.id as string,
          status: 'lost',
          lostReason: 'no_response',
          note: `Cerrado automáticamente tras ${days} días sin actividad`,
        })
        if (res.changed) closed++
      } catch (err) {
        console.error('[deals/auto-lose] closing deal failed:', deal.id, err)
      }
    }
  }
  return closed
}
