-- 083: Instagram campaign links and QR codes (module `instagram_links`).
--   * instagram_links: one row per link. Its public short URL
--     (<site>/go/<slug>) counts the click and sends the person to
--     ig.me/m/<account>?ref=<code>. When they open the chat, Meta passes
--     `ref` and the link's action runs: a welcome message, a keyword rule,
--     an automation or the AI with the link's context. It can also tag
--     the contact.
--   * instagram_link_events: clicks (`click`) and chats opened (`open`),
--     for the per-link results.
-- Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS instagram_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- The `ref` Meta passes back (letters, digits, _ and -; matched case-insensitively).
  code text NOT NULL,
  -- Globally unique short id for <site>/go/<slug>.
  slug text NOT NULL UNIQUE,
  action text NOT NULL DEFAULT 'message' CHECK (action IN ('message', 'ai', 'rule', 'automation')),
  welcome_text text,
  ai_context text,
  rule_id uuid REFERENCES instagram_keyword_rules(id) ON DELETE SET NULL,
  automation_id uuid REFERENCES automations(id) ON DELETE SET NULL,
  tag_id uuid REFERENCES tags(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  is_sample boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS instagram_links_code_idx ON instagram_links (account_id, lower(code));

CREATE TABLE IF NOT EXISTS instagram_link_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  link_id uuid NOT NULL REFERENCES instagram_links(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('click', 'open')),
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  igsid text,
  is_new_contact boolean NOT NULL DEFAULT false,
  -- The link's action already ran for this chat.
  replied boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS instagram_link_events_link_idx ON instagram_link_events (link_id, created_at DESC);
CREATE INDEX IF NOT EXISTS instagram_link_events_account_idx ON instagram_link_events (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS instagram_link_events_conv_idx ON instagram_link_events (conversation_id, created_at DESC);

ALTER TABLE instagram_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_link_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instagram_links_select ON instagram_links;
CREATE POLICY instagram_links_select ON instagram_links FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS instagram_links_insert ON instagram_links;
CREATE POLICY instagram_links_insert ON instagram_links FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS instagram_links_update ON instagram_links;
CREATE POLICY instagram_links_update ON instagram_links FOR UPDATE USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS instagram_links_delete ON instagram_links;
CREATE POLICY instagram_links_delete ON instagram_links FOR DELETE USING (is_account_member(account_id, 'admin'));

-- Events are written by the server (service role) only; members read them.
DROP POLICY IF EXISTS instagram_link_events_select ON instagram_link_events;
CREATE POLICY instagram_link_events_select ON instagram_link_events FOR SELECT USING (is_account_member(account_id));
