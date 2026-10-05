-- ============================================================
-- 061_light_mode_logo.sql
--
-- A second branding logo for light mode. `logo_url` keeps holding the
-- logo drawn for the dark theme (the app's default mode); when
-- `logo_light_url` is set, the app swaps to it while light mode is on.
-- NULL means "use logo_url in both modes".
-- ============================================================

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS logo_light_url text;
