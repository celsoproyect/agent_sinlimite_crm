import { NextResponse } from 'next/server'
import { requireSuperAdmin, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt } from '@/lib/whatsapp/encryption'
import { validateAiCredentials } from '@/lib/ai/validate'
import { DEFAULT_EMBEDDINGS_MODEL } from '@/lib/ai/models'
import { loadPlatformAiRow } from '@/lib/ai/platform'
import { AiError, type AiProvider } from '@/lib/ai/types'

/**
 * POST /api/ai/test  (super admin only)
 *
 * "Test key" button of the platform AI panel: validate a candidate
 * provider/model/key against the provider WITHOUT saving. When `api_key`
 * is omitted the stored platform key is used, so the model can be
 * re-tested after changing it. Returns `{ ok: true }` on success, 400
 * with the provider's message on failure.
 */
export async function POST(request: Request) {
  try {
    const { userId } = await requireSuperAdmin()

    const limit = checkRateLimit(`ai-test:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const provider = body.provider as AiProvider
    if (provider !== 'openai' && provider !== 'anthropic') {
      return NextResponse.json(
        { error: 'provider must be "openai" or "anthropic"' },
        { status: 400 },
      )
    }
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) {
      return NextResponse.json({ error: 'model is required' }, { status: 400 })
    }

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
    let apiKeyPlain = rawKey
    if (!apiKeyPlain) {
      const stored = await loadPlatformAiRow()
      if (!stored?.api_key) {
        return NextResponse.json(
          { error: 'Enter an API key to test.' },
          { status: 400 },
        )
      }
      try {
        apiKeyPlain = decrypt(stored.api_key)
      } catch {
        return NextResponse.json(
          { error: 'Stored API key could not be decrypted — re-enter your key.' },
          { status: 400 },
        )
      }
    }

    try {
      await validateAiCredentials({
        provider,
        model,
        apiKey: apiKeyPlain,
        systemPrompt: null,
        isActive: true,
        autoReplyEnabled: false,
        autoReplyMaxPerConversation: 3,
        replyDelaySeconds: 0,
        temperature: 0.7,
        handoffAgentId: null,
        handoffOnMissingInfo: true,
        leadPipelineId: null,
        embeddingsApiKey: null,
        embeddingsModel: DEFAULT_EMBEDDINGS_MODEL,
      })
    } catch (err) {
      if (err instanceof AiError) {
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: 400 },
        )
      }
      console.error('[ai/test] validation error:', err)
      return NextResponse.json(
        { error: 'Could not validate the API key.' },
        { status: 400 },
      )
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
