// ============================================================
// /api/super-admin/accounts/[id]/ai  (super admin only)
//
// The super admin's view of one account's AI agent (Super admin →
// Cuentas → "Editar agente"):
//   GET   the agent settings, key source, usage and limit, plus the
//         account's members and pipelines for the pickers.
//   PATCH any of:
//         settings          — the same fields the owner saves in
//                             Configuración → Agente de IA
//         own_key           — { provider, model, api_key } gives the
//                             account its own key; null returns it to
//                             the platform key
//         own_embeddings_key — string sets it (with embeddings_model),
//                             null clears it
//         monthly_limit     — AI replies per month on the platform key,
//                             null = no limit
// Uses the service role, so it works across accounts.
// ============================================================

import { NextResponse, after } from 'next/server'

import { requireSuperAdmin, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/super-admin/admin-client'
import { encrypt } from '@/lib/whatsapp/encryption'
import {
  parseAgentSettings,
  saveAgentSettings,
  validateAgentRefs,
} from '@/lib/ai/agent-settings'
import { checkChatKey, checkEmbeddingsKey } from '@/lib/ai/key-check'
import { countAiRunsThisMonth, loadPlatformAiRow } from '@/lib/ai/platform'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { reindexKnowledge } from '@/lib/ai/knowledge'
import { findEmbeddingModel, DEFAULT_EMBEDDINGS_MODEL } from '@/lib/ai/models'
import type { AiProvider } from '@/lib/ai/types'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  try {
    await requireSuperAdmin()
    const { id } = await params
    const admin = supabaseAdmin()

    let accountRes = await admin
      .from('accounts')
      .select('id, name, ai_monthly_limit')
      .eq('id', id)
      .maybeSingle()
    if (accountRes.error?.code === '42703') {
      accountRes = await admin.from('accounts').select('id, name').eq('id', id).maybeSingle()
    }
    if (accountRes.error) {
      console.error('[GET /api/super-admin/accounts/:id/ai] account error:', accountRes.error)
      return NextResponse.json({ error: 'Failed to load account' }, { status: 500 })
    }
    if (!accountRes.data) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    const account = accountRes.data as { id: string; name: string; ai_monthly_limit?: number | null }

    const [{ data: cfg }, { data: members }, { data: pipelines }, platform, used] =
      await Promise.all([
        admin
          .from('ai_configs')
          .select(
            'provider, model, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, reply_delay_seconds, temperature, handoff_agent_id, handoff_on_missing_info, lead_pipeline_id, api_key, embeddings_api_key, embeddings_model',
          )
          .eq('account_id', id)
          .maybeSingle(),
        admin
          .from('profiles')
          .select('user_id, full_name, email')
          .eq('account_id', id)
          .order('created_at', { ascending: true }),
        admin
          .from('pipelines')
          .select('id, name')
          .eq('account_id', id)
          .order('created_at', { ascending: true }),
        loadPlatformAiRow(),
        countAiRunsThisMonth(admin, id),
      ])

    let config: Record<string, unknown> | null = null
    let keySource: 'own' | 'platform' | 'none' = platform ? 'platform' : 'none'
    if (cfg) {
      const { api_key, embeddings_api_key, ...safe } = cfg
      if (api_key) keySource = 'own'
      config = { ...safe, has_own_embeddings_key: !!embeddings_api_key }
    }

    return NextResponse.json({
      account: { id: account.id, name: account.name },
      config,
      key_source: keySource,
      platform_configured: !!platform,
      monthly_limit: account.ai_monthly_limit ?? null,
      monthly_used: used,
      members: (members ?? []).map((m) => ({
        user_id: m.user_id,
        label: m.full_name || m.email || m.user_id,
      })),
      pipelines: pipelines ?? [],
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { userId } = await requireSuperAdmin()
    const { id } = await params

    const limit = checkRateLimit(`sa-account-ai:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const admin = supabaseAdmin()
    const { data: account } = await admin.from('accounts').select('id').eq('id', id).maybeSingle()
    if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

    // 1. Agent settings (same rules as the owner's form).
    if (body.settings && typeof body.settings === 'object') {
      const settings = parseAgentSettings(body.settings as Record<string, unknown>)
      const refError = await validateAgentRefs(admin, id, settings)
      if (refError) return bad(refError)
      const result = await saveAgentSettings(admin, id, userId, settings)
      if (!result.ok) {
        return NextResponse.json(
          {
            error:
              result.code === 'migration_pending'
                ? 'Apply migration 072 in the Supabase SQL Editor first.'
                : 'Failed to save the agent',
            code: result.code,
          },
          { status: result.code === 'migration_pending' ? 409 : 500 },
        )
      }
    }

    // 2. Keys. They need the row; create it (agent off) when missing.
    const keyPatch: Record<string, unknown> = {}
    if ('own_key' in body) {
      if (body.own_key === null) {
        keyPatch.api_key = null
      } else if (body.own_key && typeof body.own_key === 'object') {
        const k = body.own_key as Record<string, unknown>
        const provider = k.provider as AiProvider
        if (provider !== 'openai' && provider !== 'anthropic') {
          return bad('provider must be "openai" or "anthropic"')
        }
        const model = typeof k.model === 'string' ? k.model.trim() : ''
        const apiKey = typeof k.api_key === 'string' ? k.api_key.trim() : ''
        if (!model) return bad('model is required')
        if (!apiKey) return bad('api_key is required')
        const problem = await checkChatKey(provider, model, apiKey)
        if (problem) return bad(problem)
        keyPatch.provider = provider
        keyPatch.model = model
        keyPatch.api_key = encrypt(apiKey)
      }
    }
    let reindex = false
    if ('own_embeddings_key' in body) {
      if (body.own_embeddings_key === null) {
        keyPatch.embeddings_api_key = null
        reindex = true
      } else if (typeof body.own_embeddings_key === 'string' && body.own_embeddings_key.trim()) {
        const model =
          typeof body.embeddings_model === 'string' && body.embeddings_model.trim()
            ? body.embeddings_model.trim()
            : DEFAULT_EMBEDDINGS_MODEL
        if (!findEmbeddingModel(model)) {
          return bad('embeddings_model must be one of the supported embeddings models')
        }
        const key = body.own_embeddings_key.trim()
        const problem = await checkEmbeddingsKey(key, model)
        if (problem) return bad(problem)
        keyPatch.embeddings_api_key = encrypt(key)
        keyPatch.embeddings_model = model
        reindex = true
      }
    }
    if (Object.keys(keyPatch).length > 0) {
      const { data: existing } = await admin
        .from('ai_configs')
        .select('id')
        .eq('account_id', id)
        .maybeSingle()
      if (!existing) {
        const created = await saveAgentSettings(admin, id, userId, parseAgentSettings({}))
        if (!created.ok) {
          return NextResponse.json(
            { error: 'Apply migration 072 in the Supabase SQL Editor first.', code: created.code },
            { status: 409 },
          )
        }
      }
      const { error } = await admin.from('ai_configs').update(keyPatch).eq('account_id', id)
      if (error) {
        console.error('[PATCH /api/super-admin/accounts/:id/ai] key error:', error)
        const pending = error.code === '23502'
        return NextResponse.json(
          {
            error: pending
              ? 'Apply migration 072 in the Supabase SQL Editor first.'
              : 'Failed to save the key',
          },
          { status: pending ? 409 : 500 },
        )
      }
    }

    // 3. Monthly limit.
    if ('monthly_limit' in body) {
      let monthlyLimit: number | null = null
      if (body.monthly_limit !== null && body.monthly_limit !== '') {
        const n = Number(body.monthly_limit)
        if (!Number.isFinite(n) || n < 0) return bad('monthly_limit must be 0 or more')
        monthlyLimit = Math.floor(n)
      }
      const { error } = await admin
        .from('accounts')
        .update({ ai_monthly_limit: monthlyLimit })
        .eq('id', id)
      if (error) {
        if (error.code === '42703') {
          return NextResponse.json(
            { error: 'Apply migration 072 in the Supabase SQL Editor first.', code: 'migration_pending' },
            { status: 409 },
          )
        }
        console.error('[PATCH /api/super-admin/accounts/:id/ai] limit error:', error)
        return NextResponse.json({ error: 'Failed to save the limit' }, { status: 500 })
      }
    }

    // A different embeddings key means different vectors: re-embed.
    if (reindex) {
      after(async () => {
        try {
          const { key, model } = await loadEmbeddingsKey(admin, id)
          if (!key) return
          await reindexKnowledge(admin, id, { embeddingsApiKey: key, embeddingsModel: model })
        } catch (err) {
          console.error(
            '[super-admin account ai] knowledge reindex failed:',
            err instanceof Error ? err.message : err,
          )
        }
      })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
