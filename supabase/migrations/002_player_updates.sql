-- Aenderungen durch Spielerinnen (Geburtstag, Foto)
--
-- Die Spielerin verschluesselt ihre Aenderung im Browser mit dem Schluessel aus ihrem Code. Nur Geraete
-- des Trainerteams kennen den Code (er steht im verschluesselten Mannschaftsdokument), entschluesseln
-- die Aenderung beim naechsten Abgleich, uebernehmen sie und loeschen den Eintrag. Je Spielerin gibt es
-- hoechstens einen offenen Eintrag; ein neuer ersetzt den alten.

create table public.player_updates (
  lookup text primary key references public.player_shares on delete cascade,
  team_id text not null references public.teams on delete cascade,
  data jsonb not null,
  created_at timestamptz not null default now()
);
create index player_updates_team on public.player_updates (team_id);
alter table public.player_updates enable row level security;
create policy "Mitglieder lesen" on public.player_updates for select to authenticated
  using (public.team_role(team_id) is not null);
create policy "Mitglieder loeschen" on public.player_updates for delete to authenticated
  using (public.team_role(team_id) is not null);
revoke all on public.player_updates from anon, authenticated;
grant select, delete on public.player_updates to authenticated;

-- Abgabe durch die Spielerin ohne Anmeldung: nur mit exaktem Lookup einer bestehenden Freigabe
create or replace function public.submit_player_update(p_lookup text, p_data jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  t text;
begin
  if octet_length(p_data::text) > 300000 then
    raise exception 'Aenderung zu gross';
  end if;
  select team_id into t from public.player_shares where lookup = p_lookup;
  if not found then
    return false;
  end if;
  insert into public.player_updates (lookup, team_id, data) values (p_lookup, t, p_data)
    on conflict (lookup) do update set data = excluded.data, created_at = now();
  return true;
end $$;

revoke execute on function public.submit_player_update from public, anon, authenticated;
grant execute on function public.submit_player_update to anon, authenticated;
