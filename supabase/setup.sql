-- Blaze Form Tracker: database setup
-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run

-- 1. The table: one row per finished workout
create table public.workouts (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 1 and 20),
  reps integer not null check (reps between 1 and 500),
  good_reps integer not null check (good_reps between 0 and reps),
  form_score integer not null check (form_score between 0 and 100),
  created_at timestamptz not null default now() -- set by the server, not the browser
);

-- 2. Turn on Row Level Security: with no policies, nobody can do anything
alter table public.workouts enable row level security;

-- 3. Least privilege: remove default permissions, then add back only what's needed
revoke all on public.workouts from anon, authenticated;
grant insert on public.workouts to anon;          -- the app can add workouts
grant select on public.workouts to authenticated; -- only the logged-in leader can read

-- 4. Policies (which rows each role may touch)
create policy "Anyone can add a workout"
  on public.workouts for insert
  to anon
  with check (true);

create policy "Logged-in leader can read workouts"
  on public.workouts for select
  to authenticated
  using (true);

-- 5. Auto-delete: every night at 03:00 UTC, remove workouts older than 3 days
create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'delete-old-workouts',
  '0 3 * * *',
  $$ delete from public.workouts where created_at < now() - interval '3 days' $$
);
