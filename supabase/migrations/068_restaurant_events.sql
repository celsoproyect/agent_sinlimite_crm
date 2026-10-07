-- ============================================================
-- 068_restaurant_events.sql
--
-- Restaurant and event-hall modules, follow-ups after an appointment,
-- no-shows and removable sample data.
--
-- 1. bookings gets a `kind`: 'appointment' (the agenda, clinic doctors),
--    'table' (a restaurant reservation) or 'event' (a hall booking).
--    Table and event bookings never block the appointment agenda.
--    * table:  party_size, occasion, seating ('single' | 'joined' |
--              'separate'), preorder (jsonb list of {item, qty, notes}).
--    * event:  event_hall_id, event_package_id, event_type, guests in
--              party_size, event_status (requested → quoted →
--              deposit_paid → confirmed → completed | cancelled),
--              quote_amount, deposit_amount, deposit_paid_at, currency.
--    status also accepts 'no_show'.
-- 2. restaurant_areas / restaurant_tables: the floor plan. A table seats
--    min_party..max_party; `combinable` tables in the same area can be
--    joined (or given side by side) for a bigger party.
-- 3. booking_tables: the tables a reservation holds. Its exclusion
--    constraint makes a double-booked table fail with 23P01. A trigger on
--    bookings keeps its times in sync and releases the tables when the
--    reservation is cancelled or marked no-show.
-- 4. event_halls / event_packages: the halls and what they sell.
--    requires_approval / deposit_percent per hall override the account's
--    event_settings (NULL = use the account setting).
-- 5. accounts.restaurant_settings / accounts.event_settings (jsonb).
-- 6. restaurant_waitlist: customers waiting for a table.
-- 7. booking_reminder_rules gets `kind` ('before' = reminder, 'after' =
--    follow-up) and `applies_to` ('all' | 'appointment' | 'table' |
--    'event'); get_due_booking_reminders returns both kinds.
-- 8. is_sample on everything the "Cargar ejemplos" buttons create, so
--    the examples can be removed and never get a reminder.
--
-- Needs migrations 046, 052, 062 and 066. Idempotent — safe to re-run.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- ---------- 1. bookings ----------

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'appointment',
  ADD COLUMN IF NOT EXISTS party_size integer,
  ADD COLUMN IF NOT EXISTS occasion text,
  ADD COLUMN IF NOT EXISTS seating text,
  ADD COLUMN IF NOT EXISTS preorder jsonb,
  ADD COLUMN IF NOT EXISTS is_sample boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS event_type text,
  ADD COLUMN IF NOT EXISTS event_status text,
  ADD COLUMN IF NOT EXISTS quote_amount numeric(12, 2),
  ADD COLUMN IF NOT EXISTS deposit_amount numeric(12, 2),
  ADD COLUMN IF NOT EXISTS deposit_paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS currency text;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_kind_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_kind_check
  CHECK (kind IN ('appointment', 'table', 'event'));

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_seating_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_seating_check
  CHECK (seating IS NULL OR seating IN ('single', 'joined', 'separate'));

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_event_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_event_status_check
  CHECK (event_status IS NULL OR event_status IN
    ('requested', 'quoted', 'deposit_paid', 'confirmed', 'completed', 'cancelled'));

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_party_size_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_party_size_check
  CHECK (party_size IS NULL OR party_size BETWEEN 1 AND 5000);

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show'));

-- A no-show no longer holds the doctor's time either.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_no_professional_overlap;
ALTER TABLE bookings
  ADD CONSTRAINT bookings_no_professional_overlap
  EXCLUDE USING gist (
    professional_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  )
  WHERE (professional_id IS NOT NULL AND status NOT IN ('cancelled', 'no_show'));

CREATE INDEX IF NOT EXISTS bookings_account_kind_starts_idx
  ON bookings (account_id, kind, starts_at);

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_sample boolean NOT NULL DEFAULT false;
ALTER TABLE professionals ADD COLUMN IF NOT EXISTS is_sample boolean NOT NULL DEFAULT false;
ALTER TABLE specialties ADD COLUMN IF NOT EXISTS is_sample boolean NOT NULL DEFAULT false;
DO $$
BEGIN
  IF to_regclass('public.clinic_services') IS NOT NULL THEN
    ALTER TABLE clinic_services ADD COLUMN IF NOT EXISTS is_sample boolean NOT NULL DEFAULT false;
  END IF;
END $$;

-- ---------- 2. floor plan ----------

CREATE TABLE IF NOT EXISTS restaurant_areas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  description text,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  is_sample   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS restaurant_areas_account_name_idx
  ON restaurant_areas (account_id, lower(name));

CREATE TABLE IF NOT EXISTS restaurant_tables (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  area_id     uuid REFERENCES restaurant_areas(id) ON DELETE SET NULL,
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  min_party   integer NOT NULL DEFAULT 1 CHECK (min_party >= 1),
  max_party   integer NOT NULL CHECK (max_party >= 1),
  combinable  boolean NOT NULL DEFAULT true,
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  notes       text,
  is_sample   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (max_party >= min_party)
);
CREATE UNIQUE INDEX IF NOT EXISTS restaurant_tables_account_name_idx
  ON restaurant_tables (account_id, lower(name));

-- ---------- 3. tables held by a reservation ----------

CREATE TABLE IF NOT EXISTS booking_tables (
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  table_id   uuid NOT NULL REFERENCES restaurant_tables(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  released   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (booking_id, table_id),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS booking_tables_account_starts_idx
  ON booking_tables (account_id, starts_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'booking_tables_no_overlap'
  ) THEN
    ALTER TABLE booking_tables
      ADD CONSTRAINT booking_tables_no_overlap
      EXCLUDE USING gist (
        table_id WITH =,
        tstzrange(starts_at, ends_at) WITH &&
      )
      WHERE (NOT released);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.sync_booking_tables()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.kind = 'table' AND (
    NEW.starts_at IS DISTINCT FROM OLD.starts_at
    OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
    OR NEW.status IS DISTINCT FROM OLD.status
  ) THEN
    UPDATE booking_tables
       SET starts_at = NEW.starts_at,
           ends_at = NEW.ends_at,
           released = NEW.status IN ('cancelled', 'no_show')
     WHERE booking_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_sync_tables ON bookings;
CREATE TRIGGER bookings_sync_tables
  AFTER UPDATE ON bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_booking_tables();

-- ---------- 4. halls and packages ----------

CREATE TABLE IF NOT EXISTS event_halls (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name              text NOT NULL CHECK (length(trim(name)) > 0),
  description       text,
  capacity_min      integer NOT NULL DEFAULT 1 CHECK (capacity_min >= 1),
  capacity_max      integer NOT NULL CHECK (capacity_max >= 1),
  price_per_hour    numeric(12, 2) CHECK (price_per_hour IS NULL OR price_per_hour >= 0),
  min_hours         numeric(5, 2) NOT NULL DEFAULT 1 CHECK (min_hours > 0),
  setup_minutes     integer NOT NULL DEFAULT 0 CHECK (setup_minutes >= 0),
  cleanup_minutes   integer NOT NULL DEFAULT 0 CHECK (cleanup_minutes >= 0),
  requires_approval boolean,
  deposit_percent   numeric(5, 2) CHECK (deposit_percent IS NULL OR deposit_percent BETWEEN 0 AND 100),
  active            boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 0,
  is_sample         boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (capacity_max >= capacity_min)
);
CREATE UNIQUE INDEX IF NOT EXISTS event_halls_account_name_idx
  ON event_halls (account_id, lower(name));

CREATE TABLE IF NOT EXISTS event_packages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  hall_id          uuid REFERENCES event_halls(id) ON DELETE SET NULL,
  name             text NOT NULL CHECK (length(trim(name)) > 0),
  description      text,
  price            numeric(12, 2) CHECK (price IS NULL OR price >= 0),
  price_per_person numeric(12, 2) CHECK (price_per_person IS NULL OR price_per_person >= 0),
  min_guests       integer CHECK (min_guests IS NULL OR min_guests >= 1),
  max_guests       integer CHECK (max_guests IS NULL OR max_guests >= 1),
  duration_hours   numeric(5, 2) CHECK (duration_hours IS NULL OR duration_hours > 0),
  active           boolean NOT NULL DEFAULT true,
  sort_order       integer NOT NULL DEFAULT 0,
  is_sample        boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS event_packages_account_name_idx
  ON event_packages (account_id, lower(name));

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS event_hall_id uuid REFERENCES event_halls(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS event_package_id uuid REFERENCES event_packages(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_no_hall_overlap'
  ) THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_no_hall_overlap
      EXCLUDE USING gist (
        event_hall_id WITH =,
        tstzrange(starts_at, ends_at) WITH &&
      )
      WHERE (event_hall_id IS NOT NULL AND status NOT IN ('cancelled', 'no_show'));
  END IF;
END $$;

-- ---------- 5. settings ----------

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS restaurant_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS event_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ---------- 6. waitlist ----------

CREATE TABLE IF NOT EXISTS restaurant_waitlist (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  customer_name   text,
  customer_phone  text,
  party_size      integer NOT NULL CHECK (party_size BETWEEN 1 AND 500),
  date            date NOT NULL,
  preferred_time  text,
  notes           text,
  status          text NOT NULL DEFAULT 'waiting'
                    CHECK (status IN ('waiting', 'notified', 'seated', 'cancelled', 'expired')),
  is_sample       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS restaurant_waitlist_account_date_idx
  ON restaurant_waitlist (account_id, date);

-- ---------- RLS: members read, admins manage (agents run the waitlist
-- and reservations) ----------

ALTER TABLE restaurant_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_halls ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_waitlist ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
  writer text;
BEGIN
  FOREACH t IN ARRAY ARRAY['restaurant_areas', 'restaurant_tables', 'event_halls', 'event_packages', 'booking_tables', 'restaurant_waitlist']
  LOOP
    writer := CASE WHEN t IN ('booking_tables', 'restaurant_waitlist') THEN 'agent' ELSE 'admin' END;
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (is_account_member(account_id))', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (is_account_member(account_id, %L))', t || '_insert', t, writer);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (is_account_member(account_id, %L))', t || '_update', t, writer);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_delete', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (is_account_member(account_id, %L))', t || '_delete', t, writer);
  END LOOP;
END $$;

-- ---------- 7. reminders and follow-ups ----------

ALTER TABLE booking_reminder_rules
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'before',
  ADD COLUMN IF NOT EXISTS applies_to text NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS is_sample boolean NOT NULL DEFAULT false;

ALTER TABLE booking_reminder_rules DROP CONSTRAINT IF EXISTS booking_reminder_rules_kind_check;
ALTER TABLE booking_reminder_rules ADD CONSTRAINT booking_reminder_rules_kind_check
  CHECK (kind IN ('before', 'after'));
ALTER TABLE booking_reminder_rules DROP CONSTRAINT IF EXISTS booking_reminder_rules_applies_to_check;
ALTER TABLE booking_reminder_rules ADD CONSTRAINT booking_reminder_rules_applies_to_check
  CHECK (applies_to IN ('all', 'appointment', 'table', 'event'));

ALTER TABLE booking_reminder_rules
  DROP CONSTRAINT IF EXISTS booking_reminder_rules_account_id_offset_minutes_key;
CREATE UNIQUE INDEX IF NOT EXISTS booking_reminder_rules_unique_idx
  ON booking_reminder_rules (account_id, kind, applies_to, offset_minutes);

DROP FUNCTION IF EXISTS public.get_due_booking_reminders(integer);
CREATE FUNCTION public.get_due_booking_reminders(p_limit integer)
RETURNS TABLE (
  booking_id        uuid,
  account_id        uuid,
  contact_id        uuid,
  conversation_id   uuid,
  service           text,
  starts_at         timestamptz,
  ends_at           timestamptz,
  booking_kind      text,
  party_size        integer,
  contact_name      text,
  contact_phone     text,
  rule_id           uuid,
  rule_kind         text,
  offset_minutes    integer,
  message_text      text,
  template_name     text,
  template_language text
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    b.id AS booking_id,
    b.account_id,
    b.contact_id,
    b.conversation_id,
    b.service,
    b.starts_at,
    b.ends_at,
    b.kind AS booking_kind,
    b.party_size,
    COALESCE(NULLIF(b.customer_name, ''), c.name) AS contact_name,
    COALESCE(NULLIF(c.phone, ''), b.customer_phone) AS contact_phone,
    r.id AS rule_id,
    r.kind AS rule_kind,
    r.offset_minutes,
    r.message_text,
    r.template_name,
    r.template_language
  FROM bookings b
  JOIN booking_reminder_rules r
    ON r.account_id = b.account_id
   AND r.enabled
   AND NOT r.is_sample
   AND (r.applies_to = 'all' OR r.applies_to = b.kind)
  JOIN contacts c ON c.id = b.contact_id
  WHERE NOT b.is_sample
    AND NOT c.is_sample
    AND (
      -- Reminder: before it starts, only while it's still on.
      (
        r.kind = 'before'
        AND b.status = 'confirmed'
        AND (b.kind <> 'event' OR b.event_status IN ('deposit_paid', 'confirmed'))
        AND b.starts_at > now()
        AND b.starts_at - (r.offset_minutes || ' minutes')::interval <= now()
      )
      OR
      -- Follow-up: after it ended, for two days at most (no backlog of
      -- old visits when a rule is first created).
      (
        r.kind = 'after'
        AND b.status IN ('confirmed', 'completed')
        AND (b.kind <> 'event' OR b.event_status IN ('confirmed', 'completed'))
        AND b.ends_at + (r.offset_minutes || ' minutes')::interval <= now()
        AND b.ends_at + (r.offset_minutes || ' minutes')::interval > now() - interval '2 days'
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM booking_reminder_sends s
      WHERE s.booking_id = b.id AND s.rule_id = r.id AND s.status IN ('pending', 'sent')
    )
  ORDER BY b.starts_at
  LIMIT p_limit;
$$;
