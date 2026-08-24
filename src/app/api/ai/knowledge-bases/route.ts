import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * GET /api/ai/knowledge-bases
 *
 * List the account's knowledge-base collections (any member).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('ai_knowledge_bases')
      .select('id, name, description, updated_at')
      .eq('account_id', accountId)
      .eq('is_faq', false)
      .order('name', { ascending: true })
    if (error) {
      console.error('[ai/knowledge-bases GET] error:', error)
      return NextResponse.json(
        { error: 'Failed to load knowledge bases' },
        { status: 500 },
      )
    }
    return NextResponse.json({ knowledgeBases: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/knowledge-bases  (admin+)
 *
 * Create a knowledge-base collection. `description` is surfaced to the
 * LLM (system-prompt roster) so it should say what's in the collection
 * and when to use it — required for that reason, not just cosmetics.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb-collection:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    const description =
      typeof body?.description === 'string' ? body.description.trim() : ''
    if (!name || !description) {
      return NextResponse.json(
        { error: 'name and description are required' },
        { status: 400 },
      )
    }

    const { data, error } = await supabase
      .from('ai_knowledge_bases')
      .insert({ account_id: accountId, created_by: userId, name, description })
      .select('id, name, description, updated_at')
      .single()
    if (error || !data) {
      console.error('[ai/knowledge-bases POST] insert error:', error)
      return NextResponse.json(
        { error: 'Failed to create knowledge base' },
        { status: 500 },
      )
    }
    return NextResponse.json({ knowledgeBase: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
