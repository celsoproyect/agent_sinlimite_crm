-- Configurable handoff criteria: whether the bot hands off to a human
-- when it lacks the information to answer confidently. Defaults to the
-- previous (implicit) behaviour so existing accounts see no change until
-- they touch the new toggle.
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS handoff_on_missing_info boolean NOT NULL DEFAULT true;

-- Pipeline the AI files/advances leads into when it captures a Lead
-- Status update. Opt-in — the set_lead_stage tool is only exposed to the
-- model when this is set.
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS lead_pipeline_id uuid REFERENCES pipelines(id) ON DELETE SET NULL;

-- AI-authored notes have no human author, and need a way to be told
-- apart from human-written ones in the contact sidebar.
ALTER TABLE contact_notes
  ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE contact_notes
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'human'
    CHECK (source IN ('human', 'ai'));

-- AI-derived sentiment signal, surfaced in the contact sidebar.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS ai_sentiment text
    CHECK (ai_sentiment IN ('positive', 'neutral', 'negative'));
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS ai_sentiment_updated_at timestamptz;
