create table if not exists public.app_settings (
  id boolean primary key default true check (id),
  submissions_open boolean not null default true,
  phase text not null default 'collecting' check (phase in ('collecting', 'voting', 'finished')),
  votes_per_person integer not null default 1 check (votes_per_person between 1 and 5),
  updated_at timestamptz not null default now()
);

insert into public.app_settings (id)
values (true)
on conflict (id) do nothing;

alter table public.app_settings
  drop constraint if exists app_settings_votes_per_person_check;
update public.app_settings
set votes_per_person = least(greatest(votes_per_person, 1), 5)
where id = true;
alter table public.app_settings
  add constraint app_settings_votes_per_person_check
  check (votes_per_person between 1 and 5);

create table if not exists public.movies (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  duration text check (duration is null or char_length(duration) <= 80),
  speed numeric(3, 2) not null default 1 check (speed in (1, 1.25)),
  created_at timestamptz not null default now()
);

create table if not exists public.ballots (
  id uuid primary key default gen_random_uuid(),
  voter_hash text not null unique check (char_length(voter_hash) = 64),
  created_at timestamptz not null default now()
);

create table if not exists public.votes (
  id uuid primary key default gen_random_uuid(),
  ballot_id uuid not null references public.ballots(id) on delete cascade,
  movie_id uuid not null references public.movies(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.votes
  drop constraint if exists votes_ballot_id_movie_id_key;

alter table public.app_settings enable row level security;
alter table public.movies enable row level security;
alter table public.ballots enable row level security;
alter table public.votes enable row level security;

create or replace function public.is_movie_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((auth.jwt() ->> 'email') = 'nfirc@nfirc.local', false);
$$;

revoke all on function public.is_movie_admin() from public, anon;
grant execute on function public.is_movie_admin() to authenticated;

drop policy if exists "Anyone can read settings" on public.app_settings;
create policy "Anyone can read settings"
  on public.app_settings for select
  to anon, authenticated
  using (true);

drop policy if exists "Admins can update settings" on public.app_settings;
create policy "Admins can update settings"
  on public.app_settings for update
  to authenticated
  using (public.is_movie_admin())
  with check (public.is_movie_admin());

drop policy if exists "Anyone can read movies" on public.movies;
create policy "Anyone can read movies"
  on public.movies for select
  to anon, authenticated
  using (true);

drop policy if exists "Users can submit while open" on public.movies;
create policy "Users can submit while open"
  on public.movies for insert
  to anon, authenticated
  with check (
    exists (
      select 1 from public.app_settings
      where id = true and submissions_open and phase = 'collecting'
    )
  );

drop policy if exists "Admins can manage movies" on public.movies;
drop policy if exists "Admins can update movies" on public.movies;
create policy "Admins can update movies"
  on public.movies for update
  to authenticated
  using (public.is_movie_admin())
  with check (public.is_movie_admin());

drop policy if exists "Admins can delete movies" on public.movies;
create policy "Admins can delete movies"
  on public.movies for delete
  to authenticated
  using (
    public.is_movie_admin()
    and exists (
      select 1 from public.app_settings
      where id = true and phase = 'collecting'
    )
  );

drop policy if exists "Users can read live results" on public.votes;
create policy "Users can read live results"
  on public.votes for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.app_settings
      where id = true and phase in ('voting', 'finished')
    )
  );

drop policy if exists "Admins can delete ballots" on public.ballots;
create policy "Admins can delete ballots"
  on public.ballots for delete
  to authenticated
  using (public.is_movie_admin());

grant select on public.app_settings to anon, authenticated;
grant update on public.app_settings to authenticated;
grant select, insert on public.movies to anon;
grant select, insert, update, delete on public.movies to authenticated;
grant select on public.votes to anon, authenticated;
grant delete on public.ballots to authenticated;
grant all on public.ballots, public.votes to service_role;

create or replace function public.admin_start_voting(p_votes_per_person integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  movie_count integer;
begin
  if not public.is_movie_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select count(*) into movie_count from public.movies;
  if movie_count = 0
     or p_votes_per_person is null
     or p_votes_per_person < 1
     or p_votes_per_person > 5 then
    raise exception 'invalid vote limit';
  end if;
  delete from public.ballots;
  update public.app_settings
  set phase = 'voting',
      submissions_open = false,
      votes_per_person = p_votes_per_person,
      updated_at = now()
  where id = true;
end;
$$;

create or replace function public.admin_finish_voting()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_movie_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.app_settings
  set phase = 'finished', submissions_open = false, updated_at = now()
  where id = true and phase = 'voting';
  if not found then
    raise exception 'voting is not active';
  end if;
end;
$$;

create or replace function public.admin_clear_all()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_movie_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  delete from public.ballots;
  delete from public.movies;
  update public.app_settings
  set submissions_open = true, phase = 'collecting', votes_per_person = 1, updated_at = now()
  where id = true;
end;
$$;

create or replace function public.cast_vote(p_voter_hash text, p_movie_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  active_settings public.app_settings%rowtype;
  new_ballot_id uuid;
  matching_movies integer;
begin
  select * into active_settings
  from public.app_settings
  where id = true
  for share;

  if active_settings.phase <> 'voting' then
    raise exception 'voting is not active';
  end if;
  if p_voter_hash is null or p_voter_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid voter identifier';
  end if;
  if p_movie_ids is null
     or cardinality(p_movie_ids) <> active_settings.votes_per_person then
    raise exception 'select exactly the allowed number of votes';
  end if;
  select count(*) into matching_movies from public.movies where id = any(p_movie_ids);
  if matching_movies <> (select count(distinct selected.movie_id) from unnest(p_movie_ids) as selected(movie_id)) then
    raise exception 'one or more selected movies are unavailable';
  end if;

  insert into public.ballots (voter_hash)
  values (p_voter_hash)
  returning id into new_ballot_id;

  insert into public.votes (ballot_id, movie_id)
  select new_ballot_id, selected.movie_id from unnest(p_movie_ids) as selected(movie_id);
end;
$$;

revoke all on function public.admin_start_voting(integer) from public, anon;
revoke all on function public.admin_finish_voting() from public, anon;
revoke all on function public.admin_clear_all() from public, anon;
revoke all on function public.cast_vote(text, uuid[]) from public, anon, authenticated;
grant execute on function public.admin_start_voting(integer) to authenticated;
grant execute on function public.admin_finish_voting() to authenticated;
grant execute on function public.admin_clear_all() to authenticated;
grant execute on function public.cast_vote(text, uuid[]) to service_role;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'movies'
  ) then
    alter publication supabase_realtime add table public.movies;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'app_settings'
  ) then
    alter publication supabase_realtime add table public.app_settings;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'votes'
  ) then
    alter publication supabase_realtime add table public.votes;
  end if;
end;
$$;

revoke all on table public.app_settings, public.movies, public.ballots, public.votes
  from anon, authenticated, service_role;
revoke all on function public.is_movie_admin() from public, anon, authenticated, service_role;
revoke all on function public.admin_start_voting(integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_finish_voting() from public, anon, authenticated, service_role;
revoke all on function public.admin_clear_all() from public, anon, authenticated, service_role;
revoke all on function public.cast_vote(text, uuid[]) from public, anon, authenticated, service_role;
