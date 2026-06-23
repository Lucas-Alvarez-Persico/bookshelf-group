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

-- 5) RPCs admin SIN chequeo de rol (panel abierto). Todos los DELETE llevan WHERE
--    porque la base bloquea borrados masivos sin filtro.
drop function if exists admin_reset_votes();
create function admin_reset_votes() returns void language sql security definer
  set search_path = public as $$
    delete from votes where id is not null;
    update app_settings set runoff_candidate_ids = null, voting_round = 1 where id = 1;
  $$;

drop function if exists admin_wipe_all();
create function admin_wipe_all() returns void language sql security definer
  set search_path = public as $$
    delete from votes      where id is not null;
    delete from candidates where id is not null;
    delete from history    where id is not null;
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

-- 6) CONTEO / CIERRE DE VOTACIÓN (reemplaza tally_votes_if_complete)
--    Arregla "DELETE requires a WHERE clause" y, al haber ganador, copia TODOS
--    los datos del libro (descripción, tapa, pdf, epub) a current_reading.
drop function if exists tally_votes_if_complete();
create function tally_votes_if_complete()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_round   int;
  v_members int;
  v_runoff  uuid[];
  v_total   int;
  v_max     int;
  v_winners uuid[];
  v_win     candidates%rowtype;
begin
  select voting_round, member_count, runoff_candidate_ids
    into v_round, v_members, v_runoff
    from app_settings where id = 1;

  -- totales del pool (candidatos de desempate si hay, si no todos) en la ronda actual
  with pool as (
    select id from candidates where v_runoff is null or id = any(v_runoff)
  ), counts as (
    select c.id, count(v.id) n
      from pool c
      left join votes v on v.candidate_id = c.id and v.voting_round = v_round
     group by c.id
  )
  select coalesce(sum(n),0)::int, coalesce(max(n),0)::int
    into v_total, v_max from counts;

  if v_members < 1 or v_total < v_members then
    return jsonb_build_object('status','pending');
  end if;

  -- ganadores (mayor cantidad de votos, > 0)
  with pool as (
    select id from candidates where v_runoff is null or id = any(v_runoff)
  ), counts as (
    select c.id, count(v.id) n
      from pool c
      left join votes v on v.candidate_id = c.id and v.voting_round = v_round
     group by c.id
  )
  select array_agg(id) into v_winners from counts where n = v_max and v_max > 0;

  if v_winners is null then
    return jsonb_build_object('status','pending');
  end if;

  -- empate -> nueva ronda de desempate entre los igualados
  if array_length(v_winners,1) > 1 then
    update app_settings
       set runoff_candidate_ids = v_winners, voting_round = v_round + 1
     where id = 1;
    return jsonb_build_object('status','runoff');
  end if;

  -- ganador único -> pasa a "libro en lectura" con todos sus datos
  select * into v_win from candidates where id = v_winners[1];
  update current_reading
     set title = v_win.title, cover_url = v_win.cover_url,
         description = v_win.description, pdf_url = v_win.pdf_url,
         epub_url = v_win.epub_url, read_date = null, chapters = null
   where id = 1;

  -- limpiar para el próximo ciclo (con WHERE, por el bloqueo de borrado masivo)
  delete from votes      where id is not null;
  delete from candidates where id is not null;
  update app_settings set runoff_candidate_ids = null, voting_round = 1 where id = 1;

  return jsonb_build_object('status','winner','title', v_win.title);
end; $$;
grant execute on function tally_votes_if_complete() to anon, authenticated;
