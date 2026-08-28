import type { SupabaseClient } from '@supabase/supabase-js'

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
