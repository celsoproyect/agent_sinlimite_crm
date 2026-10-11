-- ============================================================
-- 076: automatic chat assignment (module `auto_assign`)
--
-- When the AI hands a customer to a person (they asked for one, or the
-- AI didn't have the answer), or a new chat arrives while the AI isn't
-- answering, the chat goes to one teammate: round robin, a fixed
-- sequence, or whoever has the fewest open chats. If that person
-- doesn't answer within the owner's minutes, it moves to the next.
--
--  - accounts.assignment_settings: { mode, members, reassign_minutes,
--    assign_when_ai_off }. NULL = off.
--  - profiles.is_available: "Disponible" switch; away people are skipped.
--  - profiles.last_auto_assigned_at: round-robin turn.
--  - conversations.auto_assigned / assignment_attempts /
--    assignment_reason: set by the app when it assigns. A manual
--    (re)assignment clears them (trigger below), so the reassign timer
--    never moves a chat someone claimed by hand.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS assignment_settings JSONB;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_available BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_auto_assigned_at TIMESTAMPTZ;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS auto_assigned BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS assignment_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS assignment_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_conversations_auto_assigned
  ON conversations (account_id, locked_at)
  WHERE auto_assigned;

-- A change of assignee that doesn't also bump assignment_attempts came
-- from a person (inbox, automation, API): it is no longer an automatic
-- assignment. It also stamps locked_at when the caller didn't.
CREATE OR REPLACE FUNCTION reset_auto_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id THEN
    IF NEW.assignment_attempts IS NOT DISTINCT FROM OLD.assignment_attempts THEN
      NEW.auto_assigned := false;
      NEW.assignment_attempts := 0;
      NEW.assignment_reason := NULL;
    END IF;
    IF NEW.locked_at IS NOT DISTINCT FROM OLD.locked_at THEN
      NEW.locked_at := CASE WHEN NEW.assigned_agent_id IS NULL THEN NULL ELSE now() END;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reset_auto_assignment_trigger ON conversations;
CREATE TRIGGER reset_auto_assignment_trigger
  BEFORE UPDATE OF assigned_agent_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION reset_auto_assignment();

-- The lock (migration 046) also stopped the server itself (service role,
-- no auth.uid()) from moving a claimed chat, which the reassign timer
-- needs. RLS already keeps anonymous callers from updating anything.
CREATE OR REPLACE FUNCTION enforce_conversation_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.assigned_agent_id IS NOT NULL
     AND NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id
     AND auth.uid() IS NOT NULL
     AND auth.uid() IS DISTINCT FROM OLD.assigned_agent_id
     AND NOT is_account_member(NEW.account_id, 'admin') THEN
    RAISE EXCEPTION 'conversation_locked'
      USING DETAIL = 'This conversation is already claimed by another agent.';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION enforce_conversation_lock() OWNER TO postgres;

-- The assignment notification (migration 027), now in Spanish and
-- skipped for automatic assignments: the app sends its own, with the
-- AI's summary and a push to the assignee's phone.
CREATE OR REPLACE FUNCTION notify_conversation_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_name TEXT;
  v_actor_name TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.assigned_agent_id IS NULL
       OR NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.auto_assigned THEN
    RETURN NEW;
  END IF;

  -- Skip self-assignment — nothing to notify the agent about.
  IF auth.uid() IS NOT NULL AND auth.uid() = NEW.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
  FROM contacts WHERE id = NEW.contact_id;

  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name
    FROM profiles WHERE user_id = auth.uid();
  END IF;

  INSERT INTO notifications (
    account_id, user_id, type, conversation_id, contact_id,
    actor_user_id, title, body
  ) VALUES (
    NEW.account_id,
    NEW.assigned_agent_id,
    'conversation_assigned',
    NEW.id,
    NEW.contact_id,
    auth.uid(),
    'Nueva conversación asignada',
    COALESCE(v_actor_name, 'El sistema') || ' te asignó la conversación con '
      || COALESCE(v_contact_name, 'un contacto')
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create assignment notification for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION notify_conversation_assigned() OWNER TO postgres;
