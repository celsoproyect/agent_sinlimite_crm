import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'
import {
  extractTextFromFile,
  resolveUploadExt,
  KB_UPLOAD_MAX_BYTES,
} from '@/lib/ai/extract-text'

// Route reads the whole upload into memory to hand a Buffer to the
// PDF/DOCX/XLSX parsers, which all need Node's `fs`/`Buffer` — the
// edge runtime has neither.
export const runtime = 'nodejs'

/**
 * POST /api/ai/knowledge/upload  (admin+)
 *
 * Accepts a PDF/Word/Excel/CSV/text file as multipart form data,
 * extracts its text, and ingests it exactly like a pasted document
 * (chunk + embed) — see /api/ai/knowledge POST. `metadata` records
 * where the document came from so the KB list can show its origin.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb-upload:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const form = await request.formData().catch(() => null)
    const file = form?.get('file')
    if (!form || !(file instanceof File)) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 })
    }

    const knowledgeBaseIdField = form.get('knowledge_base_id')
    const knowledgeBaseId =
      typeof knowledgeBaseIdField === 'string' ? knowledgeBaseIdField : ''
    if (!knowledgeBaseId) {
      return NextResponse.json(
        { error: 'knowledge_base_id is required' },
        { status: 400 },
      )
    }
    const { data: kb } = await supabase
      .from('ai_knowledge_bases')
      .select('id')
      .eq('account_id', accountId)
      .eq('id', knowledgeBaseId)
      .maybeSingle()
    if (!kb) {
      return NextResponse.json({ error: 'Knowledge base not found' }, { status: 404 })
    }

    if (file.size === 0) {
      return NextResponse.json({ error: 'The file is empty' }, { status: 400 })
    }
    if (file.size > KB_UPLOAD_MAX_BYTES) {
      return NextResponse.json(
        { error: `File is too large (max ${KB_UPLOAD_MAX_BYTES / (1024 * 1024)} MB)` },
        { status: 400 },
      )
    }

    const ext = resolveUploadExt(file.name)
    if (!ext) {
      return NextResponse.json(
        { error: 'Unsupported file type. Use PDF, Word (.docx), Excel (.xlsx), CSV, .txt or .md.' },
        { status: 400 },
      )
    }

    const titleField = form.get('title')
    const title =
      typeof titleField === 'string' && titleField.trim()
        ? titleField.trim()
        : file.name.replace(/\.[^.]+$/, '')

    const buffer = Buffer.from(await file.arrayBuffer())
    let content: string
    try {
      content = await extractTextFromFile(buffer, ext)
    } catch (err) {
      const message = err instanceof AiError ? err.message : 'Failed to read the file'
      return NextResponse.json({ error: message }, { status: 400 })
    }
    if (!content) {
      return NextResponse.json(
        { error: 'No text could be extracted from this file' },
        { status: 400 },
      )
    }

    const metadata = {
      source: 'upload',
      file_name: file.name,
      file_ext: ext,
      size_bytes: file.size,
    }

    const { data: doc, error } = await supabase
      .from('ai_knowledge_documents')
      .insert({
        account_id: accountId,
        created_by: userId,
        knowledge_base_id: knowledgeBaseId,
        title,
        content,
        metadata,
      })
      .select('id')
      .single()
    if (error || !doc) {
      console.error('[ai/knowledge/upload] insert error:', error)
      return NextResponse.json({ error: 'Failed to save document' }, { status: 500 })
    }

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(supabase, accountId)
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
      console.error('[ai/knowledge/upload] ingest error:', err)
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
