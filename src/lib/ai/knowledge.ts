import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from './types'
import { chunkText, DEFAULT_OVERLAP_CHARS } from './chunk'
import { embedTexts, toVectorLiteral, EMBEDDING_MODEL } from './embeddings'

// Row-oriented formats: each row is already an atomic retrieval unit,
// and stitching the tail of one row onto the next would glue unrelated
// records together instead of preserving prose context. Overlap is
// opt-out for these, on for everything else (pasted text, PDF, Word,
// txt/md). 'faq' covers the FAQ feature's Q&A documents — each one is
// also a single atomic record.
const NO_OVERLAP_EXTS = new Set(['csv', 'xlsx', 'faq'])

/** Embeddings config every ingest/retrieval call needs. `embeddingsModel`
 *  is optional so existing callers/tests that only pass a key keep
 *  working — it defaults to the account default model. */
type EmbeddingsConfig = Pick<AiConfig, 'embeddingsApiKey'> & {
  embeddingsModel?: string
}

// ============================================================
// Knowledge base: ingest (chunk + optionally embed) and hybrid
// retrieve (semantic when an embeddings key is present, topped up with
// lexical full-text search).
// ============================================================

interface MatchRow {
  id: string
  content: string
  kb_name: string
  doc_title: string | null
}

/** One retrieved excerpt, tagged with the collection + source document
 *  title so the model can attribute/weigh it correctly (see
 *  buildSystemPrompt) — the title is for the model's internal use only;
 *  the prompt instructs it never to surface it to the customer. */
export interface KnowledgeExcerpt {
  content: string
  kbName: string
  title: string | null
}

/** A knowledge-base collection's name + description, for the system-
 *  prompt roster (buildSystemPrompt) — tells the model what each
 *  collection is for before it sees any retrieved content. */
export interface KnowledgeBaseSummary {
  name: string
  description: string
}

/**
 * List the account's knowledge-base collections for the system-prompt
 * roster. Best-effort like retrieveKnowledge: any failure degrades to
 * an empty roster rather than throwing into the draft / auto-reply path.
 */
export async function getKnowledgeBaseRoster(
  db: SupabaseClient,
  accountId: string,
): Promise<KnowledgeBaseSummary[]> {
  try {
    const { data, error } = await db
      .from('ai_knowledge_bases')
      .select('name, description')
      .eq('account_id', accountId)
      .order('name', { ascending: true })
    if (error || !data) return []
    return data as KnowledgeBaseSummary[]
  } catch (err) {
    console.error('[ai knowledge] roster fetch failed:', err)
    return []
  }
}

/**
 * (Re)build the chunks for one document. Deletes the document's
 * existing chunks, re-chunks the content, and — when the account has an
 * embeddings key — embeds each chunk. Runs under whatever client the
 * caller passes (service-role for ingest routes).
 *
 * Throws on embedding failure so the ingest route can report it; the
 * chunks are only written once embedding (if attempted) succeeds, so a
 * failed embed never leaves half-indexed rows.
 */
export async function ingestDocument(
  db: SupabaseClient,
  accountId: string,
  config: EmbeddingsConfig,
  documentId: string,
  knowledgeBaseId: string,
  content: string,
  sourceExt?: string | null,
): Promise<void> {
  const overlapChars = sourceExt && NO_OVERLAP_EXTS.has(sourceExt) ? 0 : DEFAULT_OVERLAP_CHARS
  const chunks = chunkText(content, { overlapChars })

  // Replace, don't append — re-ingest must be idempotent.
  const { error: delErr } = await db
    .from('ai_knowledge_chunks')
    .delete()
    .eq('document_id', documentId)
  if (delErr) throw delErr

  if (chunks.length === 0) return

  // Embed if a key is set, but DON'T let an embedding failure stop the
  // chunks from being stored: a failed embed must still leave the
  // document searchable lexically. We record the error and rethrow it
  // AFTER inserting (embedding-less) rows, so the route can warn
  // "semantic indexing failed" — which is now truthful, because lexical
  // search really does still work.
  let embeddings: number[][] | null = null
  let embedError: unknown = null
  if (config.embeddingsApiKey) {
    try {
      embeddings = await embedTexts(
        config.embeddingsApiKey,
        chunks,
        config.embeddingsModel ?? EMBEDDING_MODEL,
      )
    } catch (err) {
      embedError = err
    }
  }

  const rows = chunks.map((content, i) => ({
    document_id: documentId,
    account_id: accountId,
    knowledge_base_id: knowledgeBaseId,
    chunk_index: i,
    content,
    embedding: embeddings ? toVectorLiteral(embeddings[i]) : null,
  }))

  const { error: insErr } = await db.from('ai_knowledge_chunks').insert(rows)
  if (insErr) throw insErr

  if (embedError) throw embedError
}

/**
 * Retrieve up to `k` knowledge excerpts relevant to `queryText`.
 *
 * Semantic-primary when an embeddings key is configured (embed the
 * query → cosine-nearest chunks), then topped up with lexical full-text
 * matches to fill `k`. Lexical-only when there's no key. Best-effort:
 * any failure (no KB, embedding error, RPC error) degrades to fewer or
 * zero results and never throws into the draft / auto-reply path.
 */
export async function retrieveKnowledge(
  db: SupabaseClient,
  accountId: string,
  config: EmbeddingsConfig,
  queryText: string,
  k = 5,
): Promise<KnowledgeExcerpt[]> {
  const query = queryText.trim()
  if (!query || k <= 0) return []

  // Skip everything when the account has no knowledge base — otherwise
  // every draft / auto-reply would pay for a query embedding + two RPCs
  // just to get []. One cheap indexed COUNT (head, no rows) instead of a
  // paid embeddings call on the hot path.
  try {
    const { count, error } = await db
      .from('ai_knowledge_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
    if (error || !count) return []
  } catch {
    return []
  }

  const picked = new Map<string, KnowledgeExcerpt>() // id → excerpt, preserves order

  // Semantic path.
  if (config.embeddingsApiKey) {
    try {
      const [queryEmbedding] = await embedTexts(
        config.embeddingsApiKey,
        [query],
        config.embeddingsModel ?? EMBEDDING_MODEL,
      )
      if (queryEmbedding) {
        const { data, error } = await db.rpc('match_ai_knowledge_semantic', {
          p_account_id: accountId,
          p_query_embedding: toVectorLiteral(queryEmbedding),
          p_match_count: k,
        })
        if (!error && Array.isArray(data)) {
          for (const row of data as MatchRow[])
            picked.set(row.id, { content: row.content, kbName: row.kb_name, title: row.doc_title })
        }
      }
    } catch (err) {
      console.error('[ai knowledge] semantic retrieval failed, falling back to FTS:', err)
    }
  }

  // Lexical top-up (also the sole path when there's no embeddings key).
  if (picked.size < k) {
    try {
      const { data, error } = await db.rpc('match_ai_knowledge_fts', {
        p_account_id: accountId,
        p_query: query,
        p_match_count: k,
      })
      if (!error && Array.isArray(data)) {
        for (const row of data as MatchRow[]) {
          if (picked.size >= k) break
          if (!picked.has(row.id))
            picked.set(row.id, { content: row.content, kbName: row.kb_name, title: row.doc_title })
        }
      }
    } catch (err) {
      console.error('[ai knowledge] lexical retrieval failed:', err)
    }
  }

  return Array.from(picked.values()).slice(0, k)
}

/**
 * Retrieve up to `k` excerpts from a single knowledge base, identified by
 * name (case-insensitive) or id — used by the `search_knowledge_base` tool
 * so the model can target a specific collection instead of the automatic
 * cross-KB retrieval. Best-effort like `retrieveKnowledge`: any failure
 * (unknown name, embedding error, RPC error) degrades to `[]` rather than
 * throwing into the draft / auto-reply path.
 */
export async function retrieveKnowledgeFromKb(
  db: SupabaseClient,
  accountId: string,
  config: EmbeddingsConfig,
  queryText: string,
  kbNameOrId: string,
  k = 5,
): Promise<KnowledgeExcerpt[]> {
  const query = queryText.trim()
  if (!query || k <= 0 || !kbNameOrId) return []

  let knowledgeBaseId = kbNameOrId
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(kbNameOrId)
  if (!isUuid) {
    try {
      const { data, error } = await db
        .from('ai_knowledge_bases')
        .select('id')
        .eq('account_id', accountId)
        .ilike('name', kbNameOrId)
        .maybeSingle()
      if (error || !data) return []
      knowledgeBaseId = data.id as string
    } catch (err) {
      console.error('[ai knowledge] KB name lookup failed:', err)
      return []
    }
  }

  const picked = new Map<string, KnowledgeExcerpt>()

  if (config.embeddingsApiKey) {
    try {
      const [queryEmbedding] = await embedTexts(
        config.embeddingsApiKey,
        [query],
        config.embeddingsModel ?? EMBEDDING_MODEL,
      )
      if (queryEmbedding) {
        const { data, error } = await db.rpc('match_ai_knowledge_semantic', {
          p_account_id: accountId,
          p_query_embedding: toVectorLiteral(queryEmbedding),
          p_match_count: k,
          p_knowledge_base_id: knowledgeBaseId,
        })
        if (!error && Array.isArray(data)) {
          for (const row of data as MatchRow[])
            picked.set(row.id, { content: row.content, kbName: row.kb_name, title: row.doc_title })
        }
      }
    } catch (err) {
      console.error('[ai knowledge] targeted semantic retrieval failed, falling back to FTS:', err)
    }
  }

  if (picked.size < k) {
    try {
      const { data, error } = await db.rpc('match_ai_knowledge_fts', {
        p_account_id: accountId,
        p_query: query,
        p_match_count: k,
        p_knowledge_base_id: knowledgeBaseId,
      })
      if (!error && Array.isArray(data)) {
        for (const row of data as MatchRow[]) {
          if (picked.size >= k) break
          if (!picked.has(row.id))
            picked.set(row.id, { content: row.content, kbName: row.kb_name, title: row.doc_title })
        }
      }
    } catch (err) {
      console.error('[ai knowledge] targeted lexical retrieval failed:', err)
    }
  }

  return Array.from(picked.values()).slice(0, k)
}
