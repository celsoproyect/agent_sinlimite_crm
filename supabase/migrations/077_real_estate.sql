-- ============================================================
-- 077_real_estate.sql
--
-- Real estate module (page module `properties`): the property inventory
-- the AI agent searches by operation, type, zone, budget, bedrooms and
-- amenities, and books visits with the property's advisor.
--
-- 1. properties: one listing each. `operation` sale | rent, `status`
--    available | reserved | sold | rented (only `available` is offered by
--    the AI). `amenities` is a text[] of canonical keys (pool, gym…, see
--    src/lib/real-estate/amenities.ts); free-text extras are kept too.
--    `photos` are public chat-media URLs. `advisor_id` points at a row of
--    `professionals` (migration 066), reused as the real-estate advisors:
--    each advisor has their own agenda for visits.
-- 2. bookings.property_id: the property a visit is for (nullable).
-- 3. professionals.kind: 'doctor' (clinic) | 'advisor' (real estate), so
--    each module only sees its own people even when both are on.
--
-- Needs migrations 066 and 068. Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS properties (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code           text,
  title          text NOT NULL CHECK (length(trim(title)) > 0),
  operation      text NOT NULL DEFAULT 'sale',
  property_type  text NOT NULL DEFAULT 'apartment',
  zone           text,
  city           text,
  address        text,
  price          numeric(14, 2),
  currency       text NOT NULL DEFAULT 'USD',
  bedrooms       integer CHECK (bedrooms IS NULL OR bedrooms BETWEEN 0 AND 50),
  bathrooms      numeric(4, 1) CHECK (bathrooms IS NULL OR bathrooms BETWEEN 0 AND 50),
  parking        integer CHECK (parking IS NULL OR parking BETWEEN 0 AND 50),
  area_m2        numeric(10, 2) CHECK (area_m2 IS NULL OR area_m2 > 0),
  amenities      text[] NOT NULL DEFAULT '{}',
  description    text,
  photos         text[] NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'available',
  advisor_id     uuid REFERENCES professionals(id) ON DELETE SET NULL,
  active         boolean NOT NULL DEFAULT true,
  sort_order     integer NOT NULL DEFAULT 0,
  is_sample      boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_operation_check;
ALTER TABLE properties ADD CONSTRAINT properties_operation_check
  CHECK (operation IN ('sale', 'rent'));

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_type_check;
ALTER TABLE properties ADD CONSTRAINT properties_type_check
  CHECK (property_type IN ('apartment', 'house', 'villa', 'penthouse', 'land', 'commercial', 'office', 'warehouse', 'room'));

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_status_check;
ALTER TABLE properties ADD CONSTRAINT properties_status_check
  CHECK (status IN ('available', 'reserved', 'sold', 'rented'));

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_price_check;
ALTER TABLE properties ADD CONSTRAINT properties_price_check
  CHECK (price IS NULL OR price >= 0);

CREATE INDEX IF NOT EXISTS properties_account_idx ON properties (account_id, active, status);
CREATE UNIQUE INDEX IF NOT EXISTS properties_account_code_key
  ON properties (account_id, lower(code)) WHERE code IS NOT NULL;

ALTER TABLE properties ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS properties_select ON properties;
CREATE POLICY properties_select ON properties FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS properties_insert ON properties;
CREATE POLICY properties_insert ON properties FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS properties_update ON properties;
CREATE POLICY properties_update ON properties FOR UPDATE USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS properties_delete ON properties;
CREATE POLICY properties_delete ON properties FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ---------- 2. bookings.property_id ----------

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES properties(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS bookings_property_idx ON bookings (property_id) WHERE property_id IS NOT NULL;

-- ---------- 3. professionals.kind ----------

ALTER TABLE professionals
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'doctor';

ALTER TABLE professionals DROP CONSTRAINT IF EXISTS professionals_kind_check;
ALTER TABLE professionals ADD CONSTRAINT professionals_kind_check
  CHECK (kind IN ('doctor', 'advisor'));

-- Advisors already named by a listing are advisors.
UPDATE professionals SET kind = 'advisor'
WHERE kind = 'doctor' AND id IN (SELECT advisor_id FROM properties WHERE advisor_id IS NOT NULL);
