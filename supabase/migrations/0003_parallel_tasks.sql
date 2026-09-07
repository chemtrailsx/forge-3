-- ---------------------------------------------------------------------------
-- Parallel cooking and proactive reminders.
--
-- Until now a timer was only ever something the cook asked for, and the
-- assistant only spoke when spoken to. Real cooking is not like that: the pasta
-- goes in, and then you chop while it boils, and the thing that matters is
-- being told when to come back.
--
-- So a timer gains a `kind`. A `step` timer is one the assistant started
-- itself when an unattended step began; it belongs to a step, and it is the
-- record of work happening while the cook does something else. `reminded_at`
-- is what stops the assistant announcing the same pasta twice.
--
-- No new table: a step in progress *is* a countdown that belongs to a user and
-- a session, which is what this table already models. Adding a second one
-- would duplicate the RLS, the ownership trigger and the reaping.
-- ---------------------------------------------------------------------------

alter table public.timers
  add column if not exists kind text not null default 'timer',
  add column if not exists step_index integer,
  -- Two separate facts, deliberately not one. "I warned you it was nearly
  -- done" must not suppress "it is done now" — collapsing them into a single
  -- `reminded_at` would mean every step the cook was warned about then
  -- finished in silence.
  add column if not exists heads_up_at timestamptz,
  add column if not exists reminded_at timestamptz;

do $do$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'timers_kind_check'
  ) then
    alter table public.timers
      add constraint timers_kind_check check (kind in ('timer', 'step'));
  end if;
end;
$do$;

-- The nudge poll asks one question, several times a minute, per active cook:
-- "anything of mine finished that I have not been told about?" This is the
-- index that keeps that a lookup rather than a scan.
create index if not exists timers_pending_reminder_idx
  on public.timers (user_id, session_id)
  where status = 'running' and reminded_at is null;

-- A session may exist before its recipe does — the cook says "I want to make
-- pasta" and the recipe is written in response. That was already permitted by
-- the nullable column; this comment records that it is deliberate rather than
-- an oversight, since the UI now depends on it.
comment on column public.cooking_sessions.recipe_id is
  'Null until the cook has settled on a dish. A session can start empty and be filled in by plan_recipe.';
