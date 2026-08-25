-- ============================================================
-- 050_lead_form_and_telegram.sql
--
-- Adds a second public inbound channel — a lead-capture form
-- connector, meant for embedding on a client's own marketing site
-- (e.g. built in Lovable) — alongside the existing web-chat widget
-- (049). A form submission finds-or-creates a Contact by email,
-- stores the extra fields via the existing custom_fields /
-- contact_custom_values system, and opens a Deal in the account's
-- oldest pipeline so the lead shows up on the pipeline board with
-- zero extra setup.
--
-- accounts.lead_form_key mirrors accounts.widget_key exactly (see
-- 049's header for the full rationale) — a plaintext, low-privilege
-- public credential whose only power is "submit one lead form to
-- this account", authorized against the single public endpoint
-- `/api/leads/[leadFormKey]/submit`. It is a SEPARATE key from
-- widget_key (not reused) so either channel can be rotated or
-- disabled independently.
--
-- Telegram notification fields let the account owner get pinged
-- with the lead's details the moment a form is submitted. Telegram
-- was chosen over WhatsApp for this (explicit product decision)
-- because WhatsApp's Business API blocks free-form business-
-- initiated messages outside a 24h customer-service session, which
-- would make "notify me the instant a lead comes in" unreliable
-- without a pre-approved message template. A Telegram bot has no
-- such window: once the owner starts a chat with their own bot, the
-- bot can message that chat at any time.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS lead_form_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS lead_form_key UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS telegram_notify_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS telegram_bot_token TEXT,
  ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_lead_form_key ON accounts (lead_form_key);
