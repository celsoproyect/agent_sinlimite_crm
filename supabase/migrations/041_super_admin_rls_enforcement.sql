-- ============================================================
-- 041_super_admin_rls_enforcement.sql
--
-- Migration 040 introduced `is_super_admin` and enforced it with
-- real RLS for platform_settings + the branding bucket. Two other
-- surfaces moved into /super-admin (account rename, AI provider
-- config) were only gated in the Next.js route handlers via
-- `requireRole('admin')` — any account admin/owner could still
-- reach them directly through PostgREST (curl, devtools), since
-- the underlying RLS policies never required more than 'admin'.
-- This migration closes that gap at the database layer, matching
-- the "RLS is the real backstop" pattern already used everywhere
-- else in this schema.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- accounts.name — column-level guard, not a blanket RLS change.
--
-- accounts_update (017) is intentionally left at admin+ because
-- other columns (e.g. default_currency, 021) are legitimately
-- admin-editable. `name` alone becomes super-admin-only, via the
-- same trigger-based column guard pattern as
-- enforce_profile_privilege_columns (034/040).
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_account_name_super_admin_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name
     AND current_user = 'authenticated'
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles
       WHERE profiles.user_id = auth.uid() AND profiles.is_super_admin
     )
  THEN
    RAISE EXCEPTION
      'accounts.name can only be changed by a super admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_account_name_super_admin_only() OWNER TO postgres;

DROP TRIGGER IF EXISTS accounts_name_super_admin_guard ON public.accounts;
CREATE TRIGGER accounts_name_super_admin_guard
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_account_name_super_admin_only();

-- ------------------------------------------------------------
-- ai_configs — provider/API key setup. Unlike accounts.name,
-- every column here (provider, model, api_key, system_prompt,
-- auto-reply toggles, ...) belongs exclusively to the /super-admin
-- "Agente IA" panel now, so tightening the whole write policy
-- (rather than a single column) is correct.
-- ------------------------------------------------------------

DROP POLICY IF EXISTS ai_configs_insert ON public.ai_configs;
CREATE POLICY ai_configs_insert ON public.ai_configs FOR INSERT
  WITH CHECK (
    is_account_member(account_id)
    AND EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.user_id = auth.uid() AND profiles.is_super_admin
    )
  );

DROP POLICY IF EXISTS ai_configs_update ON public.ai_configs;
CREATE POLICY ai_configs_update ON public.ai_configs FOR UPDATE
  USING (
    is_account_member(account_id)
    AND EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.user_id = auth.uid() AND profiles.is_super_admin
    )
  );

DROP POLICY IF EXISTS ai_configs_delete ON public.ai_configs;
CREATE POLICY ai_configs_delete ON public.ai_configs FOR DELETE
  USING (
    is_account_member(account_id)
    AND EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.user_id = auth.uid() AND profiles.is_super_admin
    )
  );

-- ============================================================
-- Manual validation (run against a live instance, as a member
-- with account_role = 'admin' but is_super_admin = false):
--
--   1. PATCH /rest/v1/accounts?id=eq.<own account> { "name": "x" }
--      must fail with 42501 (insufficient_privilege).
--   2. PATCH /rest/v1/accounts?id=eq.<own account>
--      { "default_currency": "EUR" } must still succeed (admin+
--      keeps this capability — only `name` is guarded).
--   3. POST /rest/v1/ai_configs { ... } and PATCH/DELETE on an
--      existing row must return 0 rows affected / be rejected by
--      RLS (403 or empty result, not a hard error).
--   4. Same three, now as a super admin: all must succeed.
-- ============================================================
