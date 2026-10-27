-- Gemeinsame Standard-Übungsbibliothek fuer alle Mannschaften
--
-- * Eine einzige Zeile (id = 1) mit der Bibliothek als JSON und einem Versionszaehler wie bei team_docs.
-- * Unverschluesselt: enthaelt nur Uebungen (Texte, Bilder, Video-Links), keine Spielerdaten.
-- * Lesen duerfen alle (auch ohne Anmeldung), schreiben nur Master (app_admins).
-- * Mannschaftseigene Uebungen und deaktivierte Standarduebungen liegen weiterhin verschluesselt
--   im Mannschaftsdokument (team_docs).

create table public.std_library (
  id int primary key default 1 check (id = 1),
  rev bigint not null check (rev > 0),
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
alter table public.std_library enable row level security;
create policy "alle lesen" on public.std_library for select to anon, authenticated using (true);
create policy "Master legt an" on public.std_library for insert to authenticated
  with check (public.is_master() and rev = 1);
create policy "Master aendert" on public.std_library for update to authenticated
  using (public.is_master()) with check (public.is_master());
revoke all on public.std_library from anon, authenticated;
grant select on public.std_library to anon, authenticated;
grant insert, update on public.std_library to authenticated;

-- Versionszaehler: jede Aenderung genau +1, damit gleichzeitige Aenderungen als Konflikt erkannt werden
create or replace function public.std_library_bump() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.rev <> old.rev + 1 then
    raise exception 'Versionskonflikt' using errcode = '40001';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
create trigger std_library_bump before update on public.std_library
  for each row execute function public.std_library_bump();
revoke execute on function public.std_library_bump from public, anon, authenticated;
