-- ============================================================
-- 060_widget_appearance.sql
--
-- Per-account look of the embeddable web widget (049): agent name,
-- subtitle, avatar and banner images, welcome text, quick questions,
-- disclaimer and brand color. Stored as one JSONB blob because the
-- widget reads it whole through the public
-- GET /api/widget/[widgetKey]/config endpoint, and the shape is
-- validated in code (src/lib/widget/config.ts), not in SQL.
--
-- Same RLS tier as widget_enabled / widget_key: `accounts_update`
-- (admin+, migration 017). Everything in here is public by design —
-- it's what the client's website visitors see.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS widget_config JSONB NOT NULL DEFAULT '{}'::jsonb;
