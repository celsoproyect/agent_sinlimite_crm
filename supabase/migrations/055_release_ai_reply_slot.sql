-- claim_ai_reply_slot (029_ai_reply.sql) increments conversations.ai_reply_count
-- *before* the outbound send is attempted, with no way to give the slot back
-- if that send then fails (network blip, transient Meta error, a bug like the
-- BSUID `(#100)` one). Every failed attempt permanently burns part of the
-- conversation's reply budget even though the customer received nothing —
-- once auto_reply_max_per_conversation is exhausted this way, the agent goes
-- silent on an otherwise-healthy conversation. This adds the missing release
-- path so callers can give the slot back on a failed send.
CREATE OR REPLACE FUNCTION public.release_ai_reply_slot(
  conversation_id uuid
)
RETURNS void AS $$
  UPDATE conversations
  SET ai_reply_count = GREATEST(ai_reply_count - 1, 0)
  WHERE id = conversation_id;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.release_ai_reply_slot(uuid) TO service_role;
