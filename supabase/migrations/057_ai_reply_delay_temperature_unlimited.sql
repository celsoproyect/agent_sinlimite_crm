-- ============================================================
-- 057_ai_reply_delay_temperature_unlimited.sql
--
-- Three account-level AI behaviour knobs requested together:
--
--   1. `auto_reply_max_per_conversation` becomes nullable — NULL means
--      "no cap" ("sin límite"). The 1-20 range stays available for
--      accounts that still want a cap; the existing CHECK constraint
--      already passes NULL through untouched, so only the NOT NULL
--      needs to go. `claim_ai_reply_slot` is updated to treat a NULL
--      `max_replies` as unlimited.
--   2. `reply_delay_seconds` — how long (WhatsApp-only) the bot waits
--      after ITS OWN last reply before answering again, so several
--      customer messages sent in that window get answered together
--      instead of one bot reply per inbound. 0 (default) preserves
--      today's immediate-reply behaviour.
--   3. `temperature` — real sampling temperature threaded into the
--      provider request body (lib/ai/providers/*.ts), 0-2 same range
--      both OpenAI and Anthropic accept.
--
-- `conversations.last_ai_reply_at` is the anchor `reply_delay_seconds`
-- measures from — set after a successful auto-reply send.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ALTER COLUMN auto_reply_max_per_conversation DROP NOT NULL;

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS reply_delay_seconds integer NOT NULL DEFAULT 0
    CHECK (reply_delay_seconds BETWEEN 0 AND 300);

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS temperature numeric(3,2) NOT NULL DEFAULT 0.7
    CHECK (temperature BETWEEN 0 AND 2);

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_ai_reply_at timestamptz;

-- Re-create the atomic slot claim to treat a NULL `max_replies` as "no
-- cap": the row is always eligible, so only the `+ 1` runs. Everything
-- else (SECURITY DEFINER, search_path, the service_role grant) is
-- unchanged from migration 029.
CREATE OR REPLACE FUNCTION public.claim_ai_reply_slot(
  conversation_id uuid,
  max_replies integer
)
RETURNS boolean AS $$
  WITH claimed AS (
    UPDATE conversations
    SET ai_reply_count = ai_reply_count + 1
    WHERE id = conversation_id
      AND (max_replies IS NULL OR ai_reply_count < max_replies)
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer) TO service_role;
