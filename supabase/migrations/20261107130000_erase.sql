-- Erasure: a purge (tombstone expiry or admin erase) removes the content for good.
-- History keeps that a memory existed and what happened to it, but no longer what it said.

-- (a) A 'purge' row records only who, when and the scope; never the content, category or tags.
create or replace function agent_memory.memories_history_fn() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_action text;
begin
  if tg_op = 'INSERT' then
    insert into agent_memory.memory_history (memory_id, action, member_id)
    values (new.id, 'insert', agent_memory.current_member_id());
    return null;
  elsif tg_op = 'DELETE' then
    insert into agent_memory.memory_history (memory_id, action, member_id, prev_scope_id)
    values (old.id, 'purge', agent_memory.current_member_id(), old.scope_id);
    return null;
  end if;

  if old.deleted_at is null and new.deleted_at is not null then
    v_action := 'delete';
  elsif old.deleted_at is not null and new.deleted_at is null then
    v_action := 'restore';
  elsif new.scope_id is distinct from old.scope_id then
    v_action := 'move';
  elsif new.content is distinct from old.content
     or new.category is distinct from old.category
     or new.tags is distinct from old.tags then
    v_action := 'update';
  else
    return null; -- access tracking and other bookkeeping: no history
  end if;

  insert into agent_memory.memory_history
    (memory_id, action, member_id, prev_content, prev_category, prev_tags, prev_scope_id)
  values (old.id, v_action, agent_memory.current_member_id(), old.content, old.category, old.tags, old.scope_id);
  return null;
end
$$;

-- Null the content snapshots in every earlier history row of the given (purged) memories.
create function agent_memory.scrub_history(p_ids uuid[]) returns void
language sql security definer set search_path = ''
as $$
  update agent_memory.memory_history h
  set prev_content = null, prev_category = null, prev_tags = null
  where h.memory_id = any (p_ids)
    and (h.prev_content is not null or h.prev_category is not null or h.prev_tags is not null)
$$;

-- (b) Tombstone expiry also scrubs the purged memories' history.
create or replace function agent_memory.purge_tombstones() returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  with p as (
    delete from agent_memory.memories
    where deleted_at < pg_catalog.now() - interval '30 days'
    returning id
  )
  select coalesce(pg_catalog.array_agg(p.id), '{}'::uuid[]) into v_ids from p;
  perform agent_memory.scrub_history(v_ids);
  return pg_catalog.cardinality(v_ids);
end
$$;

-- (c) Admin erase: hard-delete one memory now, live or soft-deleted, with the same scrub.
create function agent_memory.erase(p_id uuid) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  delete from agent_memory.memories where id = p_id;
  if not found then
    return false;
  end if;
  perform agent_memory.scrub_history(array[p_id]);
  return true;
end
$$;

revoke execute on function agent_memory.memories_history_fn() from public;
revoke execute on function agent_memory.scrub_history(uuid[]) from public;
revoke execute on function agent_memory.purge_tombstones() from public;
revoke execute on function agent_memory.erase(uuid) from public;

-- Memories purged before this migration: their history still carries content. Scrub it too
-- (skipping any id that is live again, e.g. re-imported with the same id).
select agent_memory.scrub_history(coalesce(
  (select pg_catalog.array_agg(distinct h.memory_id) from agent_memory.memory_history h
   where h.action = 'purge'
     and not exists (select 1 from agent_memory.memories m where m.id = h.memory_id)),
  '{}'::uuid[]
));
