-- ============================================================
-- 071: Web Push subscriptions (module `web_push`)
--
-- One row per browser/device a user turned notifications on from
-- (Notificaciones → "Notificaciones en este dispositivo"). The server
-- sends handoff alerts to the owners'/admins' rows with the service
-- role (src/lib/push/send.ts) and deletes the ones the push service
-- answers 404/410 for. Users only see and manage their own rows.
-- Idempotent: safe to paste again.
-- ============================================================
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint     text NOT NULL UNIQUE,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX IF NOT EXISTS push_subscriptions_account_user_idx
  ON push_subscriptions (account_id, user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_subscriptions_select ON push_subscriptions;
CREATE POLICY push_subscriptions_select ON push_subscriptions FOR SELECT
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS push_subscriptions_insert ON push_subscriptions;
CREATE POLICY push_subscriptions_insert ON push_subscriptions FOR INSERT
  WITH CHECK (user_id = auth.uid() AND is_account_member(account_id));
DROP POLICY IF EXISTS push_subscriptions_update ON push_subscriptions;
CREATE POLICY push_subscriptions_update ON push_subscriptions FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND is_account_member(account_id));
DROP POLICY IF EXISTS push_subscriptions_delete ON push_subscriptions;
CREATE POLICY push_subscriptions_delete ON push_subscriptions FOR DELETE
  USING (user_id = auth.uid());
