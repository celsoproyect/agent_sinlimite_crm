-- ============================================================
-- 052_booking_reminders.sql
--
-- Automatic WhatsApp reminders before a booking's starts_at. Two
-- tables:
--
-- 1. `booking_reminder_rules` — account-level configuration: at what
--    offset before the appointment to remind (e.g. 1440/360/60
--    minutes), the free-text message (with {{contact_name}}/
--    {{service}}/{{date}}/{{time}} placeholders), and an optional
--    approved message_templates name to fall back to when WhatsApp's
--    24h customer-service window has closed (free text is then
--    rejected by Meta). Settings-class table — same RLS shape as
--    `message_templates` (017): members read, admins write.
--
-- 2. `booking_reminder_sends` — one row per (booking, rule) actually
--    attempted. The UNIQUE constraint is the de-dup/claim mechanism:
--    the cron does an `INSERT ... ON CONFLICT DO NOTHING` before
--    sending, so overlapping/repeated cron runs never double-send.
--    Service-role only, same pattern as `telegram_admin_turns` (051).
--
-- `get_due_booking_reminders(p_limit)` does the time-window join in
-- SQL (starts_at - offset_minutes <= now() < starts_at) since that's
-- awkward to express through the Supabase JS query builder.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS booking_reminder_rules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  offset_minutes    integer NOT NULL CHECK (offset_minutes > 0),
  message_text      text NOT NULL,
  template_name     text,
  template_language text,
  enabled           boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, offset_minutes)
);

ALTER TABLE booking_reminder_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS booking_reminder_rules_select ON booking_reminder_rules;
CREATE POLICY booking_reminder_rules_select ON booking_reminder_rules FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS booking_reminder_rules_insert ON booking_reminder_rules;
CREATE POLICY booking_reminder_rules_insert ON booking_reminder_rules FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS booking_reminder_rules_update ON booking_reminder_rules;
CREATE POLICY booking_reminder_rules_update ON booking_reminder_rules FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS booking_reminder_rules_delete ON booking_reminder_rules;
CREATE POLICY booking_reminder_rules_delete ON booking_reminder_rules FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_booking_reminder_rules_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS booking_reminder_rules_updated_at ON booking_reminder_rules;
CREATE TRIGGER booking_reminder_rules_updated_at
  BEFORE UPDATE ON booking_reminder_rules
  FOR EACH ROW
  EXECUTE FUNCTION public.update_booking_reminder_rules_updated_at();

CREATE TABLE IF NOT EXISTS booking_reminder_sends (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  rule_id    uuid NOT NULL REFERENCES booking_reminder_rules(id) ON DELETE CASCADE,
  status     text NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  channel    text CHECK (channel IN ('text', 'template')),
  error      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, rule_id)
);

CREATE INDEX IF NOT EXISTS idx_booking_reminder_sends_booking
  ON booking_reminder_sends (booking_id);

ALTER TABLE booking_reminder_sends ENABLE ROW LEVEL SECURITY;
-- No policy for authenticated users — only the cron route (service-role
-- key) reads/writes this table, same pattern as telegram_admin_turns.

CREATE OR REPLACE FUNCTION public.update_booking_reminder_sends_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS booking_reminder_sends_updated_at ON booking_reminder_sends;
CREATE TRIGGER booking_reminder_sends_updated_at
  BEFORE UPDATE ON booking_reminder_sends
  FOR EACH ROW
  EXECUTE FUNCTION public.update_booking_reminder_sends_updated_at();

CREATE OR REPLACE FUNCTION public.get_due_booking_reminders(p_limit integer)
RETURNS TABLE (
  booking_id      uuid,
  account_id      uuid,
  contact_id      uuid,
  conversation_id uuid,
  service         text,
  starts_at       timestamptz,
  contact_name    text,
  contact_phone   text,
  rule_id         uuid,
  offset_minutes  integer,
  message_text    text,
  template_name   text,
  template_language text
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    b.id AS booking_id,
    b.account_id,
    b.contact_id,
    b.conversation_id,
    b.service,
    b.starts_at,
    c.name AS contact_name,
    c.phone AS contact_phone,
    r.id AS rule_id,
    r.offset_minutes,
    r.message_text,
    r.template_name,
    r.template_language
  FROM bookings b
  JOIN booking_reminder_rules r ON r.account_id = b.account_id AND r.enabled
  JOIN contacts c ON c.id = b.contact_id
  WHERE b.status = 'confirmed'
    AND b.starts_at > now()
    AND b.starts_at - (r.offset_minutes || ' minutes')::interval <= now()
    AND NOT EXISTS (
      SELECT 1 FROM booking_reminder_sends s
      WHERE s.booking_id = b.id AND s.rule_id = r.id AND s.status IN ('pending', 'sent')
    )
  ORDER BY b.starts_at
  LIMIT p_limit;
$$;
