// ============================================================
// /api/super-admin/ai-platform  (super admin only)
//
// The platform AI key (migration 072): the super admin pays the AI and
// bills it inside the plan, so every account without its own key runs
// on this config. GET returns a masked status (never the key); PUT
// validates and saves it.
// ============================================================

import { NextResponse, after } from 'next/server'

import { requireSuperAdmin, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/super-admin/admin-client'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { checkChatKey, checkEmbeddingsKey } from '@/lib/ai/key-check'
import { clearPlatformAiCache } from '@/lib/ai/platform'
import { reindexKnowledge } from '@/lib/ai/knowledge'
import { findEmbeddingModel, DEFAULT_EMBEDDINGS_MODEL } from '@/lib/ai/models'
import type { AiProvider } from '@/lib/ai/types'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

function isMissingTable(code: string | undefined): boolean {
  return code === '42P01' || code === 'PGRST205'
}

function migrationPending() {
  return NextResponse.json(
    {
      error: 'Apply migration 072 in the Supabase SQL Editor first.',
      code: 'migration_pending',
    },
    { status: 409 },
  )
}

/** Last 4 characters, so the panel can tell which key is saved. */
function keyHint(encrypted: string | null): string | null {
  if (!encrypted) return null
  try {
    const plain = decrypt(encrypted)
    return plain.length > 8 ? plain.slice(-4) : null
  } catch {
    return null
  }
}

export async function GET() {
  try {
    await requireSuperAdmin()
    const { data, error } = await supabaseAdmin()
      .from('platform_ai_config')
      .select('provider, model, api_key, embeddings_api_key, embeddings_model, updated_at')
      .eq('id', true)
      .maybeSingle()
    if (error) {
      if (isMissingTable(error.code)) {
        return NextResponse.json({ configured: false, migration_pending: true })
      }
      console.error('[GET /api/super-admin/ai-platform] error:', error)
      return NextResponse.json({ error: 'Failed to load platform AI' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ configured: false, migration_pending: false })
    return NextResponse.json({
      configured: true,
      migration_pending: false,
      provider: data.provider,
      model: data.model,
      key_hint: keyHint(data.api_key),
      has_embeddings_key: !!data.embeddings_api_key,
      embeddings_key_hint: keyHint(data.embeddings_api_key),
      embeddings_model: data.embeddings_model,
      updated_at: data.updated_at,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const { userId } = await requireSuperAdmin()

    const limit = checkRateLimit(`ai-platform:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const provider = body.provider as AiProvider
    if (provider !== 'openai' && provider !== 'anthropic') {
      return bad('provider must be "openai" or "anthropic"')
    }
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) return bad('model is required')

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
    // Embeddings key: a string sets it, null clears it, absent keeps it.
    const rawEmbeddingsKey =
      typeof body.embeddings_api_key === 'string' ? body.embeddings_api_key.trim() : ''
    const clearEmbeddingsKey = body.embeddings_api_key === null
    const rawEmbeddingsModel =
      typeof body.embeddings_model === 'string' ? body.embeddings_model.trim() : ''
    if (rawEmbeddingsModel && !findEmbeddingModel(rawEmbeddingsModel)) {
      return bad('embeddings_model must be one of the supported embeddings models')
    }

    const admin = supabaseAdmin()
    const { data: existing, error: readErr } = await admin
      .from('platform_ai_config')
      .select('provider, model, api_key, embeddings_api_key, embeddings_model')
      .eq('id', true)
      .maybeSingle()
    if (readErr) {
      if (isMissingTable(readErr.code)) return migrationPending()
      console.error('[PUT /api/super-admin/ai-platform] read error:', readErr)
      return NextResponse.json({ error: 'Failed to save platform AI' }, { status: 500 })
    }

    let apiKeyPlain: string
    if (rawKey) {
      apiKeyPlain = rawKey
    } else if (existing?.api_key) {
      try {
        apiKeyPlain = decrypt(existing.api_key)
      } catch {
        return bad('Stored API key could not be decrypted — re-enter the key.')
      }
    } else {
      return bad('api_key is required')
    }

    const credentialsChanged =
      !existing || rawKey !== '' || provider !== existing.provider || model !== existing.model
    if (credentialsChanged) {
      const problem = await checkChatKey(provider, model, apiKeyPlain)
      if (problem) return bad(problem)
    }

    const embeddingsModel =
      rawEmbeddingsModel || existing?.embeddings_model || DEFAULT_EMBEDDINGS_MODEL
    if (rawEmbeddingsKey) {
      const problem = await checkEmbeddingsKey(rawEmbeddingsKey, embeddingsModel)
      if (problem) return bad(problem)
    }

    const row: Record<string, unknown> = {
      id: true,
      provider,
      model,
      api_key: rawKey ? encrypt(rawKey) : existing!.api_key,
      embeddings_model: embeddingsModel,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    }
    if (rawEmbeddingsKey) row.embeddings_api_key = encrypt(rawEmbeddingsKey)
    else if (clearEmbeddingsKey) row.embeddings_api_key = null
    else row.embeddings_api_key = existing?.embeddings_api_key ?? null

    const { error: upErr } = await admin.from('platform_ai_config').upsert(row)
    if (upErr) {
      if (isMissingTable(upErr.code)) return migrationPending()
      console.error('[PUT /api/super-admin/ai-platform] upsert error:', upErr)
      return NextResponse.json({ error: 'Failed to save platform AI' }, { status: 500 })
    }
    clearPlatformAiCache()

    // A new embeddings key or model leaves every account that relies on
    // the platform's embeddings with unusable vectors: re-embed them.
    const embeddingsChanged =
      !!rawEmbeddingsKey ||
      (!!existing && embeddingsModel !== (existing.embeddings_model || DEFAULT_EMBEDDINGS_MODEL))
    if (embeddingsChanged && !clearEmbeddingsKey) {
      let key = rawEmbeddingsKey
      if (!key && existing?.embeddings_api_key) {
        try {
          key = decrypt(existing.embeddings_api_key)
        } catch {
          key = ''
        }
      }
      if (key) after(() => reindexPlatformAccounts(key, embeddingsModel))
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** Re-embed the KB of every account without its own embeddings key. */
async function reindexPlatformAccounts(key: string, model: string): Promise<void> {
  const admin = supabaseAdmin()
  try {
    const { data: docs } = await admin
      .from('ai_knowledge_documents')
      .select('account_id')
    const accountIds = [...new Set((docs ?? []).map((d) => d.account_id as string))]
    if (accountIds.length === 0) return
    const { data: own } = await admin
      .from('ai_configs')
      .select('account_id')
      .in('account_id', accountIds)
      .not('embeddings_api_key', 'is', null)
    const skip = new Set((own ?? []).map((r) => r.account_id as string))
    for (const accountId of accountIds) {
      if (skip.has(accountId)) continue
      const result = await reindexKnowledge(admin, accountId, {
        embeddingsApiKey: key,
        embeddingsModel: model,
      })
      if (result.error) {
        console.error(
          `[ai-platform] reindex of ${accountId} stopped at ${result.reindexed}/${result.total}: ${result.error}`,
        )
      }
    }
  } catch (err) {
    console.error(
      '[ai-platform] knowledge reindex failed:',
      err instanceof Error ? err.message : err,
    )
  }
}
