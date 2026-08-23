-- ============================================================
-- 042_ai_knowledge_metadata.sql
--
-- Adds a `metadata` jsonb column to ai_knowledge_documents so the
-- upload path (PDF/Word/Excel/CSV — src/lib/ai/extract-text.ts) can
-- record where a document came from: { source: 'upload' | 'text',
-- file_name, mime_ext, size_bytes }. Pasted documents (the original
-- flow) simply get { source: 'text' }.
--
-- No RLS/policy changes — ai_knowledge_documents' existing policies
-- (migration 030) already gate this column same as every other.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS ai_knowledge_documents_metadata_idx
  ON ai_knowledge_documents USING gin (metadata);
