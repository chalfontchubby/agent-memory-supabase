-- Admin members, deactivation, the admin log, and the postgres-only adm_* core functions.

alter table agent_memory.members
  add column is_admin boolean not null default false,
  add column deactivated_at timestamptz,
  add constraint members_bot_not_admin check (kind = 'human' or not is_admin);

create table agent_memory.admin_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_member_id uuid null,
  actor_label text not null,
  action text not null,
  target text not null,
  details jsonb not null default '{}'
);
alter table agent_memory.admin_log enable row level security;
revoke all on agent_memory.admin_log from public, anon, authenticated, agent_memory_member;

-- Token resolution: deactivated members no longer resolve.
create or replace function agent_memory.resolve_token(p_hash text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_member uuid;
  v_last timestamptz;
begin
  select t.id, t.member_id, t.last_used_at into v_id, v_member, v_last
  from agent_memory.access_tokens t
  join agent_memory.members m on m.id = t.member_id
  where t.token_hash = p_hash
    and t.revoked_at is null
    and (t.expires_at is null or t.expires_at > pg_catalog.now())
    and m.deactivated_at is null;
  if v_id is null then
    return null;
  end if;
  if v_last is null or v_last < pg_catalog.now() - interval '1 minute' then
    update agent_memory.access_tokens set last_used_at = pg_catalog.now() where id = v_id;
  end if;
  return v_member;
end
$$;

create function agent_memory.resolve_member(p_hash text) returns table (member_id uuid, is_admin boolean)
language plpgsql security definer set search_path = ''
as $$
declare
  v_member uuid;
begin
  v_member := agent_memory.resolve_token(p_hash);
  if v_member is null then
    return;
  end if;
  return query select m.id, m.is_admin from agent_memory.members m where m.id = v_member;
end
$$;

create function agent_memory.adm_create_scope(p_name text, p_description text, p_actor uuid, p_label text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_name is null or p_name !~ '^[a-z0-9][a-z0-9-]{0,62}$' then
    raise exception 'Scope names are lowercase letters, digits and hyphens, starting with a letter or digit (max 63)';
  end if;
  if exists (select 1 from agent_memory.scopes where name = p_name) then
    raise exception 'Scope ''%'' already exists', p_name;
  end if;
  insert into agent_memory.scopes (name, description) values (p_name, p_description) returning id into v_id;
  insert into agent_memory.admin_log (actor_member_id, actor_label, action, target, details)
  values (p_actor, p_label, 'create_scope', p_name, pg_catalog.jsonb_build_object('scope', p_name));
  return v_id;
end
$$;

create function agent_memory.adm_delete_scope(p_name text, p_actor uuid, p_label text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_count bigint;
begin
  select id into v_id from agent_memory.scopes where name = p_name;
  if v_id is null then
    raise exception 'Scope ''%'' not found', p_name;
  end if;
  select pg_catalog.count(*) into v_count from agent_memory.memories where scope_id = v_id;
  if v_count > 0 then
    raise exception 'Scope ''%'' still holds % memories; move, delete or erase them first', p_name, v_count;
  end if;
  delete from agent_memory.scopes where id = v_id; -- grants cascade
  insert into agent_memory.admin_log (actor_member_id, actor_label, action, target, details)
  values (p_actor, p_label, 'delete_scope', p_name, pg_catalog.jsonb_build_object('scope', p_name));
end
$$;

create function agent_memory.adm_create_member(p_name text, p_kind text, p_email text, p_actor uuid, p_label text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_email text := nullif(pg_catalog.btrim(p_email), '');
  v_auth uuid := null;
begin
  if exists (select 1 from agent_memory.members where display_name = p_name) then
    raise exception 'Member ''%'' already exists', p_name;
  end if;
  if v_email is not null then
    select u.id into v_auth from auth.users u where pg_catalog.lower(u.email) = pg_catalog.lower(v_email) limit 1;
  end if;
  insert into agent_memory.members (display_name, kind, email, auth_user_id)
  values (p_name, p_kind, v_email, v_auth) returning id into v_id;
  insert into agent_memory.admin_log (actor_member_id, actor_label, action, target, details)
  values (p_actor, p_label, 'create_member', p_name, pg_catalog.jsonb_build_object('kind', p_kind));
  return v_id;
end
$$;

-- Serialise admin-flag changes so two concurrent demotions cannot both pass the last-admin check.
create function agent_memory.adm_assert_not_last_admin(p_member uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('agent_memory.admin_flag'));
  if exists (select 1 from agent_memory.members where id = p_member and is_admin and deactivated_at is null)
     and (select pg_catalog.count(*) from agent_memory.members where is_admin and deactivated_at is null) <= 1 then
    raise exception 'Can''t remove the last active admin';
  end if;
end
$$;

create function agent_memory.adm_deactivate_member(p_name text, p_actor uuid, p_label text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  select id into v_id from agent_memory.members where display_name = p_name;
  if v_id is null then
    raise exception 'Member ''%'' not found', p_name;
  end if;
  perform agent_memory.adm_assert_not_last_admin(v_id);
  update agent_memory.access_tokens set revoked_at = pg_catalog.now() where member_id = v_id and revoked_at is null;
  delete from agent_memory.scope_grants where member_id = v_id;
  update agent_memory.members set deactivated_at = coalesce(deactivated_at, pg_catalog.now()), is_admin = false
  where id = v_id;
  insert into agent_memory.admin_log (actor_member_id, actor_label, action, target, details)
  values (p_actor, p_label, 'deactivate_member', p_name, '{}');
end
$$;

create function agent_memory.adm_reactivate_member(p_name text, p_actor uuid, p_label text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  select id into v_id from agent_memory.members where display_name = p_name;
  if v_id is null then
    raise exception 'Member ''%'' not found', p_name;
  end if;
  update agent_memory.members set deactivated_at = null where id = v_id;
  insert into agent_memory.admin_log (actor_member_id, actor_label, action, target, details)
  values (p_actor, p_label, 'reactivate_member', p_name, '{}');
end
$$;

create function agent_memory.adm_set_admin(p_name text, p_on boolean, p_actor uuid, p_label text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_kind text;
begin
  select id, kind into v_id, v_kind from agent_memory.members where display_name = p_name;
  if v_id is null then
    raise exception 'Member ''%'' not found', p_name;
  end if;
  if p_on then
    if v_kind <> 'human' then
      raise exception 'A bot can''t be an admin';
    end if;
  else
    perform agent_memory.adm_assert_not_last_admin(v_id);
  end if;
  update agent_memory.members set is_admin = p_on where id = v_id;
  insert into agent_memory.admin_log (actor_member_id, actor_label, action, target, details)
  values (p_actor, p_label, 'set_admin', p_name, pg_catalog.jsonb_build_object('admin', p_on));
end
$$;

create function agent_memory.adm_grant(p_member text, p_scope text, p_access text, p_actor uuid, p_label text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_member uuid;
  v_dead timestamptz;
  v_scope uuid;
begin
  if p_access is null or p_access not in ('read', 'write') then
    raise exception 'Access must be read or write';
  end if;
  select id, deactivated_at into v_member, v_dead from agent_memory.members where display_name = p_member;
  if v_member is null then
    raise exception 'Member ''%'' not found', p_member;
  end if;
  select id into v_scope from agent_memory.scopes where name = p_scope;
  if v_scope is null then
    raise exception 'Scope ''%'' not found', p_scope;
  end if;
  if v_dead is not null then
    raise exception 'Member ''%'' is deactivated', p_member;
  end if;
  insert into agent_memory.scope_grants (scope_id, member_id, access, granted_by)
  values (v_scope, v_member, p_access, p_label)
  on conflict (scope_id, member_id)
  do update set access = excluded.access, granted_by = excluded.granted_by, granted_at = pg_catalog.now();
  insert into agent_memory.admin_log (actor_member_id, actor_label, action, target, details)
  values (p_actor, p_label, 'grant', p_member, pg_catalog.jsonb_build_object('scope', p_scope, 'access', p_access));
end
$$;

create function agent_memory.adm_revoke(p_member text, p_scope text, p_actor uuid, p_label text) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_member uuid;
  v_scope uuid;
  v_n bigint;
begin
  select id into v_member from agent_memory.members where display_name = p_member;
  if v_member is null then
    raise exception 'Member ''%'' not found', p_member;
  end if;
  select id into v_scope from agent_memory.scopes where name = p_scope;
  if v_scope is null then
    raise exception 'Scope ''%'' not found', p_scope;
  end if;
  with d as (
    delete from agent_memory.scope_grants where scope_id = v_scope and member_id = v_member returning 1
  )
  select pg_catalog.count(*) into v_n from d;
  if v_n = 0 then
    return false;
  end if;
  insert into agent_memory.admin_log (actor_member_id, actor_label, action, target, details)
  values (p_actor, p_label, 'revoke', p_member, pg_catalog.jsonb_build_object('scope', p_scope));
  return true;
end
$$;

create function agent_memory.adm_issue_token(
  p_member text, p_name text, p_hash text, p_expires timestamptz, p_actor uuid, p_label text
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_member uuid;
  v_dead timestamptz;
  v_id uuid;
begin
  select id, deactivated_at into v_member, v_dead from agent_memory.members where display_name = p_member;
  if v_member is null then
    raise exception 'Member ''%'' not found', p_member;
  end if;
  if v_dead is not null then
    raise exception 'Member ''%'' is deactivated', p_member;
  end if;
  insert into agent_memory.access_tokens (member_id, name, token_hash, expires_at)
  values (v_member, p_name, p_hash, p_expires) returning id into v_id;
  insert into agent_memory.admin_log (actor_member_id, actor_label, action, target, details)
  values (p_actor, p_label, 'issue_token', p_member,
    pg_catalog.jsonb_build_object('token_id', v_id, 'name', p_name));
  return v_id;
end
$$;

create function agent_memory.adm_revoke_token(p_id uuid, p_actor uuid, p_label text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_member text;
begin
  select m.display_name into v_member
  from agent_memory.access_tokens t join agent_memory.members m on m.id = t.member_id
  where t.id = p_id;
  if v_member is null then
    raise exception 'Token % not found', p_id;
  end if;
  update agent_memory.access_tokens set revoked_at = coalesce(revoked_at, pg_catalog.now()) where id = p_id;
  insert into agent_memory.admin_log (actor_member_id, actor_label, action, target, details)
  values (p_actor, p_label, 'revoke_token', v_member, pg_catalog.jsonb_build_object('token_id', p_id));
end
$$;

revoke execute on function agent_memory.resolve_token(text) from public;
revoke execute on function agent_memory.resolve_member(text) from public;
revoke execute on function agent_memory.adm_create_scope(text, text, uuid, text) from public;
revoke execute on function agent_memory.adm_delete_scope(text, uuid, text) from public;
revoke execute on function agent_memory.adm_create_member(text, text, text, uuid, text) from public;
revoke execute on function agent_memory.adm_assert_not_last_admin(uuid) from public;
revoke execute on function agent_memory.adm_deactivate_member(text, uuid, text) from public;
revoke execute on function agent_memory.adm_reactivate_member(text, uuid, text) from public;
revoke execute on function agent_memory.adm_set_admin(text, boolean, uuid, text) from public;
revoke execute on function agent_memory.adm_grant(text, text, text, uuid, text) from public;
revoke execute on function agent_memory.adm_revoke(text, text, uuid, text) from public;
revoke execute on function agent_memory.adm_issue_token(text, text, text, timestamptz, uuid, text) from public;
revoke execute on function agent_memory.adm_revoke_token(uuid, uuid, text) from public;

-- ============================================================================
-- Member-callable admin_* wrappers. Each runs as owner, checks the caller is an active admin, refuses to
-- act on another admin, then delegates to the matching postgres-only adm_* function.
-- ============================================================================

-- Private helper: not executable by agent_memory_member, only reachable from the wrappers below.
create function agent_memory.require_admin() returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_id uuid := agent_memory.current_member_id();
begin
  if v_id is null or not exists (
    select 1 from agent_memory.members where id = v_id and is_admin and deactivated_at is null
  ) then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  return v_id;
end
$$;

create function agent_memory.admin_label(p_id uuid) returns text
language sql stable security definer set search_path = ''
as $$ select display_name from agent_memory.members where id = p_id $$;

-- Raises if p_name is a member other than the caller who is an admin.
create function agent_memory.assert_not_other_admin(p_name text, p_caller uuid) returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if exists (
    select 1 from agent_memory.members where display_name = p_name and id <> p_caller and is_admin
  ) then
    raise exception 'Member ''%'' is an admin; manage admins from the shell', p_name;
  end if;
end
$$;

create function agent_memory.admin_create_scope(p_name text, p_description text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_caller uuid := agent_memory.require_admin();
begin
  return agent_memory.adm_create_scope(p_name, p_description, v_caller, agent_memory.admin_label(v_caller));
end
$$;

create function agent_memory.admin_delete_scope(p_name text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_caller uuid := agent_memory.require_admin();
begin
  perform agent_memory.adm_delete_scope(p_name, v_caller, agent_memory.admin_label(v_caller));
end
$$;

create function agent_memory.admin_create_member(p_name text, p_kind text, p_email text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_caller uuid := agent_memory.require_admin();
begin
  return agent_memory.adm_create_member(p_name, p_kind, p_email, v_caller, agent_memory.admin_label(v_caller));
end
$$;

create function agent_memory.admin_deactivate_member(p_name text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_caller uuid := agent_memory.require_admin();
begin
  if exists (select 1 from agent_memory.members where id = v_caller and display_name = p_name) then
    raise exception 'You can''t deactivate yourself';
  end if;
  perform agent_memory.assert_not_other_admin(p_name, v_caller);
  perform agent_memory.adm_deactivate_member(p_name, v_caller, agent_memory.admin_label(v_caller));
end
$$;

create function agent_memory.admin_grant(p_member text, p_scope text, p_access text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_caller uuid := agent_memory.require_admin();
begin
  perform agent_memory.assert_not_other_admin(p_member, v_caller);
  perform agent_memory.adm_grant(p_member, p_scope, p_access, v_caller, agent_memory.admin_label(v_caller));
end
$$;

create function agent_memory.admin_revoke(p_member text, p_scope text) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_caller uuid := agent_memory.require_admin();
begin
  perform agent_memory.assert_not_other_admin(p_member, v_caller);
  return agent_memory.adm_revoke(p_member, p_scope, v_caller, agent_memory.admin_label(v_caller));
end
$$;

create function agent_memory.admin_issue_token(p_member text, p_name text, p_hash text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_caller uuid := agent_memory.require_admin();
begin
  perform agent_memory.assert_not_other_admin(p_member, v_caller);
  return agent_memory.adm_issue_token(p_member, p_name, p_hash, null, v_caller, agent_memory.admin_label(v_caller));
end
$$;

create function agent_memory.admin_revoke_token(p_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_caller uuid := agent_memory.require_admin();
  v_owner uuid;
  v_owner_name text;
  v_live boolean;
begin
  select t.member_id, m.display_name, (t.revoked_at is null and (t.expires_at is null or t.expires_at > pg_catalog.now()))
  into v_owner, v_owner_name, v_live
  from agent_memory.access_tokens t join agent_memory.members m on m.id = t.member_id
  where t.id = p_id;
  if v_owner is not null then
    perform agent_memory.assert_not_other_admin(v_owner_name, v_caller);
    if v_owner = v_caller and v_live then
      -- lock the caller's live tokens so two concurrent revokes cannot both pass
      perform 1 from agent_memory.access_tokens
        where member_id = v_caller and revoked_at is null and (expires_at is null or expires_at > pg_catalog.now())
        for update;
      if (select pg_catalog.count(*) from agent_memory.access_tokens
          where member_id = v_caller and revoked_at is null and (expires_at is null or expires_at > pg_catalog.now())) <= 1 then
        raise exception 'You can''t revoke your last live token';
      end if;
    end if;
  end if;
  perform agent_memory.adm_revoke_token(p_id, v_caller, agent_memory.admin_label(v_caller));
end
$$;

create function agent_memory.admin_list_scopes()
returns table (name text, description text, memories int, deleted int, readers int, writers int)
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform agent_memory.require_admin();
  return query
    select s.name, s.description,
      (select pg_catalog.count(*) from agent_memory.memories x where x.scope_id = s.id and x.deleted_at is null)::int,
      (select pg_catalog.count(*) from agent_memory.memories x where x.scope_id = s.id and x.deleted_at is not null)::int,
      (select pg_catalog.count(*) from agent_memory.scope_grants g where g.scope_id = s.id and g.access = 'read')::int,
      (select pg_catalog.count(*) from agent_memory.scope_grants g where g.scope_id = s.id and g.access = 'write')::int
    from agent_memory.scopes s order by s.name;
end
$$;

create function agent_memory.admin_list_members()
returns table (name text, kind text, email text, is_admin boolean, deactivated boolean, live_tokens int)
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform agent_memory.require_admin();
  return query
    select m.display_name, m.kind, m.email, m.is_admin, (m.deactivated_at is not null),
      (select pg_catalog.count(*) from agent_memory.access_tokens t
        where t.member_id = m.id and t.revoked_at is null and (t.expires_at is null or t.expires_at > pg_catalog.now()))::int
    from agent_memory.members m order by m.display_name;
end
$$;

create function agent_memory.admin_list_grants(p_scope text, p_member text)
returns table (scope text, member text, access text, granted_at timestamptz, granted_by text)
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform agent_memory.require_admin();
  return query
    select s.name, m.display_name, g.access, g.granted_at, g.granted_by
    from agent_memory.scope_grants g
    join agent_memory.scopes s on s.id = g.scope_id
    join agent_memory.members m on m.id = g.member_id
    where (p_scope is null or s.name = p_scope) and (p_member is null or m.display_name = p_member)
    order by s.name, m.display_name;
end
$$;

create function agent_memory.admin_list_tokens(p_member text)
returns table (id uuid, name text, created_at timestamptz, last_used_at timestamptz, revoked_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_caller uuid := agent_memory.require_admin();
  v_member uuid;
begin
  perform agent_memory.assert_not_other_admin(p_member, v_caller);
  select m.id into v_member from agent_memory.members m where m.display_name = p_member;
  if v_member is null then
    raise exception 'Member ''%'' not found', p_member;
  end if;
  return query
    select t.id, t.name, t.created_at, t.last_used_at, t.revoked_at
    from agent_memory.access_tokens t where t.member_id = v_member order by t.created_at, t.id;
end
$$;

revoke execute on function agent_memory.require_admin() from public;
revoke execute on function agent_memory.admin_label(uuid) from public;
revoke execute on function agent_memory.assert_not_other_admin(text, uuid) from public;
revoke execute on function agent_memory.admin_create_scope(text, text) from public;
revoke execute on function agent_memory.admin_delete_scope(text) from public;
revoke execute on function agent_memory.admin_create_member(text, text, text) from public;
revoke execute on function agent_memory.admin_deactivate_member(text) from public;
revoke execute on function agent_memory.admin_grant(text, text, text) from public;
revoke execute on function agent_memory.admin_revoke(text, text) from public;
revoke execute on function agent_memory.admin_issue_token(text, text, text) from public;
revoke execute on function agent_memory.admin_revoke_token(uuid) from public;
revoke execute on function agent_memory.admin_list_scopes() from public;
revoke execute on function agent_memory.admin_list_members() from public;
revoke execute on function agent_memory.admin_list_grants(text, text) from public;
revoke execute on function agent_memory.admin_list_tokens(text) from public;

grant execute on function agent_memory.admin_create_scope(text, text) to agent_memory_member;
grant execute on function agent_memory.admin_delete_scope(text) to agent_memory_member;
grant execute on function agent_memory.admin_create_member(text, text, text) to agent_memory_member;
grant execute on function agent_memory.admin_deactivate_member(text) to agent_memory_member;
grant execute on function agent_memory.admin_grant(text, text, text) to agent_memory_member;
grant execute on function agent_memory.admin_revoke(text, text) to agent_memory_member;
grant execute on function agent_memory.admin_issue_token(text, text, text) to agent_memory_member;
grant execute on function agent_memory.admin_revoke_token(uuid) to agent_memory_member;
grant execute on function agent_memory.admin_list_scopes() to agent_memory_member;
grant execute on function agent_memory.admin_list_members() to agent_memory_member;
grant execute on function agent_memory.admin_list_grants(text, text) to agent_memory_member;
grant execute on function agent_memory.admin_list_tokens(text) to agent_memory_member;
