-- DomesticInventory initial schema. Run once in the Supabase SQL Editor.
-- Auth sign-ups should be disabled in Supabase; add allowed users to
-- public.inventory_members from the SQL Editor using their Auth user UUID.
begin;

create table if not exists public.inventories (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Ma maison' check (char_length(trim(name)) between 1 and 100),
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_members (
  inventory_id uuid not null references public.inventories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('admin','member')),
  added_at timestamptz not null default now(),
  primary key (inventory_id, user_id)
);

create table if not exists public.inventory_devices (
  inventory_id uuid not null references public.inventories(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 120),
  room text not null check (char_length(trim(room)) between 1 and 80),
  brand text not null default '' check (char_length(brand) <= 100),
  model text not null default '' check (char_length(model) <= 120),
  serial_number text not null default '' check (char_length(serial_number) <= 120),
  purchase_date date,
  warranty_end_date date,
  notes text not null default '' check (char_length(notes) <= 5000),
  photo_path text,
  updated_at timestamptz not null default now(),
  primary key (inventory_id, id)
);

create table if not exists public.inventory_documents (
  inventory_id uuid not null,
  id uuid not null default gen_random_uuid(),
  device_id uuid not null,
  kind text not null default 'manual' check (kind in ('manual','invoice','warranty','other')),
  file_name text not null check (char_length(trim(file_name)) between 1 and 255),
  storage_path text not null,
  mime_type text not null default 'application/pdf' check (mime_type = 'application/pdf'),
  byte_size bigint not null check (byte_size between 1 and 20971520),
  created_at timestamptz not null default now(),
  primary key (inventory_id, id),
  foreign key (inventory_id, device_id)
    references public.inventory_devices(inventory_id, id) on delete cascade,
  unique (storage_path),
  check (storage_path like inventory_id::text || '/%')
);

-- Stable ID used by the web client. The inventory is inaccessible until
-- authorized Auth users are added to inventory_members below.
insert into public.inventories (id, name)
values ('a5a7cb0e-2496-4aed-9f2e-70c80a823511', 'Ma maison')
on conflict (id) do nothing;

alter table public.inventories enable row level security;
alter table public.inventory_members enable row level security;
alter table public.inventory_devices enable row level security;
alter table public.inventory_documents enable row level security;

revoke all on public.inventories, public.inventory_members,
  public.inventory_devices, public.inventory_documents from public, anon, authenticated;
grant select on public.inventories, public.inventory_members,
  public.inventory_devices, public.inventory_documents to authenticated;

drop policy if exists inventory_member_read_inventories on public.inventories;
create policy inventory_member_read_inventories on public.inventories
  for select to authenticated using (
    exists (select 1 from public.inventory_members m
      where m.inventory_id = inventories.id and m.user_id = (select auth.uid()))
  );
drop policy if exists inventory_member_read_members on public.inventory_members;
create policy inventory_member_read_members on public.inventory_members
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists inventory_member_read_devices on public.inventory_devices;
create policy inventory_member_read_devices on public.inventory_devices
  for select to authenticated using (
    exists (select 1 from public.inventory_members m
      where m.inventory_id = inventory_devices.inventory_id and m.user_id = (select auth.uid()))
  );
drop policy if exists inventory_member_read_documents on public.inventory_documents;
create policy inventory_member_read_documents on public.inventory_documents
  for select to authenticated using (
    exists (select 1 from public.inventory_members m
      where m.inventory_id = inventory_documents.inventory_id and m.user_id = (select auth.uid()))
  );

create or replace function public.inventory_read(inventory uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from public.inventory_members m
      where m.inventory_id = inventory and m.user_id = auth.uid()
  ) then
    raise exception 'Inventory access denied' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'revision', i.revision,
    'state', jsonb_build_object(
      'version', 1,
      'devices', coalesce((select jsonb_agg(jsonb_build_object(
        'id', d.id, 'name', d.name, 'room', d.room, 'brand', d.brand,
        'model', d.model, 'serialNumber', d.serial_number,
        'purchaseDate', d.purchase_date, 'warrantyEndDate', d.warranty_end_date,
        'notes', d.notes, 'photoPath', d.photo_path, 'updatedAt', d.updated_at
      ) order by d.name, d.id) from public.inventory_devices d where d.inventory_id = i.id), '[]'::jsonb),
      'documents', coalesce((select jsonb_agg(jsonb_build_object(
        'id', f.id, 'deviceId', f.device_id, 'kind', f.kind,
        'fileName', f.file_name, 'storagePath', f.storage_path,
        'mimeType', f.mime_type, 'byteSize', f.byte_size, 'createdAt', f.created_at
      ) order by f.created_at, f.id) from public.inventory_documents f where f.inventory_id = i.id), '[]'::jsonb)
    )
  ) into result from public.inventories i where i.id = inventory;
  if result is null then
    raise exception 'Inventory access denied' using errcode = '42501';
  end if;
  return result;
end;
$$;

create or replace function public.inventory_save(inventory uuid, expected_revision bigint, new_state jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare current_revision bigint; entry jsonb; device_uuid uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  perform 1 from public.inventory_members m
    where m.inventory_id = inventory and m.user_id = auth.uid() for share;
  if not found then
    raise exception 'Inventory access denied' using errcode = '42501';
  end if;
  select i.revision into current_revision from public.inventories i
    where i.id = inventory for update;
  if not found then
    raise exception 'Inventory access denied' using errcode = '42501';
  end if;
  if expected_revision is null or expected_revision <> current_revision then
    raise exception 'Inventory changed concurrently' using errcode = '40001';
  end if;
  if jsonb_typeof(new_state) is distinct from 'object'
    or new_state->'version' is distinct from '1'::jsonb
    or jsonb_typeof(new_state->'devices') is distinct from 'array'
    or jsonb_typeof(new_state->'documents') is distinct from 'array' then
    raise exception 'Invalid inventory state' using errcode = '22023';
  end if;
  if jsonb_array_length(new_state->'devices') > 500
    or jsonb_array_length(new_state->'documents') > 2000 then
    raise exception 'Inventory is too large' using errcode = '22023';
  end if;

  delete from public.inventory_documents where inventory_id = inventory;
  delete from public.inventory_devices where inventory_id = inventory;
  for entry in select value from jsonb_array_elements(new_state->'devices') loop
    device_uuid := (entry->>'id')::uuid;
    insert into public.inventory_devices (
      inventory_id, id, name, room, brand, model, serial_number, purchase_date,
      warranty_end_date, notes, photo_path, updated_at
    ) values (
      inventory, device_uuid, entry->>'name', entry->>'room',
      coalesce(entry->>'brand',''), coalesce(entry->>'model',''),
      coalesce(entry->>'serialNumber',''), nullif(entry->>'purchaseDate','')::date,
      nullif(entry->>'warrantyEndDate','')::date, coalesce(entry->>'notes',''),
      nullif(entry->>'photoPath',''), coalesce(nullif(entry->>'updatedAt','')::timestamptz, now())
    );
  end loop;
  for entry in select value from jsonb_array_elements(new_state->'documents') loop
    insert into public.inventory_documents (
      inventory_id, id, device_id, kind, file_name, storage_path, mime_type, byte_size, created_at
    ) values (
      inventory, (entry->>'id')::uuid, (entry->>'deviceId')::uuid,
      coalesce(entry->>'kind','manual'), entry->>'fileName', entry->>'storagePath',
      coalesce(entry->>'mimeType','application/pdf'), (entry->>'byteSize')::bigint,
      coalesce(nullif(entry->>'createdAt','')::timestamptz, now())
    );
  end loop;
  update public.inventories set revision = revision + 1 where id = inventory
    returning revision into current_revision;
  return current_revision;
end;
$$;

-- Read only the signed-in user's existing Casa profile; this table is not used
-- as an access list because it can contain every Auth account.
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

revoke all on function public.inventory_read(uuid) from public, anon;
revoke all on function public.inventory_save(uuid, bigint, jsonb) from public, anon;
revoke all on function public.inventory_profile() from public, anon;
grant execute on function public.inventory_read(uuid) to authenticated;
grant execute on function public.inventory_save(uuid, bigint, jsonb) to authenticated;
grant execute on function public.inventory_profile() to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('domestic-inventory', 'domestic-inventory', false, 20971520, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 20971520,
  allowed_mime_types = array['application/pdf'];

drop policy if exists domestic_inventory_member_read on storage.objects;
create policy domestic_inventory_member_read on storage.objects
  for select to authenticated using (
    bucket_id = 'domestic-inventory' and exists (
      select 1 from public.inventory_members m
      where m.inventory_id::text = (storage.foldername(name))[1]
        and m.user_id = (select auth.uid())
    )
  );
drop policy if exists domestic_inventory_member_insert on storage.objects;
create policy domestic_inventory_member_insert on storage.objects
  for insert to authenticated with check (
    bucket_id = 'domestic-inventory' and exists (
      select 1 from public.inventory_members m
      where m.inventory_id::text = (storage.foldername(name))[1]
        and m.user_id = (select auth.uid())
    )
  );
drop policy if exists domestic_inventory_member_update on storage.objects;
create policy domestic_inventory_member_update on storage.objects
  for update to authenticated using (
    bucket_id = 'domestic-inventory' and exists (
      select 1 from public.inventory_members m
      where m.inventory_id::text = (storage.foldername(name))[1]
        and m.user_id = (select auth.uid())
    )
  ) with check (
    bucket_id = 'domestic-inventory' and exists (
      select 1 from public.inventory_members m
      where m.inventory_id::text = (storage.foldername(name))[1]
        and m.user_id = (select auth.uid())
    )
  );
drop policy if exists domestic_inventory_member_delete on storage.objects;
create policy domestic_inventory_member_delete on storage.objects
  for delete to authenticated using (
    bucket_id = 'domestic-inventory' and exists (
      select 1 from public.inventory_members m
      where m.inventory_id::text = (storage.foldername(name))[1]
        and m.user_id = (select auth.uid())
    )
  );

commit;
