import type { SupabaseClient } from '@supabase/supabase-js'
import type { LeadValue } from './types'

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
      .select('id, name')
      .eq('pipeline_id', pipelineId)
      .order('position', { ascending: true })
    if (error || !data) return []
    return data as LeadPipelineStage[]
  } catch (err) {
    console.error('[ai custom-fields] lead pipeline stages failed:', err)
    return []
  }
}

/**
 * Persist a `set_lead_stage` capture onto the account's `deals`: advance
 * the contact's primary deal in the AI's lead pipeline, or open one.
 * Same "primary deal" selection as the contact sidebar — the most recent
 * open deal in this pipeline, falling back to the most recent deal
 * overall — so the AI advances an existing deal instead of creating a
 * duplicate. Best-effort: logs and returns on any failure, never throws
 * into the reply path.
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
  const stageId = args.stageRoster.find((s) => s.name === args.stage)?.id
  if (!stageId) return
  try {
    const { data: existingDeals } = await db
      .from('deals')
      .select('id, status')
      .eq('contact_id', args.contactId)
      .eq('pipeline_id', args.pipelineId)
      .order('created_at', { ascending: false })
    const primaryDeal = existingDeals?.find((d) => d.status === 'open') ?? existingDeals?.[0]
    const valueFields = args.value
      ? { value: args.value.amount, ...(args.value.currency ? { currency: args.value.currency } : {}) }
      : {}
    if (primaryDeal) {
      const { error } = await db
        .from('deals')
        .update({
          stage_id: stageId,
          ...valueFields,
          ...(args.renameTitle ? { title: args.title } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('id', primaryDeal.id)
      if (error) console.error('[ai custom-fields] deal update failed:', error)
    } else {
      const { error } = await db.from('deals').insert({
        user_id: args.ownerUserId,
        account_id: args.accountId,
        pipeline_id: args.pipelineId,
        stage_id: stageId,
        contact_id: args.contactId,
        conversation_id: args.conversationId,
        title: args.title,
        value: 0,
        ...valueFields,
      })
      if (error) console.error('[ai custom-fields] deal insert failed:', error)
    }
  } catch (err) {
    console.error('[ai custom-fields] lead capture failed:', err)
  }
}
