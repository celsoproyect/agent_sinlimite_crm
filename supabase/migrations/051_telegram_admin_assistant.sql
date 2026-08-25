-- ============================================================
-- 051_telegram_admin_assistant.sql
--
-- Two additions to the Telegram channel (050), both scoped to the
-- account owner's already-verified chat (accounts.telegram_chat_id):
--
-- 1. `telegram_webhook_secret` — a random token set whenever the
--    owner (re)saves a bot token. Sent to Telegram as the
--    `secret_token` on `setWebhook` and checked against the
--    `X-Telegram-Bot-Api-Secret-Token` header on every inbound
--    webhook call, so a caller who merely guesses/knows an
--    `accountId` cannot forge updates.
--
-- 2. `telegram_admin_chat_enabled` + `telegram_admin_turns` — an
--    opt-in, read-only conversational assistant reachable only from
--    that same verified chat, for the account owner to ask about
--    system activity (bookings, new contacts, won deals,
--    conversations, follow-ups). Deliberately independent of the
--    lead-notification toggle (`telegram_notify_enabled`) — the owner
--    may want one without the other.
--
-- `telegram_admin_turns` is a dedicated history table, intentionally
-- NEVER `messages`/`conversations`: this is the concrete mechanism
-- that keeps the admin's own chat with the AI from ever being read,
-- summarized, or confused with a customer conversation. Service-role
-- only (no client policy), same pattern as
-- `automation_pending_executions` (006/017) — the webhook has no
-- `auth.uid()` and is the only writer/reader.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS telegram_admin_chat_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS telegram_webhook_secret TEXT;

CREATE TABLE IF NOT EXISTS telegram_admin_turns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_admin_turns_account
  ON telegram_admin_turns (account_id, created_at DESC);

ALTER TABLE telegram_admin_turns ENABLE ROW LEVEL SECURITY;
-- No SELECT/INSERT/UPDATE/DELETE policy for authenticated users — all
-- access is server-side via the service-role key (the webhook route).
