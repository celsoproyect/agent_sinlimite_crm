import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'

type Params = { params: Promise<{ id: string }> }

function buildFaqContent(question: string, answer: string): string {
  return `Pregunta: ${question}\nRespuesta: ${answer}`
}

/**
 * PATCH /api/ai/faqs/[id]  (admin+) — edit question/answer, re-index.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-faq:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = await request.json().catch(() => null)
    const question = typeof body?.question === 'string' ? body.question.trim() : ''
    const answer = typeof body?.answer === 'string' ? body.answer.trim() : ''
    if (!question || !answer) {
      return NextResponse.json(
        { error: 'question and answer are required' },
        { status: 400 },
      )
    }

    const content = buildFaqContent(question, answer)
    const { data: updated, error } = await supabase
      .from('ai_knowledge_documents')
      .update({ title: question, content })
      .eq('account_id', accountId)
      .eq('id', id)
      .select('id, knowledge_base_id')
      .maybeSingle()
    if (error) {
      console.error('[ai/faqs/[id] PATCH] error:', error)
      return NextResponse.json({ error: 'Failed to update FAQ' }, { status: 500 })
    }
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const { key: embeddingsApiKey, corrupt, model } = await loadEmbeddingsKey(
      supabase,
      accountId,
    )
    try {
      await ingestDocument(
        supabase,
        accountId,
        { embeddingsApiKey, embeddingsModel: model },
        id,
        updated.knowledge_base_id,
        content,
        'faq',
      )
    } catch (err) {
      const message = err instanceof AiError ? err.message : 'indexing failed'
      console.error('[ai/faqs/[id] PATCH] ingest error:', err)
      return NextResponse.json(
        {
          success: true,
          warning: `Updated, but semantic indexing failed (${message}). Lexical search still works.`,
        },
        { status: 200 },
      )
    }
    if (corrupt) {
      return NextResponse.json({
        success: true,
        warning:
          'Updated with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).',
      })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/faqs/[id]  (admin+) — chunks cascade via the FK.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const { error } = await supabase
      .from('ai_knowledge_documents')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id)
    if (error) {
      console.error('[ai/faqs/[id] DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to delete FAQ' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
