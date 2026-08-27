-- Meta sends `profile.username` alongside the BSUID for username-only
-- senders (see migration 054), but the webhook only ever read
-- `profile.name` — the username itself was discarded. That left the
-- Inbox with nothing but a blank phone row for these contacts. This adds
-- the missing column so the webhook can persist it and the UI can show it.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_username TEXT;
