-- 079: Instagram phase 2 — posts, keyword rules and the comment log
-- (module `instagram` + feature module `instagram_comments`).
--
-- * instagram_posts: the account's posts and reels, synced from Instagram
--   (/instagram → Publicaciones). `media_id` is Meta's id, the one comment
--   webhooks carry in `value.media.id`.
-- * instagram_keyword_rules: "comment PRICE on this reel → public reply +
--   private DM". `media_id` NULL = a general rule for every post. A post's
--   own rules win over the general ones. `match_any` fires on any comment
--   of that post. With `dm_button_label` the private reply is an opening
--   text plus a button; the content (`dm_text`, link, catalog item) goes
--   when the customer taps it or answers (the 24h window is then open).
-- * instagram_comments: one row per comment received, with what the
--   system did. The unique (account_id, comment_id) claims each comment
--   once, so a webhook redelivery never sends a second DM.
--
-- Members read everything; writes go through the server (admins).
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS instagram_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL,
  caption TEXT,
  media_type TEXT,
  media_product_type TEXT,
  permalink TEXT,
  media_url TEXT,
  thumbnail_url TEXT,
  posted_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS instagram_posts_account_media_idx
  ON instagram_posts (account_id, media_id);
CREATE INDEX IF NOT EXISTS instagram_posts_account_posted_idx
  ON instagram_posts (account_id, posted_at DESC);

CREATE TABLE IF NOT EXISTS instagram_keyword_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  media_id TEXT,
  name TEXT NOT NULL DEFAULT '',
  keywords TEXT[] NOT NULL DEFAULT '{}',
  match_any BOOLEAN NOT NULL DEFAULT FALSE,
  public_replies TEXT[] NOT NULL DEFAULT '{}',
  dm_opening TEXT,
  dm_button_label TEXT,
  dm_text TEXT NOT NULL DEFAULT '',
  dm_link_url TEXT,
  catalog_item_id UUID REFERENCES ai_attachments(id) ON DELETE SET NULL,
  tag_id UUID REFERENCES tags(id) ON DELETE SET NULL,
  once_per_user BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS instagram_keyword_rules_account_idx
  ON instagram_keyword_rules (account_id, media_id);

CREATE TABLE IF NOT EXISTS instagram_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  comment_id TEXT NOT NULL,
  media_id TEXT,
  parent_id TEXT,
  igsid TEXT,
  username TEXT,
  text TEXT,
  rule_id UUID REFERENCES instagram_keyword_rules(id) ON DELETE SET NULL,
  -- processing | replied | no_match | skipped | error
  status TEXT NOT NULL DEFAULT 'processing',
  public_reply_text TEXT,
  public_reply_id TEXT,
  -- NULL | sent | awaiting_tap | delivered | repeat | failed | manual
  dm_status TEXT,
  dm_error TEXT,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS instagram_comments_account_comment_idx
  ON instagram_comments (account_id, comment_id);
CREATE INDEX IF NOT EXISTS instagram_comments_account_created_idx
  ON instagram_comments (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS instagram_comments_pending_idx
  ON instagram_comments (account_id, igsid)
  WHERE dm_status = 'awaiting_tap';

ALTER TABLE instagram_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_keyword_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instagram_posts_select ON instagram_posts;
CREATE POLICY instagram_posts_select ON instagram_posts FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS instagram_keyword_rules_select ON instagram_keyword_rules;
CREATE POLICY instagram_keyword_rules_select ON instagram_keyword_rules FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS instagram_keyword_rules_insert ON instagram_keyword_rules;
CREATE POLICY instagram_keyword_rules_insert ON instagram_keyword_rules FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS instagram_keyword_rules_update ON instagram_keyword_rules;
CREATE POLICY instagram_keyword_rules_update ON instagram_keyword_rules FOR UPDATE USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS instagram_keyword_rules_delete ON instagram_keyword_rules;
CREATE POLICY instagram_keyword_rules_delete ON instagram_keyword_rules FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS instagram_comments_select ON instagram_comments;
CREATE POLICY instagram_comments_select ON instagram_comments FOR SELECT USING (is_account_member(account_id));
