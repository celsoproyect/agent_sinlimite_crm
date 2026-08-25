-- ============================================================
-- 047_attachment_pricing.sql — price/currency on the attachment catalog
-- (src/lib/ai/attachments.ts), so the send_attachment tool can hand the
-- model a full product/service card (name + description + price +
-- currency + image) instead of just a name.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_attachments ADD COLUMN IF NOT EXISTS price numeric(12, 2);
ALTER TABLE ai_attachments ADD COLUMN IF NOT EXISTS currency text;

ALTER TABLE ai_attachments
  DROP CONSTRAINT IF EXISTS ai_attachments_price_check;
ALTER TABLE ai_attachments
  ADD CONSTRAINT ai_attachments_price_check CHECK (price IS NULL OR price >= 0);
