-- 080: Instagram keyword rules v2.
--   * one rule for several posts/reels (media_ids; empty = every post),
--   * a file of its own (PDF or picture) sent after the button,
--   * an automation the rule starts (e.g. qualify the lead),
--   * example rules and automations (is_sample, "Quitar ejemplos").
-- Idempotent: safe to run twice.

ALTER TABLE instagram_keyword_rules
  ADD COLUMN IF NOT EXISTS media_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS dm_media_url text,
  ADD COLUMN IF NOT EXISTS dm_media_kind text,
  ADD COLUMN IF NOT EXISTS dm_media_name text,
  ADD COLUMN IF NOT EXISTS automation_id uuid REFERENCES automations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_sample boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'instagram_keyword_rules_dm_media_kind_check'
  ) THEN
    ALTER TABLE instagram_keyword_rules
      ADD CONSTRAINT instagram_keyword_rules_dm_media_kind_check
      CHECK (dm_media_kind IS NULL OR dm_media_kind IN ('image', 'document'));
  END IF;
END $$;

-- The single post of a 079 rule becomes its list.
UPDATE instagram_keyword_rules
   SET media_ids = ARRAY[media_id]
 WHERE media_id IS NOT NULL
   AND (media_ids IS NULL OR cardinality(media_ids) = 0);

CREATE INDEX IF NOT EXISTS idx_instagram_keyword_rules_media_ids
  ON instagram_keyword_rules USING gin (media_ids);

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS is_sample boolean NOT NULL DEFAULT false;
