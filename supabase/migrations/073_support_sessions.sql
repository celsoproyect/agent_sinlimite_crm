-- ============================================================
-- 073 — Support mode: the super admin enters a client's account.
--
-- "Entrar a la cuenta" (Super admin → Cuentas y consumo) moves the
-- super admin's own profile into the client's account as an admin, so
-- every RLS policy and page works exactly as it does for the client.
-- Each visit is a row here, which is also the audit log:
--   * home_account_id / home_role — where to send the super admin back
--   * ended_at NULL = still inside
--
-- The profile move itself is done by the server with the service role
-- (the 034 trigger blocks `authenticated` from changing account_id).
-- RLS on, no policies: only the service role reads or writes this.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.support_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  home_account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  home_role account_role_enum NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);

-- One open visit per super admin.
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_sessions_one_open
  ON public.support_sessions(user_id)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_support_sessions_account
  ON public.support_sessions(account_id, started_at DESC);

ALTER TABLE public.support_sessions ENABLE ROW LEVEL SECURITY;
