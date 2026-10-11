-- 075: AI lead prequalification (module ai_qualification).
-- The agent stores what it learned about each customer (interest, need,
-- timeline, budget, the owner's own questions, temperature, summary) in
-- contacts.qualification; the owner writes their questions, one per
-- line, in ai_configs.qualification_questions. Before this runs the
-- code keeps the prequalification as a contact note instead.

alter table public.contacts add column if not exists qualification jsonb;
alter table public.contacts add column if not exists qualified_at timestamptz;
alter table public.ai_configs add column if not exists qualification_questions text;

create index if not exists contacts_qualified_at_idx
  on public.contacts (account_id, qualified_at desc)
  where qualified_at is not null;
