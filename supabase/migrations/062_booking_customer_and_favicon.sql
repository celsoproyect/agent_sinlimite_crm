-- ============================================================
-- 062_booking_customer_and_favicon.sql
--
-- 1. bookings.customer_name / customer_phone: the name and phone the
--    customer gave when booking. The AI agent asks for both and uses
--    the phone to find the appointment again when the customer wants
--    to change or cancel it. WhatsApp doesn't always send the
--    customer's number (username-only users, migration 054), so the
--    contact's phone can't be relied on for this.
--    The reference code ("CITA-3F9A2C") is derived from the booking
--    id, so it needs no column.
-- 2. get_due_booking_reminders falls back to the booking's phone/name
--    when the contact has none.
-- 3. platform_settings.favicon_url: the browser-tab icon, separate
--    from the logo. NULL means the dark-mode logo is used.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS customer_name text,
  ADD COLUMN IF NOT EXISTS customer_phone text;

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS favicon_url text;

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
    COALESCE(NULLIF(b.customer_name, ''), c.name) AS contact_name,
    COALESCE(NULLIF(c.phone, ''), b.customer_phone) AS contact_phone,
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
