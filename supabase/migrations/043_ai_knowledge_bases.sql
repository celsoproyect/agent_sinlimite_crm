-- ============================================================
-- 043_ai_knowledge_bases.sql — split the knowledge base into named
-- collections (Legal, Sales, Support, ...) instead of one flat list.
--
-- Each collection has a name + description ("what's in here and when
-- to use it"). That description is surfaced to the LLM two ways:
--   - as a roster line in the system prompt (buildSystemPrompt), so
--     the model knows what each KB is for before it sees any content;
--   - as a tag on every retrieved chunk (via the updated match RPCs
--     below), so the model can attribute a specific excerpt to its
--     collection.
--
-- Documents move from "flat, one list per account" to "scoped to one
-- KB". ai_knowledge_documents is empty in production as of this
-- migration (the upload feature just shipped, nothing's been saved
-- yet), so the new FK column goes straight to NOT NULL — no backfill
-- needed. ai_knowledge_chunks gets the same column, denormalized off
-- the document like account_id already is, so the retrieval RPCs can
-- return + filter by it without an extra join per row.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_knowledge_bases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_knowledge_bases_account_id_idx
  ON ai_knowledge_bases (account_id);

-- Lets documents/chunks below FK on (id, account_id) together, so
-- Postgres itself rejects a document pointing at a KB from a *different*
-- account — not just app-level validation. Without this, a compromised
-- or buggy caller could tag account A's document with account B's
-- knowledge_base_id, and match_ai_knowledge_* would leak B's KB name to
-- A's chat (chunks are still filtered by chunk.account_id, but the join
-- to ai_knowledge_bases wouldn't be tenant-checked).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_knowledge_bases_id_account_id_key'
  ) THEN
    ALTER TABLE ai_knowledge_bases
      ADD CONSTRAINT ai_knowledge_bases_id_account_id_key UNIQUE (id, account_id);
  END IF;
END $$;

ALTER TABLE ai_knowledge_bases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_knowledge_bases_select ON ai_knowledge_bases;
CREATE POLICY ai_knowledge_bases_select ON ai_knowledge_bases FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS ai_knowledge_bases_insert ON ai_knowledge_bases;
CREATE POLICY ai_knowledge_bases_insert ON ai_knowledge_bases FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_knowledge_bases_update ON ai_knowledge_bases;
CREATE POLICY ai_knowledge_bases_update ON ai_knowledge_bases FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_knowledge_bases_delete ON ai_knowledge_bases;
CREATE POLICY ai_knowledge_bases_delete ON ai_knowledge_bases FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_ai_knowledge_bases_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_knowledge_bases_updated_at ON ai_knowledge_bases;
CREATE TRIGGER ai_knowledge_bases_updated_at
  BEFORE UPDATE ON ai_knowledge_bases
  FOR EACH ROW
  EXECUTE FUNCTION public.update_ai_knowledge_bases_updated_at();

-- ============================================================
-- Scope documents + chunks to a knowledge base.
-- ============================================================

ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS knowledge_base_id uuid;

ALTER TABLE ai_knowledge_documents
  ALTER COLUMN knowledge_base_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS ai_knowledge_documents_kb_id_idx
  ON ai_knowledge_documents (knowledge_base_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_knowledge_documents_kb_account_fkey'
  ) THEN
    ALTER TABLE ai_knowledge_documents
      ADD CONSTRAINT ai_knowledge_documents_kb_account_fkey
      FOREIGN KEY (knowledge_base_id, account_id)
      REFERENCES ai_knowledge_bases (id, account_id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE ai_knowledge_chunks
  ADD COLUMN IF NOT EXISTS knowledge_base_id uuid;

ALTER TABLE ai_knowledge_chunks
  ALTER COLUMN knowledge_base_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_kb_id_idx
  ON ai_knowledge_chunks (knowledge_base_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_knowledge_chunks_kb_account_fkey'
  ) THEN
    ALTER TABLE ai_knowledge_chunks
      ADD CONSTRAINT ai_knowledge_chunks_kb_account_fkey
      FOREIGN KEY (knowledge_base_id, account_id)
      REFERENCES ai_knowledge_bases (id, account_id) ON DELETE CASCADE;
  END IF;
END $$;

-- ============================================================
-- Retrieval RPCs — now also return which KB a chunk came from
-- (its name), so the caller can tag every excerpt for the model.
-- Return shape changed, so DROP first — CREATE OR REPLACE can't
-- change a function's RETURNS TABLE columns.
--
-- SECURITY INVOKER (unchanged from migration 032 /
-- GHSA-fg5p-2qc3-jmxr): the ai_knowledge_chunks_select RLS policy
-- still governs `authenticated` callers, so a foreign p_account_id
-- returns zero rows; service_role (the auto-reply bot) bypasses RLS
-- as before.
-- ============================================================

DROP FUNCTION IF EXISTS public.match_ai_knowledge_fts(uuid, text, integer);
CREATE FUNCTION public.match_ai_knowledge_fts(
  p_account_id  uuid,
  p_query       text,
  p_match_count integer
)
RETURNS TABLE (id uuid, content text, rank real, kb_name text) AS $$
  SELECT c.id,
         c.content,
         ts_rank(c.fts, plainto_tsquery('simple', p_query)) AS rank,
         kb.name AS kb_name
  FROM ai_knowledge_chunks c
  JOIN ai_knowledge_bases kb ON kb.id = c.knowledge_base_id
  WHERE c.account_id = p_account_id
    AND c.fts @@ plainto_tsquery('simple', p_query)
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

DROP FUNCTION IF EXISTS public.match_ai_knowledge_semantic(uuid, text, integer);
CREATE FUNCTION public.match_ai_knowledge_semantic(
  p_account_id      uuid,
  p_query_embedding text,
  p_match_count     integer
)
RETURNS TABLE (id uuid, content text, distance real, kb_name text) AS $$
  SELECT c.id,
         c.content,
         (c.embedding <=> p_query_embedding::vector(1536)) AS distance,
         kb.name AS kb_name
  FROM ai_knowledge_chunks c
  JOIN ai_knowledge_bases kb ON kb.id = c.knowledge_base_id
  WHERE c.account_id = p_account_id
    AND c.embedding IS NOT NULL
  ORDER BY c.embedding <=> p_query_embedding::vector(1536)
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer) TO authenticated, service_role;
