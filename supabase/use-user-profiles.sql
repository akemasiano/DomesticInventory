-- Follow-up for an installation that already ran domestic-inventory.sql.
-- Exposes only the current authenticated user's first name from Casa's existing
-- user_profiles table. This does not grant direct table access or inventory access.
begin;

create or replace function public.inventory_profile()
returns text language plpgsql security definer set search_path = '' as $$
declare profile_name text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select p.prenom into profile_name from public.user_profiles p where p.user_id = auth.uid();
  return profile_name;
end;
$$;

revoke all on function public.inventory_profile() from public, anon;
grant execute on function public.inventory_profile() to authenticated;

commit;
