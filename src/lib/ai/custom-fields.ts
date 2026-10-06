import type { SupabaseClient } from '@supabase/supabase-js'
import type { LeadValue } from './types'
import { closeDeal, stageKind } from '@/lib/deals/close'
import type { StageKind } from '@/types'

// ============================================================
// Rosters the auto-reply agent needs to constrain its
// `set_custom_field`/`set_lead_stage` tool schemas to real, existing
// names — same idea and shape as `getAttachmentRoster` in attachments.ts.
// ============================================================

export interface CustomFieldRosterEntry {
  id: string
  field_name: string
}

/**
 * List the account's custom field names, for the system prompt roster and
 * to constrain the `set_custom_field` tool's `field` enum so the model
 * can never invent a field that doesn't exist. Best-effort: any failure
 * degrades to `[]`, same as the rest of this module's callers.
 */
export async function getCustomFieldRoster(
  db: SupabaseClient,
  accountId: string,
): Promise<CustomFieldRosterEntry[]> {
  try {
    const { data, error } = await db
      .from('custom_fields')
      .select('id, field_name')
      .eq('account_id', accountId)
      .order('field_name', { ascending: true })
    if (error || !data) return []
    return data as CustomFieldRosterEntry[]
  } catch (err) {
    console.error('[ai custom-fields] roster failed:', err)
    return []
  }
}

export interface LeadPipelineStage {
  id: string
  name: string
  /** `pipeline_stages.kind` (migration 063); absent before it runs. */
  kind?: StageKind
}

/**
 * List a pipeline's stages in board order, for the system prompt roster
 * and to constrain the `set_lead_stage` tool's `stage` enum. Best-effort:
 * any failure degrades to `[]`.
 */
export async function getLeadPipelineStages(
  db: SupabaseClient,
  pipelineId: string,
): Promise<LeadPipelineStage[]> {
  try {
    const { data, error } = await db
      .from('pipeline_stages')
      // `*` so `kind` comes along once migration 063 adds it.
      .select('*')
      .eq('pipeline_id', pipelineId)
      .order('position', { ascending: true })
    if (error || !data) return []
    return (data as LeadPipelineStage[]).map((s) => ({
      id: s.id,
      name: s.name,
      ...(s.kind ? { kind: s.kind } : {}),
    }))
  } catch (err) {
    console.error('[ai custom-fields] lead pipeline stages failed:', err)
    return []
  }
}

/**
 * Persist a `set_lead_stage` capture onto the account's `deals`: advance
 * the contact's open deal in the AI's lead pipeline, or open a new one.
 * Won/lost deals are history and are never reopened — a returning
 * customer gets a fresh deal. A won/lost target stage closes the deal
 * through `closeDeal`, so it leaves the board, gets its close date and
 * fires the deal automations like a close from the board would.
 * Best-effort: logs and returns on any failure, never throws into the
 * reply path.
 */
export async function applyLeadCapture(
  db: SupabaseClient,
  args: {
    accountId: string
    contactId: string
    conversationId: string
    ownerUserId: string
    pipelineId: string
    stageRoster: LeadPipelineStage[]
    stage: string
    /** Deal amount, when the model knew the price of what the customer
     *  wants; otherwise the deal keeps whatever value it already had. */
    value?: LeadValue
    /** Title for a new deal (the customer's name). */
    title: string
    /** Also retitle an existing deal — set when a real name was captured
     *  this turn, so a deal opened under a placeholder name gets fixed. */
    renameTitle?: boolean
  },
): Promise<void> {
  const stage = args.stageRoster.find((s) => s.name === args.stage)
  if (!stage) return
  const stageId = stage.id
  const kind = stageKind(stage)
  try {
    const { data: existingDeals } = await db
      .from('deals')
      .select('id, status')
      .eq('contact_id', args.contactId)
      .eq('pipeline_id', args.pipelineId)
      .order('created_at', { ascending: false })
    const primaryDeal = existingDeals?.find((d) => d.status === 'open')
    const valueFields = args.value
      ? { value: args.value.amount, ...(args.value.currency ? { currency: args.value.currency } : {}) }
      : {}
    // A closing stage is applied by closeDeal; until then the deal keeps
    // (or, when new, is opened in) an open column.
    const openStageId =
      kind === 'open'
        ? stageId
        : args.stageRoster.find((s) => stageKind(s) === 'open')?.id ?? stageId
    let dealId: string | undefined = primaryDeal?.id
    if (primaryDeal) {
      const { error } = await db
        .from('deals')
        .update({
          ...(kind === 'open' ? { stage_id: stageId } : {}),
          ...valueFields,
          ...(args.renameTitle ? { title: args.title } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('id', primaryDeal.id)
      if (error) console.error('[ai custom-fields] deal update failed:', error)
    } else {
      const { data, error } = await db
        .from('deals')
        .insert({
          user_id: args.ownerUserId,
          account_id: args.accountId,
          pipeline_id: args.pipelineId,
          stage_id: openStageId,
          contact_id: args.contactId,
          conversation_id: args.conversationId,
          title: args.title,
          value: 0,
          ...valueFields,
        })
        .select('id')
        .single()
      if (error) console.error('[ai custom-fields] deal insert failed:', error)
      dealId = (data as { id: string } | null)?.id
    }
    if (kind !== 'open' && dealId) {
      await closeDeal(db, {
        accountId: args.accountId,
        dealId,
        status: kind,
        stageId,
        actorUserId: args.ownerUserId,
        ...(kind === 'lost' ? { lostReason: 'other' as const } : {}),
      })
    }
  } catch (err) {
    console.error('[ai custom-fields] lead capture failed:', err)
  }
}
