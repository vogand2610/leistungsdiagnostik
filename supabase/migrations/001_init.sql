-- Leistungsdiagnostik: Mannschaften, Mitglieder, Daten-Dokumente, Spielerinnen-Freigaben
--
-- Grundsaetze
-- * Die Daten einer Mannschaft liegen als EIN Dokument (team_docs.payload) vor, im Browser mit dem
--   Mannschaftspasswort verschluesselt (AES-GCM). Der Server sieht keinen Klartext.
-- * Nur Master (Tabelle app_admins) legen Mannschaften an.
-- * Andere verbinden sich mit Mannschaftsname + Passwort (anonyme Anmeldung). Der Server prueft dabei
--   nur einen aus dem Passwort abgeleiteten Nachweis (PBKDF2 im Browser, hier zusaetzlich bcrypt).
-- * Spielerinnen sehen ueber einen Code nur ihre eigene Freigabe (player_shares), verschluesselt mit
--   einem aus dem Code abgeleiteten Schluessel. Abruf nur ueber get_player_share().

create extension if not exists pgcrypto with schema extensions;

-- ---------- Master ----------
create table public.app_admins (
  user_id uuid primary key references auth.users on delete cascade
);
alter table public.app_admins enable row level security;
create policy "eigener Eintrag" on public.app_admins for select to authenticated using (user_id = (select auth.uid()));

create or replace function public.is_master() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins where user_id = auth.uid());
$$;

-- ---------- Mannschaften ----------
create table public.teams (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{4,64}$'),
  name text not null check (length(btrim(name)) between 2 and 80),
  join_hash text not null,
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now()
);
create unique index teams_name_key on public.teams (lower(btrim(name)));
alter table public.teams enable row level security;

create table public.team_members (
  team_id text not null references public.teams on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role text not null check (role in ('owner', 'trainer')),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
alter table public.team_members enable row level security;

create or replace function public.team_role(p_team text) returns text
language sql stable security definer set search_path = '' as $$
  select role from public.team_members where team_id = p_team and user_id = auth.uid();
$$;

create policy "Mitglieder lesen" on public.teams for select to authenticated
  using (public.team_role(id) is not null);
create policy "Owner loescht" on public.teams for delete to authenticated
  using (public.team_role(id) = 'owner');

create policy "eigene und Owner" on public.team_members for select to authenticated
  using (user_id = (select auth.uid()) or public.team_role(team_id) = 'owner');
create policy "austreten oder Owner entfernt" on public.team_members for delete to authenticated
  using (user_id = (select auth.uid()) or (public.team_role(team_id) = 'owner' and role <> 'owner'));

-- join_hash nie ausliefern, Schreiben nur ueber die Funktionen unten
revoke all on public.teams from anon, authenticated;
grant select (id, name, created_by, created_at), delete on public.teams to authenticated;
revoke all on public.team_members from anon, authenticated;
grant select, delete on public.team_members to authenticated;
revoke all on public.app_admins from anon, authenticated;
grant select on public.app_admins to authenticated;

-- ---------- Daten-Dokument je Mannschaft ----------
create table public.team_docs (
  team_id text primary key references public.teams on delete cascade,
  rev bigint not null check (rev > 0),
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
alter table public.team_docs enable row level security;
create policy "Mitglieder lesen" on public.team_docs for select to authenticated
  using (public.team_role(team_id) is not null);
create policy "Mitglieder legen an" on public.team_docs for insert to authenticated
  with check (public.team_role(team_id) is not null and rev = 1);
create policy "Mitglieder aendern" on public.team_docs for update to authenticated
  using (public.team_role(team_id) is not null) with check (public.team_role(team_id) is not null);
revoke all on public.team_docs from anon, authenticated;
grant select, insert, update on public.team_docs to authenticated;

-- Versionszaehler: jede Aenderung genau +1, damit gleichzeitige Aenderungen als Konflikt erkannt werden
create or replace function public.team_docs_bump() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.rev <> old.rev + 1 then
    raise exception 'Versionskonflikt' using errcode = '40001';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
create trigger team_docs_bump before update on public.team_docs
  for each row execute function public.team_docs_bump();

-- ---------- Freigaben fuer Spielerinnen ----------
create table public.player_shares (
  lookup text primary key check (lookup ~ '^[0-9a-f]{64}$'),
  team_id text not null references public.teams on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create index player_shares_team on public.player_shares (team_id);
alter table public.player_shares enable row level security;
create policy "Mitglieder verwalten" on public.player_shares for all to authenticated
  using (public.team_role(team_id) is not null) with check (public.team_role(team_id) is not null);
revoke all on public.player_shares from anon, authenticated;
grant select, insert, update, delete on public.player_shares to authenticated;

-- Abruf durch Spielerinnen ohne Anmeldung: nur mit exaktem Lookup (SHA-256 des Codes)
create or replace function public.get_player_share(p_lookup text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select data from public.player_shares where lookup = p_lookup;
$$;

-- ---------- Funktionen fuer Anlegen und Verbinden ----------
create table public.join_attempts (
  team_id text not null references public.teams on delete cascade,
  at timestamptz not null default now()
);
create index join_attempts_team_at on public.join_attempts (team_id, at);
alter table public.join_attempts enable row level security;
revoke all on public.join_attempts from anon, authenticated;

create or replace function public.create_team(p_id text, p_name text, p_proof text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_master() then
    raise exception 'Nur Master duerfen Mannschaften anlegen' using errcode = '42501';
  end if;
  if length(p_proof) < 32 then
    raise exception 'Ungueltiger Nachweis';
  end if;
  insert into public.teams (id, name, join_hash, created_by)
    values (p_id, btrim(p_name), extensions.crypt(p_proof, extensions.gen_salt('bf', 10)), auth.uid());
  insert into public.team_members (team_id, user_id, role) values (p_id, auth.uid(), 'owner');
  return p_id;
end $$;

-- Liefert {ok, team_id, name, role} oder {ok:false, reason}. Fehlversuche werden je Mannschaft gebremst.
create or replace function public.join_team(p_name text, p_proof text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.teams;
  r text;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'login');
  end if;
  select * into t from public.teams where lower(btrim(name)) = lower(btrim(p_name));
  if not found then
    perform pg_sleep(0.5);
    return jsonb_build_object('ok', false, 'reason', 'falsch');
  end if;
  if (select count(*) from public.join_attempts where team_id = t.id and at > now() - interval '15 minutes') >= 20 then
    return jsonb_build_object('ok', false, 'reason', 'gesperrt');
  end if;
  if extensions.crypt(p_proof, t.join_hash) <> t.join_hash then
    insert into public.join_attempts (team_id) values (t.id);
    return jsonb_build_object('ok', false, 'reason', 'falsch');
  end if;
  insert into public.team_members (team_id, user_id, role) values (t.id, auth.uid(), 'trainer')
    on conflict (team_id, user_id) do nothing;
  select role into r from public.team_members where team_id = t.id and user_id = auth.uid();
  return jsonb_build_object('ok', true, 'team_id', t.id, 'name', t.name, 'role', r);
end $$;

-- Neues Mannschaftspasswort (nur Owner). Bestehende Mitglieder bleiben verbunden, brauchen zum
-- Entschluesseln aber das neue Passwort.
create or replace function public.set_team_secret(p_team text, p_proof text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.team_role(p_team) is distinct from 'owner' then
    raise exception 'Nur der Owner darf das Passwort aendern' using errcode = '42501';
  end if;
  if length(p_proof) < 32 then
    raise exception 'Ungueltiger Nachweis';
  end if;
  update public.teams set join_hash = extensions.crypt(p_proof, extensions.gen_salt('bf', 10)) where id = p_team;
end $$;

-- Supabase vergibt EXECUTE standardmaessig direkt an anon/authenticated, daher explizit entziehen
revoke execute on function public.is_master, public.team_role, public.get_player_share,
  public.create_team, public.join_team, public.set_team_secret, public.team_docs_bump
  from public, anon, authenticated;
grant execute on function public.is_master, public.team_role, public.create_team, public.join_team,
  public.set_team_secret to authenticated;
grant execute on function public.get_player_share to anon, authenticated;
