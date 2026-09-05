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

-- 6-bis) NOMBRES EN LAS RESEÑAS
--    Para mostrar quién puso cada puntaje de quesitos hace falta que un miembro
--    logueado pueda leer el nombre de los demás perfiles (no solo el propio).
--    Sin esta policy la app muestra "Miembro" en vez del nombre.
drop policy if exists "profiles read all" on profiles;
create policy "profiles read all" on profiles for select to authenticated using (true);

-- 7) CONTEO / CIERRE DE VOTACIÓN (reemplaza tally_votes_if_complete)
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

-- =====================================================================
-- 8) HASTA 2 VOTOS POR PERSONA
--    Antes cada usuario tenía UN voto (unique user_id + voting_round).
--    Ahora puede votar 1 o 2 libros distintos en la misma ronda.
-- =====================================================================

-- 8.1) Sacar la restricción vieja "un voto por usuario y ronda"
do $$
declare r record;
begin
  -- constraints unique/pk exactamente sobre (user_id, voting_round)
  for r in
    select con.conname
      from pg_constraint con
      join pg_class     c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'votes'
       and con.contype in ('u','p')
       and (select array_agg(a.attname::text order by a.attname)
              from unnest(con.conkey) k
              join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k)
           = array['user_id','voting_round']
  loop
    execute format('alter table public.votes drop constraint %I', r.conname);
  end loop;

  -- índices unique sueltos sobre las mismas dos columnas
  for r in
    select i.relname
      from pg_index x
      join pg_class i on i.oid = x.indexrelid
      join pg_class t on t.oid = x.indrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public' and t.relname = 'votes'
       and x.indisunique and not x.indisprimary
       and (select array_agg(a.attname::text order by a.attname)
              from unnest(string_to_array(x.indkey::text, ' ')::int[]) k
              join pg_attribute a on a.attrelid = x.indrelid and a.attnum = k)
           = array['user_id','voting_round']
  loop
    execute format('drop index public.%I', r.relname);
  end loop;
end $$;

-- 8.2) Nueva regla: no se puede votar dos veces el mismo libro en la misma ronda
create unique index if not exists votes_user_round_candidate_uidx
  on public.votes (user_id, voting_round, candidate_id);

-- 8.3) Tope de votos por persona y ronda (2, y nunca todo el pool:
--      en un desempate entre 2 libros cada uno vota 1 solo).
drop function if exists votes_limit_per_user() cascade;
create function votes_limit_per_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_pool  int;
  v_limit int;
  v_used  int;
begin
  select case
           when s.runoff_candidate_ids is not null
             then coalesce(array_length(s.runoff_candidate_ids, 1), 0)
           else (select count(*)::int from candidates)
         end
    into v_pool
    from app_settings s where s.id = 1;

  v_limit := greatest(1, least(2, coalesce(v_pool, 0) - 1));

  select count(*) into v_used
    from votes
   where user_id = new.user_id
     and voting_round = new.voting_round
     and id is distinct from new.id;

  if v_used >= v_limit then
    raise exception 'Máximo % voto(s) por persona en esta ronda', v_limit
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists votes_limit_per_user_trg on public.votes;
create trigger votes_limit_per_user_trg
  before insert or update on public.votes
  for each row execute function votes_limit_per_user();

-- 8.4) El cierre de la votación ahora mira PERSONAS que votaron, no votos totales
--      (cada una puede haber puesto 1 o 2). El resto es igual que antes.
drop function if exists tally_votes_if_complete();
create function tally_votes_if_complete()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_round   int;
  v_members int;
  v_runoff  uuid[];
  v_voters  int;
  v_max     int;
  v_winners uuid[];
  v_win     candidates%rowtype;
begin
  select voting_round, member_count, runoff_candidate_ids
    into v_round, v_members, v_runoff
    from app_settings where id = 1;

  -- personas distintas que votaron en la ronda actual dentro del pool
  select count(distinct v.user_id)::int into v_voters
    from votes v
   where v.voting_round = v_round
     and (v_runoff is null or v.candidate_id = any(v_runoff))
     and exists (select 1 from candidates c where c.id = v.candidate_id);

  if v_members < 1 or v_voters < v_members then
    return jsonb_build_object('status','pending');
  end if;

  with pool as (
    select id from candidates where v_runoff is null or id = any(v_runoff)
  ), counts as (
    select c.id, count(v.id) n
      from pool c
      left join votes v on v.candidate_id = c.id and v.voting_round = v_round
     group by c.id
  )
  select coalesce(max(n),0)::int into v_max from counts;

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

  delete from votes      where id is not null;
  delete from candidates where id is not null;
  update app_settings set runoff_candidate_ids = null, voting_round = 1 where id = 1;

  return jsonb_build_object('status','winner','title', v_win.title);
end; $$;
grant execute on function tally_votes_if_complete() to anon, authenticated;
