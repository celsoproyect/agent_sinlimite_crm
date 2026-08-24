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

const FAQ_KB_NAME = 'Preguntas frecuentes'
const FAQ_KB_DESCRIPTION =
  'Preguntas y respuestas frecuentes definidas por el equipo. Úsala para responder consultas repetitivas de clientes.'

function buildFaqContent(question: string, answer: string): string {
  return `Pregunta: ${question}\nRespuesta: ${answer}`
}

function parseFaqAnswer(content: string, question: string): string {
  const prefix = `Pregunta: ${question}\nRespuesta: `
  return content.startsWith(prefix) ? content.slice(prefix.length) : content
}

/**
 * GET /api/ai/faqs
 *
 * List the account's FAQ entries (any member). Returns an empty list —
 * not an error — when the account has no FAQ collection yet; it's
 * created lazily by the first POST.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data: kb, error: kbError } = await supabase
      .from('ai_knowledge_bases')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_faq', true)
      .maybeSingle()
    if (kbError) {
      console.error('[ai/faqs GET] kb lookup error:', kbError)
      return NextResponse.json({ error: 'Failed to load FAQs' }, { status: 500 })
    }
    if (!kb) return NextResponse.json({ faqs: [] })

    const { data: docs, error } = await supabase
      .from('ai_knowledge_documents')
      .select('id, title, content, updated_at')
      .eq('account_id', accountId)
      .eq('knowledge_base_id', kb.id)
      .order('updated_at', { ascending: false })
    if (error) {
      console.error('[ai/faqs GET] documents error:', error)
      return NextResponse.json({ error: 'Failed to load FAQs' }, { status: 500 })
    }

    const faqs = (docs ?? []).map((d) => ({
      id: d.id,
      question: d.title,
      answer: parseFaqAnswer(d.content, d.title),
      updated_at: d.updated_at,
    }))
    return NextResponse.json({ faqs })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/faqs  (admin+)
 *
 * Add one FAQ entry. Reuses the knowledge-base system: get-or-create the
 * account's single reserved `is_faq` collection, then store the Q&A as
 * an ordinary document so it gets chunked/embedded/retrieved for free —
 * including via the `search_knowledge_base` tool and the always-on
 * cross-collection retrieval, same as any other knowledge document.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-faq:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const question = typeof body?.question === 'string' ? body.question.trim() : ''
    const answer = typeof body?.answer === 'string' ? body.answer.trim() : ''
    if (!question || !answer) {
      return NextResponse.json(
        { error: 'question and answer are required' },
        { status: 400 },
      )
    }

    let kbId: string
    const { data: existingKb, error: kbError } = await supabase
      .from('ai_knowledge_bases')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_faq', true)
      .maybeSingle()
    if (kbError) {
      console.error('[ai/faqs POST] kb lookup error:', kbError)
      return NextResponse.json({ error: 'Failed to save FAQ' }, { status: 500 })
    }
    if (existingKb) {
      kbId = existingKb.id
    } else {
      const { data: created, error: createError } = await supabase
        .from('ai_knowledge_bases')
        .insert({
          account_id: accountId,
          created_by: userId,
          name: FAQ_KB_NAME,
          description: FAQ_KB_DESCRIPTION,
          is_faq: true,
        })
        .select('id')
        .single()
      if (createError || !created) {
        console.error('[ai/faqs POST] kb create error:', createError)
        return NextResponse.json({ error: 'Failed to save FAQ' }, { status: 500 })
      }
      kbId = created.id
    }

    const content = buildFaqContent(question, answer)
    const { data: doc, error } = await supabase
      .from('ai_knowledge_documents')
      .insert({
        account_id: accountId,
        created_by: userId,
        knowledge_base_id: kbId,
        title: question,
        content,
        metadata: { source: 'faq', file_ext: 'faq' },
      })
      .select('id')
      .single()
    if (error || !doc) {
      console.error('[ai/faqs POST] insert error:', error)
      return NextResponse.json({ error: 'Failed to save FAQ' }, { status: 500 })
    }

    const { key: embeddingsApiKey, corrupt, model } = await loadEmbeddingsKey(
      supabase,
      accountId,
    )
    try {
      await ingestDocument(
        supabase,
        accountId,
        { embeddingsApiKey, embeddingsModel: model },
        doc.id,
        kbId,
        content,
        'faq',
      )
    } catch (err) {
      const message = err instanceof AiError ? err.message : 'indexing failed'
      console.error('[ai/faqs POST] ingest error:', err)
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
