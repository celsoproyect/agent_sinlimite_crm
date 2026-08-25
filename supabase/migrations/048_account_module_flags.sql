-- ============================================================
-- 048_account_module_flags.sql
--
-- Lets a super admin turn individual sidebar sections on/off per
-- client account (reseller "module" control). Scope is per-account,
-- not per-user — every member of a client account sees the same
-- sidebar, matching the reseller's own decision on what that client
-- is allowed to use.
--
-- Additive JSONB, same shape as `booking_settings` (046):
--   { "agenda": false, "flows": false }
-- A MISSING key means the module is ENABLED. This is deliberate —
-- every existing account gets '{}' (all modules on) after this
-- migration, and any brand-new module added to the app later is on
-- by default until a super admin explicitly turns it off. Only an
-- explicit `false` disables a module; the app never writes `true`.
--
-- Enforcement is client-side only (hide from the sidebar + redirect
-- off the page, mirroring the existing /super-admin page guard) —
-- there is no RLS angle here because module flags don't gate data
-- ownership, just which sections of the UI a client's own users can
-- reach. See src/lib/modules.ts for the canonical module key list.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS enabled_modules JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ------------------------------------------------------------
-- Column-level guard, same pattern as
-- enforce_account_name_super_admin_only (041). accounts_update
-- (017) stays admin+ for columns like default_currency — only
-- enabled_modules is restricted to super admins, since it's the
-- reseller's lever, not the client's own.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_account_modules_super_admin_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.enabled_modules IS DISTINCT FROM OLD.enabled_modules
     AND current_user = 'authenticated'
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles
       WHERE profiles.user_id = auth.uid() AND profiles.is_super_admin
     )
  THEN
    RAISE EXCEPTION
      'accounts.enabled_modules can only be changed by a super admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_account_modules_super_admin_only() OWNER TO postgres;

DROP TRIGGER IF EXISTS accounts_modules_super_admin_guard ON public.accounts;
CREATE TRIGGER accounts_modules_super_admin_guard
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_account_modules_super_admin_only();

-- ============================================================
-- Manual validation (run against a live instance, as a member
-- with account_role = 'admin' but is_super_admin = false):
--
--   1. PATCH /rest/v1/accounts?id=eq.<own account>
--      { "enabled_modules": { "agenda": false } } must fail with
--      42501 (insufficient_privilege).
--   2. PATCH /rest/v1/accounts?id=eq.<own account>
--      { "default_currency": "EUR" } must still succeed.
--   3. Same PATCH as (1), now as a super admin: must succeed.
-- ============================================================
