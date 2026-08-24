-- ============================================================
-- 045_ai_multimodal.sql — catalog table backing the agent's new
-- send_attachment tool (src/lib/ai/attachments.ts).
--
-- This is deliberately NOT an extension of the knowledge-base system
-- (ai_knowledge_bases/documents/chunks): attachments are a short list
-- of files with a name + description used for a simple ILIKE lookup,
-- not content that needs chunking/embeddings. See the multimodal plan
-- for the full design (deferred send: the tool only resolves a match
-- during the AI loop, the actual WhatsApp send happens afterwards,
-- only from auto-reply).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  kind        text NOT NULL CHECK (kind IN ('image', 'document')),
  media_url   text NOT NULL,
  filename    text NOT NULL,
  mime_type   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_attachments_account_id_idx
  ON ai_attachments (account_id);

-- Trigram index so ILIKE '%term%' over name/description stays fast even
-- as the catalog grows; small catalogs don't strictly need this, but it's
-- cheap and avoids a future migration.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS ai_attachments_name_trgm_idx
  ON ai_attachments USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS ai_attachments_description_trgm_idx
  ON ai_attachments USING gin (description gin_trgm_ops);

ALTER TABLE ai_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_attachments_select ON ai_attachments;
CREATE POLICY ai_attachments_select ON ai_attachments FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS ai_attachments_insert ON ai_attachments;
CREATE POLICY ai_attachments_insert ON ai_attachments FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_attachments_update ON ai_attachments;
CREATE POLICY ai_attachments_update ON ai_attachments FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_attachments_delete ON ai_attachments;
CREATE POLICY ai_attachments_delete ON ai_attachments FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_ai_attachments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_attachments_updated_at ON ai_attachments;
CREATE TRIGGER ai_attachments_updated_at
  BEFORE UPDATE ON ai_attachments
  FOR EACH ROW
  EXECUTE FUNCTION public.update_ai_attachments_updated_at();
