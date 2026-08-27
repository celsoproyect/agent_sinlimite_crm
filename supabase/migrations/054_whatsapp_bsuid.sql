-- ============================================================
-- 054_whatsapp_bsuid
--
-- Meta rolled out Business-Scoped User IDs (BSUID) on the WhatsApp
-- Cloud API (2026-03-31): for a user who has enabled WhatsApp
-- usernames and hasn't interacted with the business in the last 30
-- days (and isn't in the Contact Book), inbound webhooks now omit
-- `from` / `wa_id` entirely — only an opaque, per-business `user_id`
-- (the BSUID) and `profile.username` are sent. Phone reappears once
-- either side messages again within the window, or never for
-- username-only users.
--
-- Until now `contacts.phone` was the sole identity key, so these
-- deliveries had no phone to dedupe or store against — every message
-- either got dropped (after the earlier empty-phone-guard fix) or,
-- before that, spawned a fresh duplicate contact/conversation per
-- message (issue: duplicate "Celso" contacts with phone = '').
--
-- This migration adds a purely additive identity column rather than
-- making `phone` nullable — `phone: string` is assumed non-null in
-- ~24 call sites across broadcasts, flows, CSV import/export, and
-- dashboard queries, so widening it would be a large, unrelated blast
-- radius. `whatsapp_user_id` is the new stable key for BSUID-only
-- contacts; `phone` stays NOT NULL (defaulting to '' as it already
-- effectively does) and is populated opportunistically whenever Meta
-- does send one.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_user_id TEXT;

-- Partial unique index — same shape as idx_contacts_account_phone_normalized
-- (migration 022): only enforced when the value is present, so it never
-- blocks the many existing contacts with no BSUID on record.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_whatsapp_user_id
  ON contacts (account_id, whatsapp_user_id)
  WHERE whatsapp_user_id IS NOT NULL;
