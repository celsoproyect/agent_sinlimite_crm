-- ============================================================
-- 040_super_admin_branding.sql
--
-- Adds a platform-level "super admin" flag and a singleton
-- `platform_settings` row so the operator running a given
-- deployment (one install per client, per docs/docker.md) can
-- rebrand the instance (company name + logo) from inside the app
-- instead of editing code and redeploying.
--
-- `is_super_admin` is deliberately NOT self-service. It is
-- orthogonal to `account_role` (owner/admin/agent/viewer, migration
-- 017) — a client's account owner must never be able to reach the
-- branding/account-name/AI-provider-key panels this flag unlocks.
-- It is granted by running, once per deployment, as the project
-- owner in the Supabase SQL editor:
--
--   UPDATE profiles SET is_super_admin = true WHERE user_id = '<your auth.users id>';
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_super_admin boolean NOT NULL DEFAULT false;

-- Extend the privilege-column guard from migration 034 so
-- `is_super_admin` gets the same protection as `account_role` /
-- `account_id`: the `authenticated` role (any browser client,
-- including the super admin's own) can never flip it via
-- PostgREST. Only a direct SQL statement run as the table owner
-- (postgres) or service_role can.
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.is_super_admin IS DISTINCT FROM OLD.is_super_admin)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account_role, account_id and is_super_admin cannot be changed directly; use the account member/invitation RPCs or, for is_super_admin, a direct SQL statement'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_profile_privilege_columns() OWNER TO postgres;

-- ============================================================
-- platform_settings — singleton row holding this deployment's
-- branding. Publicly readable (the login screen renders it before
-- anyone is authenticated); writable only by a super admin.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.platform_settings (
  id boolean PRIMARY KEY DEFAULT true,
  company_name text NOT NULL DEFAULT 'wacrm',
  logo_url text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_settings_singleton CHECK (id)
);

INSERT INTO public.platform_settings (id, company_name, logo_url)
VALUES (true, 'Sin Limite IA', '/logo.png')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "platform_settings_public_read" ON public.platform_settings;
CREATE POLICY "platform_settings_public_read"
  ON public.platform_settings FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "platform_settings_super_admin_write" ON public.platform_settings;
CREATE POLICY "platform_settings_super_admin_write"
  ON public.platform_settings FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.user_id = auth.uid() AND profiles.is_super_admin
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.user_id = auth.uid() AND profiles.is_super_admin
    )
  );

-- ============================================================
-- `branding` Storage bucket — holds the uploaded logo. Mirrors the
-- `avatars` bucket pattern (migration 008): public read so <img>
-- tags work without signed URLs, writes restricted to super admins.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'branding',
  'branding',
  TRUE,
  5242880, -- 5 MB
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Branding assets are publicly readable" ON storage.objects;
CREATE POLICY "Branding assets are publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'branding');

DROP POLICY IF EXISTS "Super admins can upload branding assets" ON storage.objects;
CREATE POLICY "Super admins can upload branding assets"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'branding'
    AND EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.user_id = auth.uid() AND profiles.is_super_admin
    )
  );

DROP POLICY IF EXISTS "Super admins can update branding assets" ON storage.objects;
CREATE POLICY "Super admins can update branding assets"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'branding'
    AND EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.user_id = auth.uid() AND profiles.is_super_admin
    )
  );

DROP POLICY IF EXISTS "Super admins can delete branding assets" ON storage.objects;
CREATE POLICY "Super admins can delete branding assets"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'branding'
    AND EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.user_id = auth.uid() AND profiles.is_super_admin
    )
  );

-- ============================================================
-- Manual validation (run against a live instance):
--
--   1. As a non-super-admin JWT via PostgREST, this must return
--      42501 (insufficient_privilege):
--        PATCH /rest/v1/profiles?user_id=eq.<self> { "is_super_admin": true }
--   2. As a non-super-admin, this must return 0 rows updated
--      (RLS silently filters, no error):
--        PATCH /rest/v1/platform_settings?id=eq.true { "company_name": "x" }
--   3. After `UPDATE profiles SET is_super_admin = true ...` run
--      directly in the SQL editor, the same PATCH from (2) as that
--      user must succeed.
-- ============================================================
