-- Token resolution, access tracking, soft delete, history trigger and tombstone purge.

create function agent_memory.resolve_token(p_hash text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_member uuid;
  v_last timestamptz;
begin
  select t.id, t.member_id, t.last_used_at into v_id, v_member, v_last
  from agent_memory.access_tokens t
  where t.token_hash = p_hash
    and t.revoked_at is null
    and (t.expires_at is null or t.expires_at > pg_catalog.now());
  if v_id is null then
    return null;
  end if;
  if v_last is null or v_last < pg_catalog.now() - interval '1 minute' then
    update agent_memory.access_tokens set last_used_at = pg_catalog.now() where id = v_id;
  end if;
  return v_member;
end
$$;

create function agent_memory.touch_accessed(p_ids uuid[]) returns void
language sql security definer set search_path = ''
as $$
  update agent_memory.memories m
  set access_count = m.access_count + 1, last_accessed_at = pg_catalog.now()
  where m.id = any (p_ids)
    and agent_memory.can_read(m.scope_id)
    and m.deleted_at is null
    and coalesce(m.last_accessed_at, m.updated_at) < pg_catalog.now() - interval '1 hour'
$$;

create function agent_memory.soft_delete(p_ids uuid[]) returns uuid[]
language sql security definer set search_path = ''
as $$
  with d as (
    update agent_memory.memories m
    set deleted_at = pg_catalog.now()
    where m.id = any (p_ids) and agent_memory.can_write(m.scope_id) and m.deleted_at is null
    returning m.id
  )
  select coalesce(pg_catalog.array_agg(d.id), '{}'::uuid[]) from d
$$;

create function agent_memory.restore(p_id uuid) returns boolean
language sql security definer set search_path = ''
as $$
  with r as (
    update agent_memory.memories set deleted_at = null
    where id = p_id and deleted_at is not null
    returning 1
  )
  select exists (select 1 from r)
$$;

create function agent_memory.purge_tombstones() returns int
language sql security definer set search_path = ''
as $$
  with p as (
    delete from agent_memory.memories
    where deleted_at < pg_catalog.now() - interval '30 days'
    returning 1
  )
  select pg_catalog.count(*)::int from p
$$;

create function agent_memory.memories_history_fn() returns trigger
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
    insert into agent_memory.memory_history
      (memory_id, action, member_id, prev_content, prev_category, prev_tags, prev_scope_id)
    values (old.id, 'purge', agent_memory.current_member_id(), old.content, old.category, old.tags, old.scope_id);
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

create trigger memories_history
after insert or update or delete on agent_memory.memories
for each row execute function agent_memory.memories_history_fn();

revoke execute on function agent_memory.resolve_token(text) from public;
revoke execute on function agent_memory.touch_accessed(uuid[]) from public;
revoke execute on function agent_memory.soft_delete(uuid[]) from public;
revoke execute on function agent_memory.restore(uuid) from public;
revoke execute on function agent_memory.purge_tombstones() from public;
revoke execute on function agent_memory.memories_history_fn() from public;
grant execute on function agent_memory.touch_accessed(uuid[]) to agent_memory_member;
grant execute on function agent_memory.soft_delete(uuid[]) to agent_memory_member;

-- cron.schedule upserts by job name, so re-running is safe.
select cron.schedule('agent-memory-purge-tombstones', '17 3 * * *', 'select agent_memory.purge_tombstones()');
