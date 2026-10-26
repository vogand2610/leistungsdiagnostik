-- Mannschaft umbenennen (nur Owner)
--
-- Der Nachweis beim Verbinden wird im Browser aus Passwort UND Mannschaftsname abgeleitet. Deshalb
-- kommt mit dem neuen Namen immer auch ein neu berechneter Nachweis; Name und join_hash werden
-- gemeinsam ersetzt. Bestehende Mitglieder bleiben verbunden.

create or replace function public.rename_team(p_team text, p_name text, p_proof text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.team_role(p_team) is distinct from 'owner' then
    raise exception 'Nur der Owner darf die Mannschaft umbenennen' using errcode = '42501';
  end if;
  if length(p_proof) < 32 then
    raise exception 'Ungueltiger Nachweis';
  end if;
  update public.teams
    set name = btrim(p_name), join_hash = extensions.crypt(p_proof, extensions.gen_salt('bf', 10))
    where id = p_team;
end $$;

revoke execute on function public.rename_team from public, anon, authenticated;
grant execute on function public.rename_team to authenticated;
