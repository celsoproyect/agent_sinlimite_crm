-- ============================================================
-- 044_ai_agent_upgrades.sql — three independent additions to the AI
-- assistant, shipped together:
--
--   1. `ai_configs.embeddings_model` — which OpenAI embeddings model the
--      account uses (was hardcoded to text-embedding-3-small). The
--      settings UI now offers a curated model list; server-side
--      validation of the allow-list lives in the API route, not here —
--      this column just stores the choice.
--
--   2. Retrieval RPCs gain a document title (so the agent can attribute
--      an excerpt internally — the system prompt instructs it never to
--      surface this to the customer) and an optional
--      `p_knowledge_base_id` filter (so a single collection can be
--      searched directly — used by the new `search_knowledge_base` tool
--      the model can call mid-generation, on top of the existing
--      always-on cross-collection retrieval).
--
--   3. `ai_knowledge_bases.is_faq` — marks the one reserved "Preguntas
--      frecuentes" collection per account that the new FAQ feature
--      manages. FAQs are stored as ordinary documents in this
--      collection so they get chunking/embedding/retrieval for free;
--      the partial unique index keeps it to one such collection per
--      account, and the generic KB list/UI excludes it so admins only
--      manage FAQs through the dedicated FAQ UI.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS embeddings_model text NOT NULL DEFAULT 'text-embedding-3-small';

-- ============================================================
-- Retrieval RPCs: add doc_title + optional per-KB filter.
-- Return shape changed, so DROP first — CREATE OR REPLACE can't change
-- a function's RETURNS TABLE columns.
-- ============================================================

DROP FUNCTION IF EXISTS public.match_ai_knowledge_fts(uuid, text, integer);
CREATE FUNCTION public.match_ai_knowledge_fts(
  p_account_id         uuid,
  p_query              text,
  p_match_count        integer,
  p_knowledge_base_id  uuid DEFAULT NULL
)
RETURNS TABLE (id uuid, content text, rank real, kb_name text, doc_title text) AS $$
  SELECT c.id,
         c.content,
         ts_rank(c.fts, plainto_tsquery('simple', p_query)) AS rank,
         kb.name AS kb_name,
         d.title AS doc_title
  FROM ai_knowledge_chunks c
  JOIN ai_knowledge_bases kb ON kb.id = c.knowledge_base_id
  JOIN ai_knowledge_documents d ON d.id = c.document_id
  WHERE c.account_id = p_account_id
    AND c.fts @@ plainto_tsquery('simple', p_query)
    AND (p_knowledge_base_id IS NULL OR c.knowledge_base_id = p_knowledge_base_id)
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

DROP FUNCTION IF EXISTS public.match_ai_knowledge_semantic(uuid, text, integer);
CREATE FUNCTION public.match_ai_knowledge_semantic(
  p_account_id         uuid,
  p_query_embedding    text,
  p_match_count        integer,
  p_knowledge_base_id  uuid DEFAULT NULL
)
RETURNS TABLE (id uuid, content text, distance real, kb_name text, doc_title text) AS $$
  SELECT c.id,
         c.content,
         (c.embedding <=> p_query_embedding::vector(1536)) AS distance,
         kb.name AS kb_name,
         d.title AS doc_title
  FROM ai_knowledge_chunks c
  JOIN ai_knowledge_bases kb ON kb.id = c.knowledge_base_id
  JOIN ai_knowledge_documents d ON d.id = c.document_id
  WHERE c.account_id = p_account_id
    AND c.embedding IS NOT NULL
    AND (p_knowledge_base_id IS NULL OR c.knowledge_base_id = p_knowledge_base_id)
  ORDER BY c.embedding <=> p_query_embedding::vector(1536)
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer, uuid) TO authenticated, service_role;

-- ============================================================
-- Reserved FAQ collection.
-- ============================================================

ALTER TABLE ai_knowledge_bases
  ADD COLUMN IF NOT EXISTS is_faq boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'ai_knowledge_bases_one_faq_per_account'
  ) THEN
    CREATE UNIQUE INDEX ai_knowledge_bases_one_faq_per_account
      ON ai_knowledge_bases (account_id) WHERE is_faq;
  END IF;
END $$;
