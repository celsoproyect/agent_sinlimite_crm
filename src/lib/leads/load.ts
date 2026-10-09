// ============================================================
// Server loaders for the Leads page. Supabase caps a select at 1000
// rows, so every list is read page by page (like src/lib/reports/).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { isSyntheticPhone } from '@/lib/contacts/synthetic-phone'
import { stageKind } from '@/lib/deals/reasons'
import type { Deal, PipelineStage } from '@/types'
import type { LeadDeal, LeadSource, LeadsPayload, LeadStatus } from './opportunities'
import { isMissingTableError, type LeadFormSubmission } from './submissions'

const PAGE = 1000
const IN_CHUNK = 150

interface PgError {
  code?: string
  message?: string
}

async function paged<T>(
  run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: PgError | null }>,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await run(from, from + PAGE - 1)
    if (error) throw error
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) return out
  }
}

function chunks<T>(list: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** Every deal of the account with its contact, pipeline, stage and source. */
export async function loadLeadDeals(db: SupabaseClient, accountId: string): Promise<LeadsPayload> {
  const [pipelines, deals] = await Promise.all([
    paged<{ id: string; name: string }>((from, to) =>
      db
        .from('pipelines')
        .select('id, name')
        .eq('account_id', accountId)
        .order('created_at', { ascending: true })
        .range(from, to),
    ),
    paged<Deal>((from, to) =>
      db
        .from('deals')
        .select('*, contact:contacts(id, name, phone, email, company)')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to),
    ),
  ])

  const stages: PipelineStage[] = []
  for (const ids of chunks(pipelines.map((p) => p.id))) {
    const rows = await paged<PipelineStage>((from, to) =>
      db.from('pipeline_stages').select('*').in('pipeline_id', ids).order('position').range(from, to),
    )
    stages.push(...rows)
  }
  const stageById = new Map(stages.map((s) => [s.id, s]))

  const contactIds = [...new Set(deals.map((d) => d.contact_id).filter((id): id is string => !!id))]
  const sources = await loadSources(db, accountId, contactIds)

  const leadDeals: LeadDeal[] = deals.map((d) => {
    const stage = stageById.get(d.stage_id)
    const status: LeadStatus =
      d.status === 'won' || d.status === 'lost' || d.status === 'open'
        ? d.status
        : stage
          ? stageKind(stage)
          : 'open'
    const contact = d.contact
      ? { ...d.contact, phone: isSyntheticPhone(d.contact.phone) ? '' : d.contact.phone }
      : undefined
    return {
      ...d,
      contact,
      lead_status: status,
      source: d.contact_id ? (sources.get(d.contact_id) ?? null) : null,
    }
  })

  return { deals: leadDeals, pipelines, stages }
}

/** A contact's source: the channel of its first conversation, else
 *  'form' when the web form created it (migration 070). */
async function loadSources(
  db: SupabaseClient,
  accountId: string,
  contactIds: string[],
): Promise<Map<string, LeadSource>> {
  const map = new Map<string, LeadSource>()
  for (const ids of chunks(contactIds)) {
    const rows = await paged<{ contact_id: string | null; channel: string | null; created_at: string }>(
      (from, to) =>
        db
          .from('conversations')
          .select('contact_id, channel, created_at')
          .eq('account_id', accountId)
          .in('contact_id', ids)
          .order('created_at', { ascending: true })
          .range(from, to),
    )
    for (const r of rows) {
      if (r.contact_id && !map.has(r.contact_id)) {
        map.set(r.contact_id, r.channel === 'web' ? 'web' : 'whatsapp')
      }
    }
  }

  const missing = contactIds.filter((id) => !map.has(id))
  try {
    for (const ids of chunks(missing)) {
      const rows = await paged<{ contact_id: string | null }>((from, to) =>
        db
          .from('lead_form_submissions')
          .select('contact_id')
          .eq('account_id', accountId)
          .in('contact_id', ids)
          .range(from, to),
      )
      for (const r of rows) if (r.contact_id) map.set(r.contact_id, 'form')
    }
  } catch (err) {
    if (!isMissingTableError(err)) throw err
  }
  return map
}

/** Every form submission, newest first; `missing` before migration 070. */
export async function loadSubmissions(
  db: SupabaseClient,
  accountId: string,
): Promise<{ missing: boolean; submissions: LeadFormSubmission[] }> {
  try {
    const submissions = await paged<LeadFormSubmission>((from, to) =>
      db
        .from('lead_form_submissions')
        .select('*')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to),
    )
    return { missing: false, submissions }
  } catch (err) {
    if (isMissingTableError(err)) return { missing: true, submissions: [] }
    throw err
  }
}
