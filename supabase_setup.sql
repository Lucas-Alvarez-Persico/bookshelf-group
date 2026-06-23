-- =====================================================================
-- Quesosquad Bookshelf — setup de Supabase
-- Correr UNA vez en: Supabase → SQL Editor → New query → pegar → Run
-- Es idempotente (se puede volver a correr sin romper nada).
-- Modelo elegido: "panel 100% abierto" (la anon key puede escribir).
-- =====================================================================

-- 1) FILAS BASE que faltan (esto es lo que rompe la app al iniciar sesión)
insert into app_settings (id, member_count, voting_round) values (1, 4, 1)
  on conflict (id) do nothing;
insert into current_reading (id) values (1) on conflict (id) do nothing;

-- 2) COLUMNAS nuevas (descripción + rutas de archivos)
alter table candidates      add column if not exists description text;
alter table candidates      add column if not exists pdf_url     text;
alter table candidates      add column if not exists epub_url    text;
alter table current_reading add column if not exists description text;
alter table history         add column if not exists description text;
alter table history         add column if not exists pdf_url     text;
alter table history         add column if not exists epub_url    text;

-- 3) BUCKET de tapas (público) + políticas de storage abiertas
insert into storage.buckets (id, name, public) values ('covers','covers', true)
  on conflict (id) do nothing;
drop policy if exists "covers read"   on storage.objects;
drop policy if exists "covers write"  on storage.objects;
drop policy if exists "covers update" on storage.objects;
drop policy if exists "covers delete" on storage.objects;
create policy "covers read"   on storage.objects for select using (bucket_id='covers');
create policy "covers write"  on storage.objects for insert with check (bucket_id='covers');
create policy "covers update" on storage.objects for update using (bucket_id='covers');
create policy "covers delete" on storage.objects for delete using (bucket_id='covers');

-- 4) RLS de escritura ABIERTA en las tablas de datos (modelo "panel abierto")
drop policy if exists "open write" on candidates;
create policy "open write" on candidates      for all using (true) with check (true);
drop policy if exists "open write" on current_reading;
create policy "open write" on current_reading for all using (true) with check (true);
drop policy if exists "open write" on history;
create policy "open write" on history         for all using (true) with check (true);
drop policy if exists "open write" on app_settings;
create policy "open write" on app_settings    for all using (true) with check (true);

-- 5) RPCs admin recreadas SIN chequeo de rol (para que reiniciar votos / borrar
--    todo / borrar usuario funcionen en modo "panel abierto").
--    NO se toca tally_votes_if_complete (la lógica del ganador/desempate).
drop function if exists admin_reset_votes();
create function admin_reset_votes() returns void language sql security definer
  set search_path = public as $$
    delete from votes;
    update app_settings set runoff_candidate_ids = null, voting_round = 1 where id = 1;
  $$;

drop function if exists admin_wipe_all();
create function admin_wipe_all() returns void language sql security definer
  set search_path = public as $$
    delete from votes; delete from candidates; delete from history;
    update current_reading set title=null, cover_url=null, description=null,
      read_date=null, chapters=null, pdf_url=null, epub_url=null where id=1;
    update app_settings set runoff_candidate_ids=null, voting_round=1 where id=1;
  $$;

drop function if exists admin_delete_user(uuid);
create function admin_delete_user(target_id uuid) returns void language plpgsql
  security definer set search_path = public as $$
  begin
    delete from public.profiles where id = target_id;
    delete from auth.users where id = target_id;
  end; $$;

grant execute on function admin_reset_votes(), admin_wipe_all(), admin_delete_user(uuid)
  to anon, authenticated;
