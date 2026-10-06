import type { SupabaseClient } from '@supabase/supabase-js'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events'
import type { StageKind } from '@/types'
import { isLostReason, LOST_REASONS, stageKind, type LostReason } from './reasons'

/**
 * Closing deals as won or lost, shared by the board (through
 * `/api/deals/[id]/status`), the AI's `set_lead_stage` capture and the
 * stale-deal auto-lose job.
 *
 * A closed deal leaves the board and shows up in the "Cerrados" list.
 * Winning tags the contact "Cliente"; both outcomes fire the
 * `deal_won` / `deal_lost` automation triggers, which is where
 * post-sale and win-back messages hang off.
 *
 * Columns from migration 063 (`pipeline_stages.kind`, `deals.closed_at`,
 * `lost_reason`, `close_note`) may not exist yet; every write retries
 * without them on 42703.
 */

export type { StageKind, LostReason }
export { isLostReason, LOST_REASONS, stageKind }
export type ClosedStatus = 'won' | 'lost'

/** Name of the tag a contact gets when one of their deals is won. */
export const CUSTOMER_TAG_NAME = 'Cliente'
const CUSTOMER_TAG_COLOR = '#22c55e'

export class DealCloseError extends Error {
  readonly status: number
  constructor(message: string, status = 500) {
    super(message)
    this.name = 'DealCloseError'
    this.status = status
  }
}

interface StageRow {
  id: string
  name: string
  position: number
  kind?: string | null
}

interface DealRow {
  id: string
  status: string | null
  pipeline_id: string
  stage_id: string
  contact_id: string | null
  conversation_id: string | null
  user_id: string
}

const isMissingColumn = (e: { code?: string } | null) => e?.code === '42703'

async function loadDeal(db: SupabaseClient, accountId: string, dealId: string): Promise<DealRow> {
  const { data, error } = await db
    .from('deals')
    .select('id, status, pipeline_id, stage_id, contact_id, conversation_id, user_id')
    .eq('id', dealId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new DealCloseError(error.message)
  if (!data) throw new DealCloseError('Deal not found', 404)
  return data as DealRow
}

async function loadStages(db: SupabaseClient, pipelineId: string): Promise<StageRow[]> {
  const { data, error } = await db
    .from('pipeline_stages')
    .select('*')
    .eq('pipeline_id', pipelineId)
    .order('position', { ascending: true })
  if (error) throw new DealCloseError(error.message)
  return (data ?? []) as StageRow[]
}

/** Update a deal, retrying without the migration-063 columns when they
 *  don't exist yet. Verifies a row was actually written. */
async function writeDeal(
  db: SupabaseClient,
  accountId: string,
  dealId: string,
  base: Record<string, unknown>,
  closing: Record<string, unknown>,
): Promise<void> {
  let res = await db
    .from('deals')
    .update({ ...base, ...closing })
    .eq('id', dealId)
    .eq('account_id', accountId)
    .select('id')
  if (isMissingColumn(res.error)) {
    res = await db.from('deals').update(base).eq('id', dealId).eq('account_id', accountId).select('id')
  }
  if (res.error) throw new DealCloseError(res.error.message)
  if (!res.data?.length) throw new DealCloseError('Deal not updated', 404)
}

export interface CloseDealInput {
  accountId: string
  dealId: string
  status: ClosedStatus
  lostReason?: LostReason | null
  note?: string | null
  /** Who closed it; used as the owner if the "Cliente" tag must be created. */
  actorUserId?: string | null
  /** Stage to land in instead of the pipeline's first won/lost-kind stage. */
  stageId?: string | null
}

export interface CloseDealResult {
  /** False when the deal already had that status (nothing fired). */
  changed: boolean
  stageId: string
}

/**
 * Close a deal as won or lost: set status, close date, reason and note,
 * and move it to the pipeline's won/lost column when there is one. On a
 * real change, tag the contact "Cliente" (won) and fire the deal_won /
 * deal_lost automations. `db` must be able to write tags and contact
 * tags for the account — callers pass the service-role client after
 * checking the caller may touch the deal.
 */
export async function closeDeal(db: SupabaseClient, input: CloseDealInput): Promise<CloseDealResult> {
  const deal = await loadDeal(db, input.accountId, input.dealId)
  if (deal.status === input.status) return { changed: false, stageId: deal.stage_id }

  const stages = await loadStages(db, deal.pipeline_id)
  const target =
    (input.stageId && stages.find((s) => s.id === input.stageId)) ||
    stages.find((s) => stageKind(s) === input.status)
  const stageId = target?.id ?? deal.stage_id

  const note = input.note?.trim() || null
  await writeDeal(
    db,
    input.accountId,
    deal.id,
    { status: input.status, stage_id: stageId },
    {
      closed_at: new Date().toISOString(),
      lost_reason: input.status === 'lost' ? (input.lostReason ?? 'other') : null,
      close_note: note,
    },
  )

  if (deal.contact_id) {
    const context = {
      ...(deal.conversation_id ? { conversation_id: deal.conversation_id } : {}),
      vars: {
        deal_id: deal.id,
        ...(input.status === 'lost' ? { lost_reason: input.lostReason ?? 'other' } : {}),
      },
    }
    if (input.status === 'won') {
      try {
        const tagId = await ensureCustomerTag(db, input.accountId, input.actorUserId || deal.user_id)
        if (tagId) {
          await addContactTagAndDispatch({
            db,
            accountId: input.accountId,
            contactId: deal.contact_id,
            tagId,
            context,
          })
        }
      } catch (err) {
        console.error('[deals] tagging the customer failed:', err)
      }
    }
    await runAutomationsForTrigger({
      accountId: input.accountId,
      triggerType: input.status === 'won' ? 'deal_won' : 'deal_lost',
      contactId: deal.contact_id,
      context,
    })
  }

  return { changed: true, stageId }
}

/**
 * Put a closed deal back on the board: status open, in the last open
 * column (the furthest it could have got before closing), with the close
 * date and reason cleared.
 */
export async function reopenDeal(
  db: SupabaseClient,
  input: { accountId: string; dealId: string },
): Promise<CloseDealResult> {
  const deal = await loadDeal(db, input.accountId, input.dealId)
  if (deal.status === 'open' || !deal.status) return { changed: false, stageId: deal.stage_id }

  const stages = await loadStages(db, deal.pipeline_id)
  const open = stages.filter((s) => stageKind(s) === 'open')
  const stageId = open[open.length - 1]?.id ?? deal.stage_id

  await writeDeal(
    db,
    input.accountId,
    deal.id,
    { status: 'open', stage_id: stageId },
    { closed_at: null, lost_reason: null, close_note: null },
  )
  return { changed: true, stageId }
}

/** The account's "Cliente" tag id, creating the tag when missing. */
async function ensureCustomerTag(
  db: SupabaseClient,
  accountId: string,
  ownerUserId: string,
): Promise<string | null> {
  const find = async () => {
    const { data } = await db
      .from('tags')
      .select('id')
      .eq('account_id', accountId)
      .ilike('name', CUSTOMER_TAG_NAME)
      .limit(1)
      .maybeSingle()
    return (data?.id as string | undefined) ?? null
  }
  const existing = await find()
  if (existing) return existing

  const { data, error } = await db
    .from('tags')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      name: CUSTOMER_TAG_NAME,
      color: CUSTOMER_TAG_COLOR,
    })
    .select('id')
    .maybeSingle()
  if (error) {
    // Lost a race with another close: use the tag that won.
    if (error.code === '23505') return find()
    throw new Error(error.message)
  }
  return (data?.id as string | undefined) ?? null
}
