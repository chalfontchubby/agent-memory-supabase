-- Member identity and row-level security.
-- Members never own tables; RLS is enabled (not forced) so the owning postgres role used by admin
-- scripts is unaffected. Policies key on agent_memory.current_member_id(), never auth.uid().

create function agent_memory.current_member_id() returns uuid
language sql stable security definer set search_path = ''
as $$ select nullif(pg_catalog.current_setting('agent_memory.member_id', true), '')::uuid $$;

create function agent_memory.can_read(p_scope uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from agent_memory.scope_grants g
    where g.scope_id = p_scope and g.member_id = agent_memory.current_member_id()
  )
$$;

create function agent_memory.can_write(p_scope uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from agent_memory.scope_grants g
    where g.scope_id = p_scope and g.member_id = agent_memory.current_member_id() and g.access = 'write'
  )
$$;

revoke execute on function agent_memory.current_member_id() from public;
revoke execute on function agent_memory.can_read(uuid) from public;
revoke execute on function agent_memory.can_write(uuid) from public;
grant execute on function agent_memory.current_member_id() to agent_memory_member;
grant execute on function agent_memory.can_read(uuid) to agent_memory_member;
grant execute on function agent_memory.can_write(uuid) to agent_memory_member;

alter table agent_memory.scopes enable row level security;
alter table agent_memory.members enable row level security;
alter table agent_memory.scope_grants enable row level security;
alter table agent_memory.memories enable row level security;
alter table agent_memory.memory_history enable row level security;
alter table agent_memory.access_tokens enable row level security;

create policy memories_select on agent_memory.memories for select to agent_memory_member
  using (agent_memory.can_read(scope_id) and deleted_at is null);
create policy memories_insert on agent_memory.memories for insert to agent_memory_member
  with check (agent_memory.can_write(scope_id) and created_by = agent_memory.current_member_id()
    and updated_by = agent_memory.current_member_id());
create policy memories_update on agent_memory.memories for update to agent_memory_member
  using (agent_memory.can_write(scope_id) and deleted_at is null)
  with check (agent_memory.can_write(scope_id) and updated_by = agent_memory.current_member_id());

create policy scopes_select on agent_memory.scopes for select to agent_memory_member
  using (agent_memory.can_read(id));
create policy scope_grants_select on agent_memory.scope_grants for select to agent_memory_member
  using (member_id = agent_memory.current_member_id());

grant usage on schema agent_memory to agent_memory_member;
-- Column-level grants: bookkeeping columns (created_at, access_count, last_accessed_at, deleted_at,
-- created_by on update) are only writable by the admin role or the Task 3 security-definer functions.
grant select on agent_memory.memories to agent_memory_member;
grant insert (scope_id, content, category, tags, created_by, updated_by, embedding)
  on agent_memory.memories to agent_memory_member;
grant update (scope_id, content, category, tags, updated_by, updated_at, embedding)
  on agent_memory.memories to agent_memory_member;
grant select on agent_memory.scopes, agent_memory.scope_grants to agent_memory_member;
