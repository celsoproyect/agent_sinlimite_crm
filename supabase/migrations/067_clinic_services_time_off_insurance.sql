-- 067: Clinic module, part 2 — needs migration 066.
--
-- * professional_time_off: days a doctor doesn't work (vacation, a
--   congress, sick leave). Both dates are business-local and inclusive.
--   The doctor offers no slots on those days; the business holidays keep
--   applying on top.
-- * clinic_services: the kinds of appointment the clinic offers, each
--   with its own length ("Consulta 30 min", "Ecocardiograma 60 min") and
--   optional price. `specialty_id` limits it to the doctors of that
--   specialty; NULL = any doctor.
-- * bookings.clinic_service_id: the service an appointment is for.
-- * bookings.insurance: the customer's health insurance (ARS) and
--   affiliate number as they gave it, or "privado".
-- * accounts.clinic_settings: { ask_insurance: boolean, insurers: text[] }
--   — whether the AI agent asks for the insurance before booking, and
--   which insurers the clinic accepts.

CREATE TABLE IF NOT EXISTS professional_time_off (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  professional_id UUID NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  starts_on       DATE NOT NULL,
  ends_on         DATE NOT NULL,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);

CREATE INDEX IF NOT EXISTS professional_time_off_professional_idx
  ON professional_time_off (professional_id, ends_on);

CREATE TABLE IF NOT EXISTS clinic_services (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name             TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description      TEXT,
  specialty_id     UUID REFERENCES specialties(id) ON DELETE SET NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  price            NUMERIC(12, 2) CHECK (price IS NULL OR price >= 0),
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS clinic_services_account_name_idx
  ON clinic_services (account_id, lower(name));

ALTER TABLE professional_time_off ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_services ENABLE ROW LEVEL SECURITY;

-- Everyone in the account can read them; admins manage them.
DROP POLICY IF EXISTS professional_time_off_select ON professional_time_off;
CREATE POLICY professional_time_off_select ON professional_time_off FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS professional_time_off_insert ON professional_time_off;
CREATE POLICY professional_time_off_insert ON professional_time_off FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'admin')
    AND EXISTS (
      SELECT 1 FROM professionals p
       WHERE p.id = professional_id AND p.account_id = professional_time_off.account_id
    )
  );
DROP POLICY IF EXISTS professional_time_off_delete ON professional_time_off;
CREATE POLICY professional_time_off_delete ON professional_time_off FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS clinic_services_select ON clinic_services;
CREATE POLICY clinic_services_select ON clinic_services FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS clinic_services_insert ON clinic_services;
CREATE POLICY clinic_services_insert ON clinic_services FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS clinic_services_update ON clinic_services;
CREATE POLICY clinic_services_update ON clinic_services FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS clinic_services_delete ON clinic_services;
CREATE POLICY clinic_services_delete ON clinic_services FOR DELETE
  USING (is_account_member(account_id, 'admin'));

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS clinic_service_id UUID REFERENCES clinic_services(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS insurance TEXT;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS clinic_settings JSONB NOT NULL DEFAULT '{}'::jsonb;
