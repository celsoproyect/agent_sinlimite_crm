-- 065: Google Calendar sync for the agenda + weekly owner report.
--
-- * google_calendar_connections: one Google account per CRM account.
--   The refresh token is encrypted by the app (same key as the other
--   API secrets). RLS is on with no policies, so only the service role
--   (server routes) can read or write it; the browser never sees it.
-- * bookings.google_event_id: the event this booking created in Google,
--   so a reschedule or cancel updates the same event.
-- * accounts.weekly_report_enabled / weekly_report_sent_at: the Monday
--   summary sent to the owner's Telegram chat, and when the last one
--   went out (dedupes the send across restarts).

CREATE TABLE IF NOT EXISTS google_calendar_connections (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  google_email TEXT,
  refresh_token TEXT NOT NULL,
  calendar_id TEXT NOT NULL DEFAULT 'primary',
  connected_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE google_calendar_connections ENABLE ROW LEVEL SECURITY;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS google_event_id TEXT;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS weekly_report_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS weekly_report_sent_at TIMESTAMPTZ;

-- Reports filter AI messages by date.
CREATE INDEX IF NOT EXISTS messages_ai_generated_created_idx
  ON messages (created_at)
  WHERE ai_generated = TRUE;

-- Backfill: before this release the web widget's AI replies, the AI's
-- catalog cards and its slot buttons were stored without ai_generated.
-- Every bot text on the web channel is the AI (the widget has no flows
-- or automations); product cards and booking_slot_ buttons only come
-- from the AI on WhatsApp.
UPDATE messages m SET ai_generated = TRUE
  FROM conversations c
 WHERE m.conversation_id = c.id
   AND m.ai_generated = FALSE
   AND m.sender_type = 'bot'
   AND (
     (c.channel = 'web' AND m.content_type = 'text')
     OR m.metadata->>'kind' = 'product_card'
     OR (m.content_type = 'interactive'
         AND m.interactive_payload::text LIKE '%"id": "booking_slot_%')
   );
