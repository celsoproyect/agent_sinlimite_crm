-- ============================================================
-- 070_lead_form_submissions.sql
--
-- Keeps every raw submission of the public lead form
-- (POST /api/leads/[leadFormKey]/submit, migration 050) so the owner
-- can read it in Leads → Formularios. Until now the endpoint only
-- created the contact, custom values and deal, and the submission
-- itself was lost.
--
-- * `fields` holds every submitted field as received (raw jsonb).
-- * contact_id / deal_id point at what the submission created or
--   matched; they become NULL if those rows are deleted.
-- * `is_read` drives the unread dot in the list.
--
-- The submit route inserts with the service role and tolerates this
-- table being missing (42P01), so the form keeps working before this
-- runs. Needs migration 017 (is_account_member). Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_form_submissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id  uuid REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id     uuid REFERENCES deals(id) ON DELETE SET NULL,
  name        text,
  email       text,
  phone       text,
  message     text,
  fields      jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_url  text,
  user_agent  text,
  ip          text,
  is_read     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_form_submissions_account_created_idx
  ON lead_form_submissions (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS lead_form_submissions_contact_idx
  ON lead_form_submissions (contact_id);

ALTER TABLE lead_form_submissions ENABLE ROW LEVEL SECURITY;

-- Any member reads; agents and up mark as read; admins delete.
-- Inserts come from the public endpoint with the service role.
DROP POLICY IF EXISTS lead_form_submissions_select ON lead_form_submissions;
CREATE POLICY lead_form_submissions_select ON lead_form_submissions
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS lead_form_submissions_insert ON lead_form_submissions;
CREATE POLICY lead_form_submissions_insert ON lead_form_submissions
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS lead_form_submissions_update ON lead_form_submissions;
CREATE POLICY lead_form_submissions_update ON lead_form_submissions
  FOR UPDATE USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS lead_form_submissions_delete ON lead_form_submissions;
CREATE POLICY lead_form_submissions_delete ON lead_form_submissions
  FOR DELETE USING (is_account_member(account_id, 'admin'));
