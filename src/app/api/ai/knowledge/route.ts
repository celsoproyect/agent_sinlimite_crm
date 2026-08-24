import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'

/**
 * GET /api/ai/knowledge?knowledge_base_id=...
 *
 * List the account's documents in one knowledge base (any member).
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const knowledgeBaseId = new URL(request.url).searchParams.get(
      'knowledge_base_id',
    )
    if (!knowledgeBaseId) {
      return NextResponse.json(
        { error: 'knowledge_base_id is required' },
        { status: 400 },
      )
    }
    const { data, error } = await supabase
      .from('ai_knowledge_documents')
      .select('id, title, updated_at, metadata')
      .eq('account_id', accountId)
      .eq('knowledge_base_id', knowledgeBaseId)
      .order('updated_at', { ascending: false })
    if (error) {
      console.error('[ai/knowledge GET] error:', error)
      return NextResponse.json(
        { error: 'Failed to load knowledge base' },
        { status: 500 },
      )
    }
    return NextResponse.json({ documents: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/knowledge  (admin+)
 *
 * Create a document in a knowledge base, then chunk + (optionally) embed
 * it. If indexing fails the document is still saved so the admin can
 * retry via reindex.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    const content = typeof body?.content === 'string' ? body.content.trim() : ''
    const knowledgeBaseId =
      typeof body?.knowledge_base_id === 'string' ? body.knowledge_base_id : ''
    if (!title || !content || !knowledgeBaseId) {
      return NextResponse.json(
        { error: 'title, content, and knowledge_base_id are required' },
        { status: 400 },
      )
    }

    // Confirm the KB is actually this account's before tagging a
    // document with it — the DB's composite FK backstops this, but
    // checking here turns a cross-tenant mistake into a clean 404
    // instead of a raw constraint-violation 500.
    const { data: kb } = await supabase
      .from('ai_knowledge_bases')
      .select('id')
      .eq('account_id', accountId)
      .eq('id', knowledgeBaseId)
      .maybeSingle()
    if (!kb) {
      return NextResponse.json({ error: 'Knowledge base not found' }, { status: 404 })
    }

    const { data: doc, error } = await supabase
      .from('ai_knowledge_documents')
      .insert({
        account_id: accountId,
        created_by: userId,
        knowledge_base_id: knowledgeBaseId,
        title,
        content,
      })
      .select('id')
      .single()
    if (error || !doc) {
      console.error('[ai/knowledge POST] insert error:', error)
      return NextResponse.json(
        { error: 'Failed to save document' },
        { status: 500 },
      )
    }

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
      supabase,
      accountId,
    )
    try {
      await ingestDocument(
        supabase,
        accountId,
        { embeddingsApiKey },
        doc.id,
        knowledgeBaseId,
        content,
      )
    } catch (err) {
      const message = err instanceof AiError ? err.message : 'indexing failed'
      console.error('[ai/knowledge POST] ingest error:', err)
      return NextResponse.json(
        {
          success: true,
          id: doc.id,
          warning: `Saved, but semantic indexing failed (${message}). Lexical search still works; use Reindex to retry.`,
        },
        { status: 200 },
      )
    }

    if (corrupt) {
      return NextResponse.json({
        success: true,
        id: doc.id,
        warning:
          'Saved with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).',
      })
    }
    return NextResponse.json({ success: true, id: doc.id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
