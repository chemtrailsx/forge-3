-- ---------------------------------------------------------------------------
-- Cooking Companion — Row Level Security.
--
-- This is the last line of defence, not the only one: the server layer also
-- filters every query by the authenticated user id. But RLS is the one that
-- holds even if application code is wrong, so every user-owned table is
-- force-enabled and every policy is written against auth.uid().
--
-- Note `force row level security`: without it, the table owner (and anything
-- connecting as it) would bypass these policies.
-- ---------------------------------------------------------------------------

alter table public.profiles            enable row level security;
alter table public.recipes             enable row level security;
alter table public.cooking_sessions    enable row level security;
alter table public.user_memory         enable row level security;
alter table public.timers              enable row level security;
alter table public.conversation_turns  enable row level security;

alter table public.profiles            force row level security;
alter table public.recipes             force row level security;
alter table public.cooking_sessions    force row level security;
alter table public.user_memory         force row level security;
alter table public.timers              force row level security;
alter table public.conversation_turns  force row level security;

-- profiles: the row is keyed by the auth user id itself.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated using (auth.uid() = id);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists profiles_delete_own on public.profiles;
create policy profiles_delete_own on public.profiles
  for delete to authenticated using (auth.uid() = id);

-- The remaining tables all key on user_id. The `with check` clause on
-- insert/update is what stops a client from writing a row that belongs to
-- somebody else.
do $do$
declare t text;
begin
  foreach t in array array['recipes', 'cooking_sessions', 'user_memory', 'timers', 'conversation_turns'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (auth.uid() = user_id)',
      t || '_select_own', t
    );

    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (auth.uid() = user_id)',
      t || '_insert_own', t
    );

    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      t || '_update_own', t
    );

    execute format('drop policy if exists %I on public.%I', t || '_delete_own', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (auth.uid() = user_id)',
      t || '_delete_own', t
    );
  end loop;
end;
$do$;

-- A cooking session may only point at a recipe the same user owns. RLS covers
-- reads; this trigger covers the write side, where a crafted recipe_id would
-- otherwise create a cross-user reference.
create or replace function public.assert_recipe_ownership()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.recipe_id is not null
     and not exists (
       select 1 from public.recipes r
       where r.id = new.recipe_id and r.user_id = new.user_id
     )
  then
    raise exception 'recipe % does not belong to user %', new.recipe_id, new.user_id
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

drop trigger if exists cooking_sessions_recipe_ownership on public.cooking_sessions;
create trigger cooking_sessions_recipe_ownership
  before insert or update of recipe_id, user_id on public.cooking_sessions
  for each row execute function public.assert_recipe_ownership();

-- Same guard for the child rows of a session.
create or replace function public.assert_session_ownership()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.session_id is not null
     and not exists (
       select 1 from public.cooking_sessions s
       where s.id = new.session_id and s.user_id = new.user_id
     )
  then
    raise exception 'session % does not belong to user %', new.session_id, new.user_id
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

drop trigger if exists timers_session_ownership on public.timers;
create trigger timers_session_ownership
  before insert or update of session_id, user_id on public.timers
  for each row execute function public.assert_session_ownership();

drop trigger if exists conversation_turns_session_ownership on public.conversation_turns;
create trigger conversation_turns_session_ownership
  before insert or update of session_id, user_id on public.conversation_turns
  for each row execute function public.assert_session_ownership();

-- New-user bootstrap: create the profile row and seed one starter recipe so a
-- brand-new account can start cooking by voice immediately. Runs as definer
-- because auth.users triggers execute outside the new user's RLS context.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(coalesce(new.email, ''), '@', 1))
  on conflict (id) do nothing;

  insert into public.recipes (user_id, title, servings, source, ingredients, steps)
  values (
    new.id,
    'Weeknight Garlic Butter Pasta',
    2,
    'starter',
    '[
      {"name": "spaghetti",        "quantity": 200, "unit": "g"},
      {"name": "salted butter",    "quantity": 40,  "unit": "g"},
      {"name": "garlic",           "quantity": 3,   "unit": "cloves", "note": "thinly sliced"},
      {"name": "chilli flakes",    "quantity": 0.5, "unit": "tsp"},
      {"name": "parmesan",         "quantity": 30,  "unit": "g", "note": "finely grated"},
      {"name": "flat-leaf parsley","quantity": 10,  "unit": "g", "note": "chopped"},
      {"name": "salt",             "quantity": null, "unit": null, "note": "for the pasta water"},
      {"name": "black pepper",     "quantity": null, "unit": null}
    ]'::jsonb,
    '[
      "Bring a large pan of water to a rolling boil and salt it well.",
      "Add the spaghetti and cook for eight minutes, stirring once at the start.",
      "While the pasta cooks, melt the butter in a wide pan over low heat.",
      "Add the sliced garlic and chilli flakes and cook gently for two minutes until fragrant, not browned.",
      "Reserve a mug of pasta water, then drain the spaghetti.",
      "Toss the pasta through the garlic butter with a splash of the reserved water until glossy.",
      "Off the heat, stir in the parmesan and parsley, then season with black pepper and serve."
    ]'::jsonb
  );

  return new;
end;
$fn$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
