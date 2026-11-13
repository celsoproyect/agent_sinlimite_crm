-- 078: Instagram as a channel (module `instagram`, phase 1: DMs).
--
-- * instagram_connections: the Instagram professional account each CRM
--   account connected through "Instagram API with Instagram Login". The
--   long-lived token (60 days, refreshed by the server) is encrypted by
--   the app with the same key as the other API secrets. RLS on with no
--   policies: only the service role (server routes) reads or writes it.
--   `ig_user_id` is the id Meta puts in `entry.id` of every webhook, so
--   it is unique across the platform.
-- * conversations.channel also accepts 'instagram'.
-- * conversations.source: where the customer came from (a shared
--   post/reel, a story reply, an ad, a comment), kept for the agent and
--   the reports.
-- * contacts.instagram_id (IGSID, the Instagram-scoped id Meta sends as
--   `sender.id`) and instagram_username. Unique per account.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS instagram_connections (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  ig_user_id TEXT NOT NULL,
  username TEXT,
  name TEXT,
  profile_picture_url TEXT,
  access_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ,
  token_refreshed_at TIMESTAMPTZ,
  -- Owner switch: the AI agent answers Instagram DMs.
  ai_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  connected_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS instagram_connections_ig_user_idx
  ON instagram_connections (ig_user_id);

ALTER TABLE instagram_connections ENABLE ROW LEVEL SECURITY;

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_channel_check
  CHECK (channel IN ('whatsapp', 'web', 'instagram'));

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source JSONB;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS instagram_id TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS instagram_username TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS contacts_account_instagram_idx
  ON contacts (account_id, instagram_id)
  WHERE instagram_id IS NOT NULL;
