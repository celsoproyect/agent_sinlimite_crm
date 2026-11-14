-- 082: Instagram phases 3-5.
--   Phase 3 (modules `instagram_ai_comments`, `instagram_offers`):
--     * the AI classifies comments no keyword rule caught (question,
--       interest, praise, complaint, spam, other) and acts per category,
--     * each post can carry an offer (text, link, catalog item, file,
--       expiry) the DM agent knows about.
--   Phase 4 (module `instagram_engagement`):
--     * rules can also fire on story replies and DMs (`triggers`) and can
--       ask the customer to follow the account first (`require_follow`),
--     * story-mention thanks, ice breakers and the persistent menu live in
--       accounts.instagram_settings.
--   Phase 5 (module `instagram_reports` + the DM queue):
--     * dm_sent_at counts the private replies of the last hour, so a burst
--       of comments waits in the queue (dm_status 'queued') instead of
--       going over Meta's ~200 DMs per hour.
-- Idempotent: safe to run twice.

-- Accounts: one settings object for comments AI, stories, ice breakers,
-- menu and the hourly DM limit (normalized in src/lib/instagram/settings.ts).
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS instagram_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Posts: the offer of each post.
ALTER TABLE instagram_posts
  ADD COLUMN IF NOT EXISTS offer_text text,
  ADD COLUMN IF NOT EXISTS offer_link_url text,
  ADD COLUMN IF NOT EXISTS offer_catalog_item_id uuid REFERENCES ai_attachments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS offer_media_url text,
  ADD COLUMN IF NOT EXISTS offer_media_name text,
  ADD COLUMN IF NOT EXISTS offer_expires_on date,
  ADD COLUMN IF NOT EXISTS ai_comments_enabled boolean NOT NULL DEFAULT true;

-- Rules: where they fire and the follow gate.
ALTER TABLE instagram_keyword_rules
  ADD COLUMN IF NOT EXISTS triggers text[] NOT NULL DEFAULT '{comments}',
  ADD COLUMN IF NOT EXISTS require_follow boolean NOT NULL DEFAULT false;

-- Comment log: the AI's verdict, its queued private reply and when the DM went.
ALTER TABLE instagram_comments
  ADD COLUMN IF NOT EXISTS ai_category text,
  ADD COLUMN IF NOT EXISTS ai_private_reply text,
  ADD COLUMN IF NOT EXISTS dm_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'comment';

CREATE INDEX IF NOT EXISTS instagram_comments_dm_sent_idx
  ON instagram_comments (account_id, dm_sent_at DESC)
  WHERE dm_sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS instagram_comments_queued_idx
  ON instagram_comments (created_at)
  WHERE dm_status = 'queued';
CREATE INDEX IF NOT EXISTS instagram_comments_media_idx
  ON instagram_comments (account_id, media_id, created_at DESC);

-- In-app alert for a complaint in the comments.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'handoff_requested', 'plan_alert', 'instagram_comment'));
