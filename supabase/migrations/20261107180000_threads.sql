-- Discussion threads: sessions, threads, posts, links, subscriptions.
-- Sections: (1) sessions and tables, (2) helper functions, (3) views, (4) RLS and grants,
-- (5) memory session columns and history. Later sections of the threads work append below.

-- ===== 1. Sessions and tables =====

create table agent_memory.agent_sessions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references agent_memory.members (id) on delete cascade,
  label text null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create unique index agent_sessions_member_label_key on agent_memory.agent_sessions (member_id, label)
  where label is not null;

create table agent_memory.threads (
  id uuid primary key default gen_random_uuid(),
  scope_id uuid not null references agent_memory.scopes (id),
  title text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_by uuid not null references agent_memory.members (id),
  created_session uuid null references agent_memory.agent_sessions (id) on delete set null,
  created_at timestamptz not null default now(),
  last_post_at timestamptz not null default now(),
  post_count int not null default 0,
  resolved_at timestamptz,
  resolved_by uuid references agent_memory.members (id),
  deleted_at timestamptz
);
create index threads_scope_status_idx on agent_memory.threads (scope_id, status, last_post_at desc)
  where deleted_at is null;

create table agent_memory.thread_posts (
  id bigint generated always as identity primary key,
  thread_id uuid not null references agent_memory.threads (id) on delete cascade,
  seq int not null,
  kind text not null default 'post' check (kind in ('post', 'resolve', 'reopen')),
  body text not null,
  author_id uuid not null references agent_memory.members (id),
  session_id uuid null references agent_memory.agent_sessions (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (thread_id, seq)
);

create table agent_memory.thread_links (
  thread_id uuid not null references agent_memory.threads (id) on delete cascade,
  memory_id uuid not null references agent_memory.memories (id) on delete cascade,
  linked_by uuid not null references agent_memory.members (id),
  linked_at timestamptz not null default now(),
  primary key (thread_id, memory_id)
);
create index thread_links_memory_idx on agent_memory.thread_links (memory_id);

create table agent_memory.thread_subscriptions (
  session_id uuid not null references agent_memory.agent_sessions (id) on delete cascade,
  thread_id uuid not null references agent_memory.threads (id) on delete cascade,
  last_seen_seq int not null,
  subscribed_at timestamptz not null default now(),
  primary key (session_id, thread_id)
);

alter table agent_memory.memories
  add column created_session uuid references agent_memory.agent_sessions (id) on delete set null,
  add column updated_session uuid references agent_memory.agent_sessions (id) on delete set null;
alter table agent_memory.memory_history add column session_id uuid; -- no FK: history outlives sessions

alter table agent_memory.agent_sessions enable row level security;
alter table agent_memory.threads enable row level security;
alter table agent_memory.thread_posts enable row level security;
alter table agent_memory.thread_links enable row level security;
alter table agent_memory.thread_subscriptions enable row level security;

-- ===== 2. Helper functions =====

create function agent_memory.owns_session(p uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from agent_memory.agent_sessions s
    where s.id = p and s.member_id = agent_memory.current_member_id()
  )
$$;

create function agent_memory.session_label(p uuid) returns text
language sql stable security definer set search_path = ''
as $$ select s.label from agent_memory.agent_sessions s where s.id = p $$;

create function agent_memory.can_read_thread(p uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from agent_memory.threads t
    where t.id = p and t.deleted_at is null and agent_memory.can_read(t.scope_id)
  )
$$;

create function agent_memory.can_write_thread(p uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from agent_memory.threads t
    where t.id = p and t.deleted_at is null and agent_memory.can_write(t.scope_id)
  )
$$;

-- Session resolution, spec section 4. Labels are not trimmed: leading or trailing space is refused.
create function agent_memory.resolve_session(p_id uuid, p_label text, p_create boolean)
returns table (id uuid, label text, created boolean)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_member uuid := agent_memory.current_member_id();
  v_sess agent_memory.agent_sessions;
begin
  if v_member is null then
    raise exception 'Session not found';
  end if;
  if p_label is not null and (pg_catalog.length(p_label) not between 1 and 64 or p_label !~ '^\S(.*\S)?$') then
    raise exception 'Session label must be 1-64 characters with no leading or trailing space';
  end if;

  if p_id is null and p_label is null then
    if not p_create then
      return;
    end if;
    insert into agent_memory.agent_sessions (member_id) values (v_member) returning * into v_sess;
    return query select v_sess.id, v_sess.label, true;
    return;
  end if;

  if p_id is null then
    select s.* into v_sess from agent_memory.agent_sessions s
    where s.member_id = v_member and s.label = p_label;
    if not found then
      if not p_create then
        raise exception 'Session not found';
      end if;
      begin
        insert into agent_memory.agent_sessions (member_id, label) values (v_member, p_label)
        returning * into v_sess;
      exception when unique_violation then
        select s.* into v_sess from agent_memory.agent_sessions s
        where s.member_id = v_member and s.label = p_label;
        return query select v_sess.id, v_sess.label, false;
        return;
      end;
      return query select v_sess.id, v_sess.label, true;
      return;
    end if;
  else
    select s.* into v_sess from agent_memory.agent_sessions s
    where s.id = p_id and s.member_id = v_member;
    if not found then
      raise exception 'Session not found';
    end if;
    if p_label is not null then
      if v_sess.label is null then
        begin
          update agent_memory.agent_sessions s set label = p_label where s.id = v_sess.id
          returning * into v_sess;
        exception when unique_violation then
          raise exception 'Session label ''%'' is already in use', p_label;
        end;
      elsif v_sess.label <> p_label then
        raise exception 'Session label does not match';
      end if;
    end if;
  end if;

  if v_sess.last_seen_at < pg_catalog.now() - interval '1 minute' then
    update agent_memory.agent_sessions s set last_seen_at = pg_catalog.now() where s.id = v_sess.id;
  end if;
  return query select v_sess.id, v_sess.label, false;
end
$$;

revoke execute on function agent_memory.owns_session(uuid) from public;
revoke execute on function agent_memory.session_label(uuid) from public;
revoke execute on function agent_memory.can_read_thread(uuid) from public;
revoke execute on function agent_memory.can_write_thread(uuid) from public;
revoke execute on function agent_memory.resolve_session(uuid, text, boolean) from public;
grant execute on function agent_memory.owns_session(uuid) to agent_memory_member;
grant execute on function agent_memory.session_label(uuid) to agent_memory_member;
grant execute on function agent_memory.can_read_thread(uuid) to agent_memory_member;
grant execute on function agent_memory.can_write_thread(uuid) to agent_memory_member;
grant execute on function agent_memory.resolve_session(uuid, text, boolean) to agent_memory_member;

-- ===== 3. Views =====

create view agent_memory.thread_view with (security_invoker = true) as
select
  t.id,
  t.scope_id,
  s.name as scope,
  t.title,
  t.status,
  agent_memory.member_name(t.created_by) as created_by,
  t.created_at,
  t.last_post_at,
  t.post_count,
  (select agent_memory.member_name(p.author_id) from agent_memory.thread_posts p
   where p.thread_id = t.id order by p.seq desc limit 1) as last_author,
  t.resolved_at,
  agent_memory.member_name(t.resolved_by) as resolved_by
from agent_memory.threads t
join agent_memory.scopes s on s.id = t.scope_id;

create view agent_memory.thread_post_view with (security_invoker = true) as
select
  p.thread_id,
  p.seq,
  p.kind,
  p.body,
  agent_memory.member_name(p.author_id) as author,
  p.session_id,
  agent_memory.session_label(p.session_id) as session_label,
  p.created_at
from agent_memory.thread_posts p;

create or replace view agent_memory.memory_view with (security_invoker = true) as
select
  m.id,
  m.scope_id,
  s.name as scope,
  m.content,
  m.category,
  m.tags,
  m.created_at,
  m.updated_at,
  agent_memory.member_name(m.created_by) as created_by,
  agent_memory.member_name(m.updated_by) as updated_by,
  m.access_count,
  m.last_accessed_at,
  agent_memory.session_label(m.created_session) as created_session_label,
  agent_memory.session_label(m.updated_session) as updated_session_label
from agent_memory.memories m
join agent_memory.scopes s on s.id = m.scope_id;

-- ===== 4. RLS and grants (select only; every write goes through a function) =====

create policy threads_select on agent_memory.threads for select to agent_memory_member
  using (agent_memory.can_read(scope_id) and deleted_at is null);
create policy thread_posts_select on agent_memory.thread_posts for select to agent_memory_member
  using (agent_memory.can_read_thread(thread_id));
create policy thread_links_select on agent_memory.thread_links for select to agent_memory_member
  using (agent_memory.can_read_thread(thread_id)
    and exists (select 1 from agent_memory.memories m where m.id = memory_id));
create policy agent_sessions_select on agent_memory.agent_sessions for select to agent_memory_member
  using (member_id = agent_memory.current_member_id());
create policy thread_subscriptions_select on agent_memory.thread_subscriptions for select to agent_memory_member
  using (agent_memory.owns_session(session_id));

grant select on agent_memory.agent_sessions, agent_memory.threads, agent_memory.thread_posts,
  agent_memory.thread_links, agent_memory.thread_subscriptions to agent_memory_member;
grant select on agent_memory.thread_view, agent_memory.thread_post_view to agent_memory_member;

-- ===== 5. Memory session columns and history =====

alter policy memories_insert on agent_memory.memories
  with check (agent_memory.can_write(scope_id) and created_by = agent_memory.current_member_id()
    and updated_by = agent_memory.current_member_id()
    and (created_session is null or agent_memory.owns_session(created_session))
    and (updated_session is null or agent_memory.owns_session(updated_session)));
alter policy memories_update on agent_memory.memories
  with check (agent_memory.can_write(scope_id) and updated_by = agent_memory.current_member_id()
    and (created_session is null or agent_memory.owns_session(created_session))
    and (updated_session is null or agent_memory.owns_session(updated_session)));

grant insert (created_session, updated_session) on agent_memory.memories to agent_memory_member;
grant update (updated_session) on agent_memory.memories to agent_memory_member;

-- Replaces the erase-migration version; adds session_id to every history row.
create or replace function agent_memory.memories_history_fn() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_action text;
begin
  if tg_op = 'INSERT' then
    insert into agent_memory.memory_history (memory_id, action, member_id, session_id)
    values (new.id, 'insert', agent_memory.current_member_id(), new.created_session);
    return null;
  elsif tg_op = 'DELETE' then
    insert into agent_memory.memory_history (memory_id, action, member_id, prev_scope_id, session_id)
    values (old.id, 'purge', agent_memory.current_member_id(), old.scope_id, null);
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
    (memory_id, action, member_id, prev_content, prev_category, prev_tags, prev_scope_id, session_id)
  values (old.id, v_action, agent_memory.current_member_id(), old.content, old.category, old.tags, old.scope_id,
          case when v_action in ('update', 'move') then new.updated_session else null end);
  return null;
end
$$;
