-- 066: Clinic module — doctors (professionals) with specialties, each
-- with their own agenda.
--
-- * specialties: the account's specialties (Pediatría, Cardiología…).
-- * professionals: the doctors. `hours` uses the same shape as
--   accounts.booking_settings.hours ({ monday: { open, close } | null, … });
--   NULL means "same hours as the business". `slot_minutes` NULL means
--   the business slot length.
-- * professional_specialties: which specialties each doctor covers.
-- * bookings.professional_id: the doctor an appointment is with. NULL for
--   businesses that don't use the clinic module (one shared agenda).
-- * bookings_no_professional_overlap: two live appointments with the same
--   doctor can never overlap, even if two requests race. Bookings without
--   a doctor are not affected.

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS specialties (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS specialties_account_name_idx
  ON specialties (account_id, lower(name));

CREATE TABLE IF NOT EXISTS professionals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (length(trim(name)) > 0),
  bio          TEXT,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  hours        JSONB,
  slot_minutes INTEGER CHECK (slot_minutes IS NULL OR slot_minutes BETWEEN 5 AND 480),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS professionals_account_idx ON professionals (account_id);

CREATE TABLE IF NOT EXISTS professional_specialties (
  professional_id UUID NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  specialty_id    UUID NOT NULL REFERENCES specialties(id) ON DELETE CASCADE,
  PRIMARY KEY (professional_id, specialty_id)
);

CREATE INDEX IF NOT EXISTS professional_specialties_specialty_idx
  ON professional_specialties (specialty_id);

ALTER TABLE specialties ENABLE ROW LEVEL SECURITY;
ALTER TABLE professionals ENABLE ROW LEVEL SECURITY;
ALTER TABLE professional_specialties ENABLE ROW LEVEL SECURITY;

-- Everyone in the account can read the directory; admins manage it.
DROP POLICY IF EXISTS specialties_select ON specialties;
CREATE POLICY specialties_select ON specialties FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS specialties_insert ON specialties;
CREATE POLICY specialties_insert ON specialties FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS specialties_update ON specialties;
CREATE POLICY specialties_update ON specialties FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS specialties_delete ON specialties;
CREATE POLICY specialties_delete ON specialties FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS professionals_select ON professionals;
CREATE POLICY professionals_select ON professionals FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS professionals_insert ON professionals;
CREATE POLICY professionals_insert ON professionals FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS professionals_update ON professionals;
CREATE POLICY professionals_update ON professionals FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS professionals_delete ON professionals;
CREATE POLICY professionals_delete ON professionals FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS professional_specialties_select ON professional_specialties;
CREATE POLICY professional_specialties_select ON professional_specialties FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM professionals p
     WHERE p.id = professional_id AND is_account_member(p.account_id)
  ));
DROP POLICY IF EXISTS professional_specialties_write ON professional_specialties;
CREATE POLICY professional_specialties_write ON professional_specialties FOR ALL
  USING (EXISTS (
    SELECT 1 FROM professionals p
     WHERE p.id = professional_id AND is_account_member(p.account_id, 'admin')
  ))
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM professionals p
       WHERE p.id = professional_id AND is_account_member(p.account_id, 'admin')
    )
    AND EXISTS (
      SELECT 1 FROM specialties s, professionals p
       WHERE s.id = specialty_id AND p.id = professional_id AND s.account_id = p.account_id
    )
  );

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS professional_id UUID REFERENCES professionals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS bookings_professional_starts_idx
  ON bookings (professional_id, starts_at)
  WHERE professional_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_no_professional_overlap'
  ) THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_no_professional_overlap
      EXCLUDE USING gist (
        professional_id WITH =,
        tstzrange(starts_at, ends_at) WITH &&
      )
      WHERE (professional_id IS NOT NULL AND status <> 'cancelled');
  END IF;
END $$;
