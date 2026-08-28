import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireSuperAdmin,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { validateAiCredentials } from '@/lib/ai/validate'
import { embedTexts } from '@/lib/ai/embeddings'
import { findEmbeddingModel, DEFAULT_EMBEDDINGS_MODEL } from '@/lib/ai/models'
import { AiError, type AiProvider } from '@/lib/ai/types'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * GET /api/ai/config
 *
 * Any member may read the config so the inbox/settings can reflect
 * whether AI is set up. The encrypted key is NEVER returned — only a
 * `has_key` flag; the settings form shows a masked placeholder.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('ai_configs')
      // `api_key` is selected only to derive `has_key` — it is stripped
      // out below and never returned to the client.
      .select(
        'provider, model, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, reply_delay_seconds, temperature, handoff_agent_id, handoff_on_missing_info, lead_pipeline_id, api_key, embeddings_api_key, embeddings_model',
      )
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[ai/config GET] fetch error:', error)
      return NextResponse.json(
        { error: 'Failed to load AI configuration' },
        { status: 500 },
      )
    }

    if (!data) return NextResponse.json({ configured: false })
    // The keys are selected only to derive the has_* flags; neither is
    // returned to the client.
    const { api_key, embeddings_api_key, ...safe } = data
    return NextResponse.json({
      configured: true,
      has_key: !!api_key,
      has_embeddings_key: !!embeddings_api_key,
      ...safe,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/config  (super admin only)
 *
 * Upsert the account's AI config. Validates the key with the provider
 * before persisting (mirrors the WhatsApp config verifying with Meta
 * first), then stores the key AES-256-GCM-encrypted. When `api_key` is
 * omitted the existing stored key is reused (the form sends it only
 * when the user re-enters it).
 *
 * Provider/API-key setup moved to /super-admin (migration 040/041) —
 * a client's own admin/owner can no longer reach this, enforced here
 * and at the RLS layer (ai_configs_insert/update/delete now require
 * is_super_admin, not just admin+).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireSuperAdmin()

    const limit = checkRateLimit(`ai-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const provider = body.provider as AiProvider
    if (provider !== 'openai' && provider !== 'anthropic') {
      return bad('provider must be "openai" or "anthropic"')
    }
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) return bad('model is required')

    const systemPrompt =
      typeof body.system_prompt === 'string' && body.system_prompt.trim()
        ? body.system_prompt.trim()
        : null
    const isActive = body.is_active === true
    const autoReplyEnabled = body.auto_reply_enabled === true

    // `null` = "sin límite" (migration 057); anything else clamps to the
    // existing 1-20 cap range, same as before.
    let maxPer: number | null
    if (body.auto_reply_max_per_conversation === null) {
      maxPer = null
    } else {
      let n = Number(body.auto_reply_max_per_conversation)
      if (!Number.isFinite(n)) n = 3
      maxPer = Math.min(20, Math.max(1, Math.floor(n)))
    }

    // WhatsApp-only reply delay, in seconds, measured from the bot's own
    // last reply (see lib/ai/auto-reply.ts). 0 = reply immediately.
    let replyDelaySeconds = Number(body.reply_delay_seconds)
    if (!Number.isFinite(replyDelaySeconds)) replyDelaySeconds = 0
    replyDelaySeconds = Math.min(300, Math.max(0, Math.floor(replyDelaySeconds)))

    // Sampling temperature threaded straight into the provider request
    // (lib/ai/providers/*.ts). Rounded to match the numeric(3,2) column.
    let temperature = Number(body.temperature)
    if (!Number.isFinite(temperature)) temperature = 0.7
    temperature = Math.round(Math.min(2, Math.max(0, temperature)) * 100) / 100

    // Handoff routing target for auto-reply. A non-empty string must be a
    // member of this account (else the conversation would be assigned to a
    // stranger); an empty string / null means "leave unassigned" (the
    // shared queue). Absent → left unchanged on update below.
    const rawHandoff =
      typeof body.handoff_agent_id === 'string' ? body.handoff_agent_id.trim() : ''
    const handoffProvided = 'handoff_agent_id' in body
    let handoffAgentId: string | null = null
    if (rawHandoff) {
      const { data: member } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('account_id', accountId)
        .eq('user_id', rawHandoff)
        .maybeSingle()
      if (!member) return bad('handoff_agent_id must be a member of this account')
      handoffAgentId = rawHandoff
    }

    // Whether the bot hands off when it lacks the information to answer
    // confidently (migration 058). Absent → left unchanged on update, or
    // defaults to the column default (true) on insert.
    const handoffOnMissingInfoProvided = 'handoff_on_missing_info' in body
    const handoffOnMissingInfo = body.handoff_on_missing_info !== false

    // Pipeline the AI files/advances leads into via the set_lead_stage
    // tool. A non-empty string must belong to this account; empty/null
    // means "no lead capture". Absent → left unchanged on update.
    const rawLeadPipeline =
      typeof body.lead_pipeline_id === 'string' ? body.lead_pipeline_id.trim() : ''
    const leadPipelineProvided = 'lead_pipeline_id' in body
    let leadPipelineId: string | null = null
    if (rawLeadPipeline) {
      const { data: pipeline } = await supabase
        .from('pipelines')
        .select('id')
        .eq('account_id', accountId)
        .eq('id', rawLeadPipeline)
        .maybeSingle()
      if (!pipeline) return bad('lead_pipeline_id must be a pipeline of this account')
      leadPipelineId = rawLeadPipeline
    }

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''

    // Embeddings key (optional, for semantic KB search): a non-empty
    // string sets/replaces it; an explicit null clears it; absent leaves
    // it unchanged. The form only sends it when the admin edits it.
    const rawEmbeddingsKey =
      typeof body.embeddings_api_key === 'string'
        ? body.embeddings_api_key.trim()
        : ''
    const clearEmbeddingsKey = body.embeddings_api_key === null

    // Embeddings model: allow-listed server-side (not just in the UI's
    // <Select>) because the column is a fixed `vector(1536)` — an
    // unvalidated id could resolve to the wrong width and break every
    // future embed for the account.
    const rawEmbeddingsModel =
      typeof body.embeddings_model === 'string' ? body.embeddings_model.trim() : ''
    if (rawEmbeddingsModel && !findEmbeddingModel(rawEmbeddingsModel)) {
      return bad('embeddings_model must be one of the supported embeddings models')
    }

    // Reuse the stored key when the form didn't send a fresh one.
    const { data: existing } = await supabase
      .from('ai_configs')
      .select('id, provider, model, api_key')
      .eq('account_id', accountId)
      .maybeSingle()

    let apiKeyPlain: string
    if (rawKey) {
      apiKeyPlain = rawKey
    } else if (existing?.api_key) {
      try {
        apiKeyPlain = decrypt(existing.api_key)
      } catch {
        return bad('Stored API key could not be decrypted — re-enter your key.')
      }
    } else {
      return bad('api_key is required')
    }

    // Only spend a provider round-trip when the credentials that affect
    // reachability actually changed. A save that just flips a toggle or
    // edits the system prompt on an existing, already-validated config
    // skips the call — no wasted token/latency on the account's key.
    const credentialsChanged =
      !existing ||
      rawKey !== '' ||
      provider !== existing.provider ||
      model !== existing.model

    if (credentialsChanged) {
      try {
        await validateAiCredentials({
          provider,
          model,
          apiKey: apiKeyPlain,
          systemPrompt,
          isActive,
          autoReplyEnabled,
          autoReplyMaxPerConversation: maxPer,
          replyDelaySeconds,
          temperature,
          handoffAgentId: null,
          handoffOnMissingInfo: true,
          leadPipelineId: null,
          embeddingsApiKey: null,
          embeddingsModel: rawEmbeddingsModel || DEFAULT_EMBEDDINGS_MODEL,
        })
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: err.message, code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] validation error:', err)
        return bad('Could not validate the API key with the provider.')
      }
    }

    // Validate a new embeddings key before storing (a cheap 1-input
    // embed), same "verify before save" discipline as the chat key.
    if (rawEmbeddingsKey) {
      try {
        await embedTexts(rawEmbeddingsKey, ['ping'])
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: `Embeddings key: ${err.message}`, code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] embeddings validation error:', err)
        return bad('Could not validate the embeddings key.')
      }
    }

    const encryptedKey = rawKey ? encrypt(rawKey) : null
    const shared: Record<string, unknown> = {
      provider,
      model,
      system_prompt: systemPrompt,
      is_active: isActive,
      auto_reply_enabled: autoReplyEnabled,
      auto_reply_max_per_conversation: maxPer,
      reply_delay_seconds: replyDelaySeconds,
      temperature,
    }
    // Only touch the handoff target when the form actually sent the field,
    // so a partial save (e.g. flipping a toggle) doesn't wipe it.
    if (handoffProvided) shared.handoff_agent_id = handoffAgentId
    if (handoffOnMissingInfoProvided) shared.handoff_on_missing_info = handoffOnMissingInfo
    if (leadPipelineProvided) shared.lead_pipeline_id = leadPipelineId
    if (rawEmbeddingsKey) {
      shared.embeddings_api_key = encrypt(rawEmbeddingsKey)
    } else if (clearEmbeddingsKey) {
      shared.embeddings_api_key = null
    }
    if (rawEmbeddingsModel) shared.embeddings_model = rawEmbeddingsModel

    if (existing) {
      const { error: upErr } = await supabase
        .from('ai_configs')
        .update(encryptedKey ? { ...shared, api_key: encryptedKey } : shared)
        .eq('account_id', accountId)
      if (upErr) {
        console.error('[ai/config POST] update error:', upErr)
        return NextResponse.json(
          { error: 'Failed to save AI configuration' },
          { status: 500 },
        )
      }
    } else {
      const { error: insErr } = await supabase.from('ai_configs').insert({
        account_id: accountId,
        created_by: userId,
        api_key: encryptedKey, // guaranteed non-null: rawKey required when no existing row
        ...shared,
      })
      if (insErr) {
        console.error('[ai/config POST] insert error:', insErr)
        return NextResponse.json(
          { error: 'Failed to save AI configuration' },
          { status: 500 },
        )
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/config  (super admin only)
 *
 * Removes the account's AI config (turns everything off and forgets the
 * key). Also used to recover from a corrupted encrypted key.
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireSuperAdmin()
    const { error } = await supabase
      .from('ai_configs')
      .delete()
      .eq('account_id', accountId)
    if (error) {
      console.error('[ai/config DELETE] error:', error)
      return NextResponse.json(
        { error: 'Failed to delete AI configuration' },
        { status: 500 },
      )
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
