-- ============================================================
-- 074 — Plans, per-account extras and plan alerts.
--
-- The super admin sells the CRM in plans (Super admin → Planes):
--   * plans — name, price, billing interval, limits (NULL = unlimited)
--     and the modules the plan includes (same keys as enabled_modules).
--   * accounts.plan_id / plan_status / plan_expires_at — the account's
--     plan, its state (trial | active | suspended) and when it is paid
--     up to. Expiry is computed in code: past the date the account is
--     "past due", and after the grace days it is treated as suspended.
--     Super admin only (trigger below).
--   * account_extras — resources added to one account on top of its
--     plan ("+2,000 AI replies this month", "+3 users", a module).
--     expires_at NULL = permanent.
--   * plan_alerts — one row per alert already sent (80% / 100% of a
--     limit, plan about to expire...), so each goes out once.
--
-- Contacts are capped in the database (the app inserts them from the
-- browser). Only `authenticated` inserts are checked, so contacts that
-- arrive from WhatsApp, the widget or forms (service role) are never
-- lost. Every other limit is checked by the server routes.
--
-- An account with no plan has no limits (same as before this runs).
-- RLS on, no policies on the new tables: the server reads them with
-- the service role.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  billing_interval TEXT NOT NULL DEFAULT 'month'
    CHECK (billing_interval IN ('month', 'year')),
  ai_replies_month INTEGER CHECK (ai_replies_month IS NULL OR ai_replies_month >= 0),
  max_users INTEGER CHECK (max_users IS NULL OR max_users >= 0),
  max_contacts INTEGER CHECK (max_contacts IS NULL OR max_contacts >= 0),
  broadcasts_month INTEGER CHECK (broadcasts_month IS NULL OR broadcasts_month >= 0),
  max_kb_documents INTEGER CHECK (max_kb_documents IS NULL OR max_kb_documents >= 0),
  modules JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES public.plans(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS plan_status TEXT NOT NULL DEFAULT 'active'
    CHECK (plan_status IN ('trial', 'active', 'suspended')),
  ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_accounts_plan ON public.accounts(plan_id);

-- Only a super admin (or the service role) changes an account's plan.
CREATE OR REPLACE FUNCTION public.enforce_plan_super_admin_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.plan_id IS DISTINCT FROM OLD.plan_id
      OR NEW.plan_status IS DISTINCT FROM OLD.plan_status
      OR NEW.plan_expires_at IS DISTINCT FROM OLD.plan_expires_at)
     AND current_user = 'authenticated'
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles
       WHERE profiles.user_id = auth.uid() AND profiles.is_super_admin
     )
  THEN
    RAISE EXCEPTION 'the account plan can only be changed by a super admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_plan_super_admin_only() OWNER TO postgres;

DROP TRIGGER IF EXISTS accounts_plan_super_admin_guard ON public.accounts;
CREATE TRIGGER accounts_plan_super_admin_guard
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_plan_super_admin_only();

CREATE TABLE IF NOT EXISTS public.account_extras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  resource TEXT NOT NULL
    CHECK (resource IN ('ai_replies', 'users', 'contacts', 'broadcasts', 'kb_documents', 'module')),
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  module_key TEXT,
  expires_at TIMESTAMPTZ,
  note TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (resource <> 'module' OR module_key IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_account_extras_account ON public.account_extras(account_id);

ALTER TABLE public.account_extras ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.plan_alerts (
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  alert_key TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, alert_key)
);

ALTER TABLE public.plan_alerts ENABLE ROW LEVEL SECURITY;

-- Plan alerts show up in the notifications page.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'handoff_requested', 'plan_alert'));

-- ------------------------------------------------------------
-- The account's limit for one resource: the plan's value plus the
-- active extras. NULL = unlimited (no plan, or the plan has no cap).
-- Mirrors effectiveLimits() in src/lib/plans/limits.ts.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.account_plan_limit(p_account UUID, p_resource TEXT)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN s.base IS NULL THEN NULL
    ELSE s.base + COALESCE((
      SELECT SUM(e.quantity)::int
      FROM public.account_extras e
      WHERE e.account_id = p_account
        AND e.resource = p_resource
        AND (e.expires_at IS NULL OR e.expires_at > now())
    ), 0)
  END
  FROM (
    SELECT CASE p_resource
      WHEN 'ai_replies' THEN p.ai_replies_month
      WHEN 'users' THEN p.max_users
      WHEN 'contacts' THEN p.max_contacts
      WHEN 'broadcasts' THEN p.broadcasts_month
      WHEN 'kb_documents' THEN p.max_kb_documents
    END AS base
    FROM public.accounts a
    JOIN public.plans p ON p.id = a.plan_id
    WHERE a.id = p_account
  ) s
$$;

ALTER FUNCTION public.account_plan_limit(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_plan_limit(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_plan_limit(UUID, TEXT) TO authenticated, service_role;

-- Contacts created from the app stop at the plan's limit.
CREATE OR REPLACE FUNCTION public.enforce_plan_contact_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  lim INTEGER;
  used INTEGER;
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.user_id = auth.uid() AND profiles.is_super_admin
  ) THEN
    RETURN NEW;
  END IF;
  lim := public.account_plan_limit(NEW.account_id, 'contacts');
  IF lim IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO used FROM public.contacts WHERE account_id = NEW.account_id;
  IF used >= lim THEN
    RAISE EXCEPTION 'plan_limit:contacts'
      USING ERRCODE = 'P0001', DETAIL = format('%s/%s', used, lim);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contacts_plan_limit ON public.contacts;
CREATE TRIGGER contacts_plan_limit
  BEFORE INSERT ON public.contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_plan_contact_limit();
