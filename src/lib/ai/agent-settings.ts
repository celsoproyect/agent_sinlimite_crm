import type { SupabaseClient } from '@supabase/supabase-js'
import { AI_PROVIDER_DEFAULT_MODEL } from './defaults'
import { loadPlatformAiRow } from './platform'

// ============================================================
// The account-owned half of the AI agent (migration 072): prompt,
// switches, reply limits, handoff and lead capture. Saved by the
// account's owner/admin in Configuración → Agente de IA, or by a super
// admin for any account from Super admin → Cuentas. Provider keys are
// NOT part of this — they belong to the platform (or, per account, to
// the super admin).
// ============================================================

export interface AgentSettings {
  system_prompt: string | null
  is_active: boolean
  auto_reply_enabled: boolean
  auto_reply_max_per_conversation: number | null
  reply_delay_seconds: number
  temperature: number
  /** Absent = leave unchanged. '' / null = shared queue. */
  handoff_agent_id?: string | null
  /** Absent = leave unchanged. */
  handoff_on_missing_info?: boolean
  /** Absent = leave unchanged. '' / null = no lead capture. */
  lead_pipeline_id?: string | null
}

/** Normalize a request body into the columns we store. Pure. */
export function parseAgentSettings(body: Record<string, unknown>): AgentSettings {
  const systemPrompt =
    typeof body.system_prompt === 'string' && body.system_prompt.trim()
      ? body.system_prompt.trim()
      : null

  // `null` = "sin límite" (migration 057); anything else clamps to 1-20.
  let maxPer: number | null
  if (body.auto_reply_max_per_conversation === null) {
    maxPer = null
  } else {
    let n = Number(body.auto_reply_max_per_conversation)
    if (!Number.isFinite(n)) n = 3
    maxPer = Math.min(20, Math.max(1, Math.floor(n)))
  }

  // WhatsApp-only reply delay, measured from the bot's own last reply.
  let replyDelaySeconds = Number(body.reply_delay_seconds)
  if (!Number.isFinite(replyDelaySeconds)) replyDelaySeconds = 0
  replyDelaySeconds = Math.min(300, Math.max(0, Math.floor(replyDelaySeconds)))

  // Rounded to match the numeric(3,2) column.
  let temperature = Number(body.temperature)
  if (!Number.isFinite(temperature)) temperature = 0.7
  temperature = Math.round(Math.min(2, Math.max(0, temperature)) * 100) / 100

  const settings: AgentSettings = {
    system_prompt: systemPrompt,
    is_active: body.is_active === true,
    auto_reply_enabled: body.auto_reply_enabled === true,
    auto_reply_max_per_conversation: maxPer,
    reply_delay_seconds: replyDelaySeconds,
    temperature,
  }
  if ('handoff_agent_id' in body) {
    settings.handoff_agent_id =
      typeof body.handoff_agent_id === 'string' && body.handoff_agent_id.trim()
        ? body.handoff_agent_id.trim()
        : null
  }
  if ('handoff_on_missing_info' in body) {
    settings.handoff_on_missing_info = body.handoff_on_missing_info !== false
  }
  if ('lead_pipeline_id' in body) {
    settings.lead_pipeline_id =
      typeof body.lead_pipeline_id === 'string' && body.lead_pipeline_id.trim()
        ? body.lead_pipeline_id.trim()
        : null
  }
  return settings
}

/**
 * The handoff target must be a member of the account and the lead
 * pipeline one of its pipelines. Returns an error message, or null.
 */
export async function validateAgentRefs(
  db: SupabaseClient,
  accountId: string,
  settings: AgentSettings,
): Promise<string | null> {
  if (settings.handoff_agent_id) {
    const { data: member } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId)
      .eq('user_id', settings.handoff_agent_id)
      .maybeSingle()
    if (!member) return 'handoff_agent_id must be a member of this account'
  }
  if (settings.lead_pipeline_id) {
    const { data: pipeline } = await db
      .from('pipelines')
      .select('id')
      .eq('account_id', accountId)
      .eq('id', settings.lead_pipeline_id)
      .maybeSingle()
    if (!pipeline) return 'lead_pipeline_id must be a pipeline of this account'
  }
  return null
}

export type SaveAgentResult =
  | { ok: true }
  | { ok: false; code: 'migration_pending' | 'save_failed' }

/**
 * Insert or update the account's `ai_configs` row with these settings.
 * A new row starts on the platform key (api_key NULL), with the
 * platform's provider/model recorded for reference.
 *
 * Before migration 072 an admin's write is filtered by RLS (0 rows, no
 * error) or rejected by the NOT NULL key, so both surface as
 * `migration_pending` instead of a silent "saved".
 */
export async function saveAgentSettings(
  db: SupabaseClient,
  accountId: string,
  userId: string | null,
  settings: AgentSettings,
): Promise<SaveAgentResult> {
  const { data: existing, error: readErr } = await db
    .from('ai_configs')
    .select('id')
    .eq('account_id', accountId)
    .maybeSingle()
  if (readErr) {
    console.error('[agent settings] read error:', readErr)
    return { ok: false, code: 'save_failed' }
  }

  if (existing) {
    const { data, error } = await db
      .from('ai_configs')
      .update(settings)
      .eq('account_id', accountId)
      .select('id')
    if (error) {
      console.error('[agent settings] update error:', error)
      return { ok: false, code: error.code === '42501' ? 'migration_pending' : 'save_failed' }
    }
    if (!data || data.length === 0) return { ok: false, code: 'migration_pending' }
    return { ok: true }
  }

  const platform = await loadPlatformAiRow()
  const { data, error } = await db
    .from('ai_configs')
    .insert({
      account_id: accountId,
      created_by: userId,
      provider: platform?.provider ?? 'openai',
      model: platform?.model ?? AI_PROVIDER_DEFAULT_MODEL.openai,
      api_key: null,
      ...settings,
    })
    .select('id')
  if (error) {
    console.error('[agent settings] insert error:', error)
    const pending = error.code === '23502' || error.code === '42501'
    return { ok: false, code: pending ? 'migration_pending' : 'save_failed' }
  }
  if (!data || data.length === 0) return { ok: false, code: 'migration_pending' }
  return { ok: true }
}
