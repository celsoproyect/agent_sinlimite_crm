-- ============================================================
-- 069: in-app notification when a customer asks for a human
--
-- The AI handoff (auto-reply / web widget) now notifies every owner
-- and admin with type 'handoff_requested' and the AI's summary of what
-- the customer wants. Until this runs the code falls back to
-- 'conversation_assigned' (CHECK violation 23514).
-- ============================================================
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'handoff_requested'));
