-- ═══════════════════════════════════════════════════════════════════
-- Change history + protection for client data (version 2)
-- ═══════════════════════════════════════════════════════════════════
-- Records every change to clients (pfo_clients) and their priorities / action plan /
-- follow-up records (pfo_intakes): WHICH field changed, its OLD value and its NEW value,
-- plus a full copy of the row on delete and at least every 30 minutes while it's being edited.
--
-- Run: Supabase dashboard -> SQL Editor -> New query -> paste this whole file -> Run.
-- Safe to run again. Replaces version 1 (pfo_clients_history); its rows are moved over.
-- The last block is a self-test: it makes a test change, checks it was recorded and that
-- wiping a table is blocked, then rolls everything back. Look for "Self-test passed".
--
-- Protection:
--   * History lives in its own schema (pfo_audit) that the website's public key cannot reach:
--     it can't be read, edited or deleted from the website or the API.
--   * TRUNCATE (wiping a whole table) is blocked on pfo_clients and pfo_intakes.
--   * Deleting a client row through the API still works but is recorded with a full copy.
--   * Limit: history is inside the same Supabase project. It protects against app bugs,
--     overwrites, deletes and misuse of the public key; it does not protect against the
--     project itself being lost. For that, use Supabase's own backups (Database -> Backups;
--     daily backups / point-in-time recovery need a paid plan).
--
-- HOW TO SEE WHAT CHANGED (examples at the bottom of this file):
--   select * from pfo_audit.changes where client_name ilike '%smith%' order by history_id desc;
-- ═══════════════════════════════════════════════════════════════════

create schema if not exists pfo_audit;
revoke all on schema pfo_audit from public, anon, authenticated;

create table if not exists pfo_audit.history (
  id          bigint generated always as identity primary key,
  changed_at  timestamptz not null default now(),
  table_name  text not null,                -- pfo_clients or pfo_intakes
  row_id      text not null,                -- that row's id
  client_name text,
  operation   text not null,                -- UPDATE or DELETE
  changes     jsonb not null default '{}',  -- {"form_data.nw_sheet": {"old": ..., "new": ...}, "form_status": {...}}
  row_before  jsonb                         -- full row before the change (on delete, and at most every 30 min per row)
);
create index if not exists history_row_idx on pfo_audit.history (table_name, row_id, changed_at desc);
create index if not exists history_name_idx on pfo_audit.history (client_name);
revoke all on pfo_audit.history from public, anon, authenticated;

-- jsonb object, or {} for anything else (null, arrays)
create or replace function pfo_audit.obj(j jsonb) returns jsonb
language sql immutable as $$
  select case when jsonb_typeof(j) = 'object' then j else '{}'::jsonb end
$$;

-- {prefix||key: {old, new}} for every key whose value differs between o and n
create or replace function pfo_audit.diff(o jsonb, n jsonb, prefix text default '') returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(prefix || k, jsonb_build_object('old', o -> k, 'new', n -> k)), '{}'::jsonb)
  from (select jsonb_object_keys(pfo_audit.obj(o)) as k
        union
        select jsonb_object_keys(pfo_audit.obj(n))) as keys
  where (pfo_audit.obj(o) -> k) is distinct from (pfo_audit.obj(n) -> k)
$$;

create or replace function pfo_audit.record_change() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  o    jsonb := to_jsonb(old);
  n    jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  rid  text  := o ->> 'id';
  ch   jsonb;
  snap boolean;
begin
  if tg_op = 'UPDATE' and o = n then
    return null;                              -- a save that changed nothing
  end if;
  ch := pfo_audit.diff(o - 'form_data', coalesce(n, '{}'::jsonb) - 'form_data')
     || pfo_audit.diff(o -> 'form_data', n -> 'form_data', 'form_data.');
  snap := tg_op = 'DELETE' or not exists (
    select 1 from pfo_audit.history h
    where h.table_name = tg_table_name and h.row_id = rid
      and h.row_before is not null and h.changed_at > now() - interval '30 minutes');
  insert into pfo_audit.history (table_name, row_id, client_name, operation, changes, row_before)
  values (tg_table_name, rid, coalesce(n ->> 'client_name', o ->> 'client_name'), tg_op, ch,
          case when snap then o end);
  return null;                                -- AFTER trigger: return value is ignored
end
$$;

create or replace function pfo_audit.block_truncate() returns trigger
language plpgsql as $$
begin
  raise exception 'TRUNCATE on % is blocked to protect client data (drop trigger pfo_no_truncate on that table to allow it).', tg_table_name;
end
$$;

-- Remove version 1 (its rows are kept, moved into pfo_audit.history)
drop trigger if exists pfo_clients_history_trg on public.pfo_clients;
drop function if exists public.pfo_clients_keep_history();
do $$
begin
  if to_regclass('public.pfo_clients_history') is not null then
    insert into pfo_audit.history (changed_at, table_name, row_id, client_name, operation, row_before)
    select changed_at, 'pfo_clients', client_id::text, row_before ->> 'client_name', operation, row_before
    from public.pfo_clients_history;
    drop table public.pfo_clients_history;
  end if;
end $$;

-- Record changes
drop trigger if exists pfo_history_trg on public.pfo_clients;
create trigger pfo_history_trg after update or delete on public.pfo_clients
  for each row execute function pfo_audit.record_change();
drop trigger if exists pfo_history_trg on public.pfo_intakes;
create trigger pfo_history_trg after update or delete on public.pfo_intakes
  for each row execute function pfo_audit.record_change();

-- Block wiping whole tables
drop trigger if exists pfo_no_truncate on public.pfo_clients;
create trigger pfo_no_truncate before truncate on public.pfo_clients
  for each statement execute function pfo_audit.block_truncate();
drop trigger if exists pfo_no_truncate on public.pfo_intakes;
create trigger pfo_no_truncate before truncate on public.pfo_intakes
  for each statement execute function pfo_audit.block_truncate();
revoke truncate on public.pfo_clients, public.pfo_intakes from anon, authenticated;
do $$ begin
  if to_regclass('public.pfo_users') is not null then
    execute 'revoke truncate on public.pfo_users from anon, authenticated';
  end if;
end $$;

-- One row per changed field, easy to read
create or replace view pfo_audit.changes as
select h.id                                         as history_id,
       h.changed_at at time zone 'America/Chicago'  as changed_at_central,
       h.client_name,
       h.table_name,
       h.row_id,
       h.operation,
       c.key                                        as field,
       c.value -> 'old'                             as old_value,
       c.value -> 'new'                             as new_value
from pfo_audit.history h
cross join lateral jsonb_each(h.changes) c;
revoke all on pfo_audit.changes from public, anon, authenticated;

-- Put one form field back to its value before a given change. The restore is itself recorded.
create or replace function pfo_audit.restore_field(p_history_id bigint, p_field text) returns text
language plpgsql as $$
declare
  h pfo_audit.history;
  v jsonb;
  k text;
begin
  select * into h from pfo_audit.history where id = p_history_id;
  if not found then raise exception 'No history row %', p_history_id; end if;
  if not (h.changes ? p_field) then raise exception 'Field % did not change in history row %', p_field, p_history_id; end if;
  if p_field not like 'form_data.%' then raise exception 'Only form_data.* fields can be restored with this helper'; end if;
  v := h.changes -> p_field -> 'old';
  k := substr(p_field, length('form_data.') + 1);
  execute format(
    'update public.%I set form_data = case when $1 is null or $1 = ''null''::jsonb
        then coalesce(form_data, ''{}''::jsonb) - $2
        else coalesce(form_data, ''{}''::jsonb) || jsonb_build_object($2, $1) end
     where id::text = $3', h.table_name)
  using v, k, h.row_id;
  return format('Restored %s on %s row %s (%s) to its value before change %s', p_field, h.table_name, h.row_id, h.client_name, p_history_id);
end
$$;
revoke all on function pfo_audit.restore_field(bigint, text) from public, anon, authenticated;

-- ── Self-test (changes nothing: everything below is rolled back) ──
do $$
declare
  cid text;
  recorded boolean;
  t text;
begin
  select id::text into cid from public.pfo_clients order by id limit 1;
  if cid is null then raise notice 'Self-test skipped: no clients yet.'; return; end if;
  begin
    update public.pfo_clients
       set form_data = coalesce(form_data, '{}'::jsonb) || '{"__selftest": true}'::jsonb
     where id::text = cid;
    select exists (select 1 from pfo_audit.history
                   where table_name = 'pfo_clients' and row_id = cid and changes ? 'form_data.__selftest')
      into recorded;
    if not recorded then raise exception 'SELF-TEST FAILED: the change was not recorded'; end if;
    foreach t in array array['pfo_clients', 'pfo_intakes'] loop
      begin
        execute format('truncate public.%I', t);
        raise exception 'SELF-TEST FAILED: truncate of % was not blocked', t;
      exception when others then
        if sqlerrm like 'SELF-TEST FAILED%' then raise; end if;
        if sqlerrm not like '%is blocked to protect client data%'
           and sqlerrm not like '%cannot truncate a table referenced in a foreign key constraint%' then
          raise exception 'SELF-TEST FAILED: unexpected error on truncate of %: %', t, sqlerrm;
        end if;
      end;
    end loop;
    raise exception 'selftest-rollback';
  exception when others then
    if sqlerrm <> 'selftest-rollback' then raise; end if;
  end;
  raise notice 'Self-test passed: changes are recorded field by field and wiping tables is blocked.';
end $$;

-- ═══ Examples (run these on their own) ═════════════════════════════
-- What changed for a client, newest first:
--   select history_id, changed_at_central, field, old_value, new_value
--   from pfo_audit.changes where client_name ilike '%smith%' order by history_id desc;
--
-- Answers that were cleared or removed in the last 7 days (the dangerous kind of change):
--   select history_id, changed_at_central, client_name, field, old_value
--   from pfo_audit.changes
--   where changed_at_central > now() - interval '7 days'
--     and old_value is not null and old_value <> '""'::jsonb and old_value <> 'null'::jsonb
--     and (new_value is null or new_value = 'null'::jsonb or new_value = '""'::jsonb or new_value = '[]'::jsonb)
--   order by history_id desc;
--
-- Put a field back (e.g. a wiped Spreadsheet View) using a history_id from the queries above:
--   select pfo_audit.restore_field(<history_id>, 'form_data.nw_sheet');
--
-- Full copy of a row as it was (snapshots):
--   select id, changed_at, row_before from pfo_audit.history
--   where table_name = 'pfo_clients' and row_id = '<client id>' and row_before is not null
--   order by changed_at desc;
--
-- Space used by history:
--   select pg_size_pretty(pg_total_relation_size('pfo_audit.history'));
