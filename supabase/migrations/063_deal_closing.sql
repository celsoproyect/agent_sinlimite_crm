-- 063: real deal closing (won / lost).
--
-- * pipeline_stages.kind marks the stage a deal lands in when it is won
--   or lost. Dropping a card on such a column closes the deal; closed
--   deals leave the board and show up in the "Cerrados" list.
-- * deals.closed_at / lost_reason / close_note record when and why.
-- * pipelines.auto_lose_days: open deals with no activity for that many
--   days are closed as lost ("no_response") by the server. NULL = off.

ALTER TABLE pipeline_stages
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'open';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_stages_kind_check'
  ) THEN
    ALTER TABLE pipeline_stages
      ADD CONSTRAINT pipeline_stages_kind_check CHECK (kind IN ('open', 'won', 'lost'));
  END IF;
END $$;

UPDATE pipeline_stages SET kind = 'won'
  WHERE kind = 'open' AND (name ILIKE '%won%' OR name ILIKE '%ganad%');
UPDATE pipeline_stages SET kind = 'lost'
  WHERE kind = 'open' AND (name ILIKE '%lost%' OR name ILIKE '%perdid%');

-- Every pipeline gets a "Perdido" column to drop lost deals on.
INSERT INTO pipeline_stages (pipeline_id, name, color, position, kind)
SELECT p.id, 'Perdido', '#ef4444',
       COALESCE((SELECT MAX(position) + 1 FROM pipeline_stages s WHERE s.pipeline_id = p.id), 0),
       'lost'
  FROM pipelines p
 WHERE NOT EXISTS (
   SELECT 1 FROM pipeline_stages s WHERE s.pipeline_id = p.id AND s.kind = 'lost'
 );

ALTER TABLE deals ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS lost_reason TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS close_note TEXT;

-- Deals already marked won/lost keep their last update as the close date.
UPDATE deals SET closed_at = updated_at WHERE status <> 'open' AND closed_at IS NULL;

-- Deals sitting in a "Won"/"Lost" column but still open become closed.
UPDATE deals d
   SET status = s.kind, closed_at = COALESCE(d.closed_at, d.updated_at)
  FROM pipeline_stages s
 WHERE d.stage_id = s.id AND d.status = 'open' AND s.kind IN ('won', 'lost');

CREATE INDEX IF NOT EXISTS idx_deals_account_status_closed
  ON deals(account_id, status, closed_at DESC);

ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS auto_lose_days INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pipelines_auto_lose_days_check'
  ) THEN
    ALTER TABLE pipelines
      ADD CONSTRAINT pipelines_auto_lose_days_check
      CHECK (auto_lose_days IS NULL OR auto_lose_days BETWEEN 1 AND 365);
  END IF;
END $$;
