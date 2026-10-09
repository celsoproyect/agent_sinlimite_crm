import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  requireSuperAdmin,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  parseAgentSettings,
  saveAgentSettings,
  validateAgentRefs,
} from '@/lib/ai/agent-settings'
import { loadAiQuota, loadPlatformAiConfig } from '@/lib/ai/platform'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * GET /api/ai/config
 *
 * Any member may read the config so the inbox/settings can reflect
 * whether AI is set up. Keys are NEVER returned — only where the key
 * comes from (`key_source`: the account's own key, the platform's, or
 * none) and the month's usage against the account's limit.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('ai_configs')
      // The keys are selected only to derive flags; they are stripped
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

    const platform = await loadPlatformAiConfig()
    const quota = await loadAiQuota(accountId)
    const common = {
      platform_configured: !!platform,
      monthly_limit: quota.limit,
      monthly_used: quota.used,
    }

    if (!data) {
      return NextResponse.json({
        configured: false,
        key_source: platform ? 'platform' : 'none',
        has_embeddings: !!platform?.embeddingsApiKey,
        ...common,
      })
    }
    const { api_key, embeddings_api_key, ...safe } = data
    const keySource = api_key ? 'own' : platform ? 'platform' : 'none'
    return NextResponse.json({
      configured: true,
      key_source: keySource,
      has_key: keySource !== 'none',
      has_embeddings_key: !!embeddings_api_key,
      has_embeddings: !!embeddings_api_key || !!platform?.embeddingsApiKey,
      ...safe,
      // The model actually answering: the platform's unless the account
      // has its own key.
      provider: keySource === 'platform' && platform ? platform.provider : safe.provider,
      model: keySource === 'platform' && platform ? platform.model : safe.model,
      ...common,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/config  (owner/admin)
 *
 * Saves the account's agent: prompt, switches, reply limits, handoff and
 * lead capture. Provider keys are not accepted here — the platform key
 * is the super admin's (/api/super-admin/ai-platform), and an account's
 * own key is set per account from /api/super-admin/accounts/[id]/ai.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`ai-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const settings = parseAgentSettings(body as Record<string, unknown>)
    const refError = await validateAgentRefs(supabase, accountId, settings)
    if (refError) return bad(refError)

    const result = await saveAgentSettings(supabase, accountId, userId, settings)
    if (!result.ok) {
      if (result.code === 'migration_pending') {
        return NextResponse.json(
          {
            error:
              'Could not save: apply migration 072 in the Supabase SQL Editor first.',
            code: 'migration_pending',
          },
          { status: 409 },
        )
      }
      return NextResponse.json(
        { error: 'Failed to save AI configuration' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/config  (super admin only)
 *
 * Removes the account's AI config (turns everything off and forgets any
 * own key). Also used to recover from a corrupted encrypted key.
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
