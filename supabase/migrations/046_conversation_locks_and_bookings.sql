-- ============================================================
-- 046_conversation_locks_and_bookings.sql
--
-- 1. Real conversation locking: `assigned_agent_id` (already existed,
--    previously just an advisory dropdown with zero enforcement) becomes
--    the actual lock holder. A BEFORE UPDATE trigger rejects reassigning
--    an already-claimed conversation to someone else unless the caller
--    is the current holder (releasing/reassigning their own claim) or an
--    admin/owner. This is enforced at the DB layer so it protects every
--    write path — the new dashboard send-route check, the existing
--    assignment dropdown, and any future caller — not just one of them.
-- 2. `messages` gains a 'system_event' content_type (inline AI-action
--    annotations in the thread, e.g. "checked availability") and a
--    generic `metadata` JSONB column (system-event detail + rich
--    product/booking card data). Deliberately separate from
--    `interactive_payload`, which stays scoped to outbound interactive
--    messages per its original migration 035 comment.
-- 3. `bookings`: a new account-scoped table backing the Agenda module
--    and the AI's check_availability/book_appointment tools.
-- 4. `accounts.booking_settings`: business hours / slot length, one JSON
--    blob per account (the account is single-owner — no per-team config
--    needed).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Real conversation locking
-- ------------------------------------------------------------

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION enforce_conversation_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only guards *stealing* an existing claim. Claiming an unassigned
  -- conversation, or the holder releasing/reassigning their own claim,
  -- always passes through.
  IF OLD.assigned_agent_id IS NOT NULL
     AND NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id
     AND auth.uid() IS DISTINCT FROM OLD.assigned_agent_id
     AND NOT is_account_member(NEW.account_id, 'admin') THEN
    RAISE EXCEPTION 'conversation_locked'
      USING DETAIL = 'This conversation is already claimed by another agent.';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION enforce_conversation_lock() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_conversation_lock_trigger ON conversations;
CREATE TRIGGER enforce_conversation_lock_trigger
  BEFORE UPDATE OF assigned_agent_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION enforce_conversation_lock();

-- ------------------------------------------------------------
-- 2. messages: system_event content_type + generic metadata
-- ------------------------------------------------------------

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_content_type_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_content_type_check
  CHECK (content_type IN (
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive', 'system_event'
  ));

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS metadata JSONB;

-- ------------------------------------------------------------
-- 3. bookings
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bookings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  service         text NOT NULL DEFAULT '',
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'confirmed'
                    CHECK (status IN ('confirmed', 'cancelled', 'completed')),
  -- NULL when the AI booking tool created it rather than a human agent.
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS bookings_account_starts_at_idx
  ON bookings (account_id, starts_at);

CREATE INDEX IF NOT EXISTS bookings_contact_id_idx
  ON bookings (contact_id);

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bookings_select ON bookings;
CREATE POLICY bookings_select ON bookings FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS bookings_insert ON bookings;
CREATE POLICY bookings_insert ON bookings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS bookings_update ON bookings;
CREATE POLICY bookings_update ON bookings FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS bookings_delete ON bookings;
CREATE POLICY bookings_delete ON bookings FOR DELETE
  USING (is_account_member(account_id, 'agent'));

CREATE OR REPLACE FUNCTION public.update_bookings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bookings_updated_at ON bookings;
CREATE TRIGGER bookings_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_bookings_updated_at();

-- ------------------------------------------------------------
-- 4. accounts.booking_settings — business hours / slot length
-- ------------------------------------------------------------

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS booking_settings JSONB NOT NULL DEFAULT '{}'::jsonb;
