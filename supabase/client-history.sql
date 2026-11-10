-- Version history for client records (pfo_clients).
-- Every time a client row is changed or deleted, the PREVIOUS version is copied into
-- pfo_clients_history first, so no save can ever destroy earlier answers.
--
-- Run once: Supabase dashboard -> SQL Editor -> New query -> paste this file -> Run.
-- Safe to run again (it replaces the trigger, keeps existing history).

create table if not exists pfo_clients_history (
  history_id  bigint generated always as identity primary key,
  client_id   bigint not null,
  changed_at  timestamptz not null default now(),
  operation   text not null,          -- UPDATE or DELETE
  row_before  jsonb not null          -- the whole client row as it was before the change
);
create index if not exists pfo_clients_history_client_idx
  on pfo_clients_history (client_id, changed_at desc);

-- Locked down: the website's public key cannot read, change or delete history.
-- (No policies = no access for anon/authenticated; the dashboard still sees everything.)
alter table pfo_clients_history enable row level security;

create or replace function pfo_clients_keep_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Skip saves that changed nothing, so history isn't flooded by autosave.
  if tg_op = 'UPDATE' and to_jsonb(old) = to_jsonb(new) then
    return new;
  end if;
  insert into pfo_clients_history (client_id, operation, row_before)
  values (old.id, tg_op, to_jsonb(old));
  return coalesce(new, old);
end $$;

drop trigger if exists pfo_clients_history_trg on pfo_clients;
create trigger pfo_clients_history_trg
  before update or delete on pfo_clients
  for each row execute function pfo_clients_keep_history();

-- ── How to recover ───────────────────────────────────────────────
-- 1. List a client's versions (newest first) and see which hold the missing answers:
--      select history_id, changed_at,
--             jsonb_array_length(coalesce(row_before->'form_data'->'nw_sheet','[]')) as sheet_rows,
--             (select count(*) from jsonb_object_keys(row_before->'form_data')) as answers
--      from pfo_clients_history where client_id = <CLIENT_ID> order by changed_at desc;
-- 2. Put back just one field (e.g. the Spreadsheet View) from a chosen version:
--      update pfo_clients c set form_data = c.form_data
--        || jsonb_build_object('nw_sheet', h.row_before->'form_data'->'nw_sheet')
--      from pfo_clients_history h where h.history_id = <ID> and c.id = h.client_id;
-- 3. Optional cleanup of very old history:
--      delete from pfo_clients_history where changed_at < now() - interval '1 year';
