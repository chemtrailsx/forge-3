-- ---------------------------------------------------------------------------
-- Cooking Companion — core schema.
--
-- Every user-owned table carries `user_id references auth.users(id)`. That
-- column is the single axis of authorization: RLS (0002) compares it to
-- auth.uid(), and the server layer additionally filters on it. A user_id sent
-- by the browser is never used for authorization anywhere.
-- ---------------------------------------------------------------------------

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- profiles -------------------------------------------------------------------
-- One row per auth user. `preferences` holds durable, structured settings the
-- user states out loud ("I usually cook for four").
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  preferences  jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- recipes --------------------------------------------------------------------
-- ingredients: [{ "name": text, "quantity": number|null, "unit": text|null, "note": text|null }]
-- steps:       [text, ...]
create table if not exists public.recipes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 200),
  ingredients jsonb not null default '[]'::jsonb,
  steps       jsonb not null default '[]'::jsonb,
  servings    integer not null default 2 check (servings between 1 and 50),
  is_favorite boolean not null default false,
  source      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists recipes_user_created_idx on public.recipes (user_id, created_at desc);
create index if not exists recipes_user_favorite_idx on public.recipes (user_id, is_favorite) where is_favorite;
-- Recipe search is "find my usual pasta recipe" — always scoped to one user,
-- so the trigram index only has to rank within the rows RLS already allows.
create index if not exists recipes_title_trgm_idx on public.recipes using gin (title gin_trgm_ops);

-- cooking_sessions -----------------------------------------------------------
-- The live cooking state. `notes` carries the session-scoped, free-form parts
-- of that state: servings override, accepted substitutions, and the recent
-- corrections used for interruption recovery.
create table if not exists public.cooking_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  recipe_id    uuid references public.recipes (id) on delete set null,
  current_step integer not null default 0 check (current_step >= 0),
  status       text not null default 'active' check (status in ('active', 'paused', 'finished')),
  notes        jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists cooking_sessions_user_created_idx on public.cooking_sessions (user_id, created_at desc);
create index if not exists cooking_sessions_user_recipe_idx on public.cooking_sessions (user_id, recipe_id);
create index if not exists cooking_sessions_user_active_idx on public.cooking_sessions (user_id, updated_at desc) where status = 'active';

-- user_memory ----------------------------------------------------------------
-- Durable, user-inspectable facts. One row per key, so the user can delete a
-- single memory rather than a blob. `kind` separates stated preferences from
-- observations so retrieval can prioritise.
create table if not exists public.user_memory (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  key        text not null check (char_length(key) between 1 and 120),
  value      text not null check (char_length(value) between 1 and 2000),
  kind       text not null default 'preference' check (kind in ('preference', 'avoidance', 'note', 'observation')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, key)
);

create index if not exists user_memory_user_updated_idx on public.user_memory (user_id, updated_at desc);
create index if not exists user_memory_key_trgm_idx on public.user_memory using gin (key gin_trgm_ops);

-- timers ---------------------------------------------------------------------
-- Timers are persisted rather than held in browser memory: a cook who reloads
-- the page (or answers the door) must not lose the pasta.
create table if not exists public.timers (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  session_id  uuid references public.cooking_sessions (id) on delete cascade,
  label       text not null default 'timer',
  duration_ms integer not null check (duration_ms between 1000 and 86400000),
  started_at  timestamptz not null default now(),
  status      text not null default 'running' check (status in ('running', 'cancelled', 'completed')),
  created_at  timestamptz not null default now()
);

create index if not exists timers_user_status_idx on public.timers (user_id, status);
create index if not exists timers_session_idx on public.timers (session_id, status);

-- conversation_turns ---------------------------------------------------------
-- Conversation history, per session.
--
-- `heard_text` is the load-bearing column for barge-in. When the user
-- interrupts, the assistant row keeps what it *intended* to say in `text`, but
-- history rebuilding uses `heard_text` — the words that actually reached the
-- speaker — so the model never refers back to something the user never heard.
create table if not exists public.conversation_turns (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  session_id  uuid not null references public.cooking_sessions (id) on delete cascade,
  turn_index  integer not null,
  role        text not null check (role in ('user', 'assistant')),
  text        text not null default '',
  heard_text  text,
  interrupted boolean not null default false,
  metrics     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (session_id, turn_index, role)
);

create index if not exists conversation_turns_session_idx on public.conversation_turns (session_id, turn_index desc);
create index if not exists conversation_turns_user_idx on public.conversation_turns (user_id, created_at desc);

-- updated_at maintenance -----------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

do $do$
declare t text;
begin
  foreach t in array array['profiles', 'recipes', 'cooking_sessions', 'user_memory'] loop
    execute format(
      'drop trigger if exists %I on public.%I',
      t || '_touch', t
    );
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.touch_updated_at()',
      t || '_touch', t
    );
  end loop;
end;
$do$;
