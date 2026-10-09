-- ============================================================
-- 072 — Platform AI key + per-account agent settings + monthly limits
--
-- SaaS split of the AI agent:
--   * The provider key now belongs to the PLATFORM (the super admin
--     pays the AI and bills it inside the plan). It lives in
--     `platform_ai_config`, a single row readable only by the service
--     role (RLS on, no policies), so no client can ever read it.
--   * Each account's owner/admin manages their own agent again
--     (prompt, toggles, handoff, lead pipeline) in Configuración →
--     Agente de IA. `ai_configs.api_key` becomes optional: NULL = run on
--     the platform key; a value = that account's own key, which only a
--     super admin can set (column guard below).
--   * `accounts.ai_monthly_limit` caps AI replies per business month for
--     accounts on the platform key (NULL = no limit). Super admin only.
--
-- The platform row is seeded from the super admin's own account config,
-- whose key is then cleared so that account runs on the platform key
-- like everyone else.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.platform_ai_config (
  id                  boolean PRIMARY KEY DEFAULT true CHECK (id),
  provider            text NOT NULL CHECK (provider IN ('openai', 'anthropic')),
  model               text NOT NULL,
  api_key             text NOT NULL,     -- AES-256-GCM-encrypted
  embeddings_api_key  text,              -- AES-256-GCM-encrypted, optional
  embeddings_model    text NOT NULL DEFAULT 'text-embedding-3-small',
  updated_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Service role only: RLS on and deliberately no policies.
ALTER TABLE public.platform_ai_config ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- ai_configs: the key is optional now (NULL = platform key).
-- ------------------------------------------------------------
ALTER TABLE public.ai_configs ALTER COLUMN api_key DROP NOT NULL;

-- Owner/admin manage their own agent again (041 had restricted every
-- write to super admins).
DROP POLICY IF EXISTS ai_configs_insert ON public.ai_configs;
CREATE POLICY ai_configs_insert ON public.ai_configs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_configs_update ON public.ai_configs;
CREATE POLICY ai_configs_update ON public.ai_configs FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_configs_delete ON public.ai_configs;
CREATE POLICY ai_configs_delete ON public.ai_configs FOR DELETE
  USING (
    is_account_member(account_id)
    AND EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.user_id = auth.uid() AND profiles.is_super_admin
    )
  );

-- Column guard: a client's admin can edit the agent, but never set or
-- change the account's own provider key (that's the super admin's call,
-- since the platform pays for the AI otherwise).
CREATE OR REPLACE FUNCTION public.enforce_ai_key_super_admin_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user = 'authenticated'
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles
       WHERE profiles.user_id = auth.uid() AND profiles.is_super_admin
     )
     AND (
       (TG_OP = 'INSERT' AND (NEW.api_key IS NOT NULL OR NEW.embeddings_api_key IS NOT NULL))
       OR (TG_OP = 'UPDATE' AND (
         NEW.api_key IS DISTINCT FROM OLD.api_key
         OR NEW.embeddings_api_key IS DISTINCT FROM OLD.embeddings_api_key
       ))
     )
  THEN
    RAISE EXCEPTION
      'ai_configs provider keys can only be changed by a super admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_ai_key_super_admin_only() OWNER TO postgres;

DROP TRIGGER IF EXISTS ai_configs_key_super_admin_guard ON public.ai_configs;
CREATE TRIGGER ai_configs_key_super_admin_guard
  BEFORE INSERT OR UPDATE ON public.ai_configs
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_ai_key_super_admin_only();

-- ------------------------------------------------------------
-- accounts.ai_monthly_limit — AI replies per business month on the
-- platform key. NULL = no limit. Super admin only.
-- ------------------------------------------------------------
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS ai_monthly_limit integer
    CHECK (ai_monthly_limit IS NULL OR ai_monthly_limit >= 0);

CREATE OR REPLACE FUNCTION public.enforce_ai_limit_super_admin_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.ai_monthly_limit IS DISTINCT FROM OLD.ai_monthly_limit
     AND current_user = 'authenticated'
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles
       WHERE profiles.user_id = auth.uid() AND profiles.is_super_admin
     )
  THEN
    RAISE EXCEPTION
      'accounts.ai_monthly_limit can only be changed by a super admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_ai_limit_super_admin_only() OWNER TO postgres;

DROP TRIGGER IF EXISTS accounts_ai_limit_super_admin_guard ON public.accounts;
CREATE TRIGGER accounts_ai_limit_super_admin_guard
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_ai_limit_super_admin_only();

-- ------------------------------------------------------------
-- Seed the platform key from the super admin's own account, then let
-- that account run on the platform key.
-- ------------------------------------------------------------
INSERT INTO public.platform_ai_config
  (id, provider, model, api_key, embeddings_api_key, embeddings_model)
SELECT true, c.provider, c.model, c.api_key, c.embeddings_api_key,
       COALESCE(c.embeddings_model, 'text-embedding-3-small')
FROM public.ai_configs c
WHERE c.api_key IS NOT NULL AND c.api_key <> ''
  AND c.account_id IN (
    SELECT account_id FROM public.profiles WHERE is_super_admin
  )
ORDER BY c.updated_at DESC
LIMIT 1
ON CONFLICT (id) DO NOTHING;

UPDATE public.ai_configs c
SET api_key = NULL,
    embeddings_api_key = NULL
FROM public.platform_ai_config p
WHERE c.api_key = p.api_key
  AND c.account_id IN (
    SELECT account_id FROM public.profiles WHERE is_super_admin
  );
