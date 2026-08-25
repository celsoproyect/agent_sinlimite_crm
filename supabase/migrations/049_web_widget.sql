-- ============================================================
-- 049_web_widget.sql
--
-- Adds a public, embeddable web-chat widget as a second inbound
-- channel alongside WhatsApp. A visitor on the client's own website
-- can talk to the account's AI agent without WhatsApp at all.
--
-- accounts.widget_key is the public-facing credential embedded in the
-- client's website JS (`<script data-widget-key="...">`). It is
-- deliberately NOT the same mechanism as `api_keys` (026): that table
-- authenticates a trusted machine caller with broad, admin-granted
-- scopes and stores only a hash, safe for a backend integration but
-- catastrophic to ship in public page source. `widget_key` is the
-- opposite shape on purpose — a plaintext, low-privilege value whose
-- only power is "post one message to this account's inbox and get an
-- AI reply back", authorized against the single public endpoint
-- `/api/widget/[widgetKey]/message`. Anyone can read it (it's in the
-- page source of the client's own site), so it must never gate
-- anything beyond that. `widget_enabled` is a separate explicit
-- on/off the account admin controls in Settings — the widget does
-- nothing just because a key exists.
--
-- `conversations.channel` distinguishes WhatsApp threads (the
-- default, preserving every existing row) from web-widget threads,
-- so the dashboard's outbound WhatsApp send path can refuse to try
-- delivering to a visitor who has no WhatsApp session (see the
-- application-layer check in /api/whatsapp/send).
--
-- Both new `accounts` columns are intentionally left at the existing
-- `accounts_update` RLS tier (admin+, migration 017) — unlike `name`
-- (041) and `enabled_modules` (048), a client's own admin toggling
-- their widget on/off or rotating a leaked key is exactly the kind of
-- self-service this feature is for, not a super-admin-only lever.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS widget_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS widget_key UUID NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_widget_key ON accounts (widget_key);

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp'
    CHECK (channel IN ('whatsapp', 'web'));
