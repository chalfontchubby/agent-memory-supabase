-- Tables, indexes, extensions and the member role for the hosted agent memory.
-- Everything lives in schema agent_memory, which is never exposed over the Data API.

create extension if not exists vector with schema extensions;
create extension if not exists pg_cron;

create schema if not exists agent_memory;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'agent_memory_member') then
    create role agent_memory_member nologin nobypassrls;
  end if;
end
$$;
grant agent_memory_member to postgres;

create table agent_memory.scopes (
  id uuid primary key default gen_random_uuid(),
  name text unique not null check (name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  description text,
  created_at timestamptz not null default now()
);

create table agent_memory.members (
  id uuid primary key default gen_random_uuid(),
  display_name text unique not null,
  kind text not null check (kind in ('human', 'bot')),
  email text,
  auth_user_id uuid null, -- deliberately no FK to auth.users: installable anywhere
  created_at timestamptz not null default now()
);

create table agent_memory.scope_grants (
  scope_id uuid not null references agent_memory.scopes (id) on delete cascade,
  member_id uuid not null references agent_memory.members (id) on delete cascade,
  access text not null check (access in ('read', 'write')),
  granted_at timestamptz not null default now(),
  granted_by text,
  primary key (scope_id, member_id)
);

create table agent_memory.memories (
  id uuid primary key default gen_random_uuid(),
  scope_id uuid not null references agent_memory.scopes (id),
  content text not null,
  category text not null check (category in (
    'code-solution', 'bug-fix', 'architecture', 'learning', 'tool-usage', 'debugging',
    'performance', 'security', 'observation', 'personal', 'relationship', 'other'
  )),
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references agent_memory.members (id),
  updated_by uuid references agent_memory.members (id),
  access_count int not null default 0,
  last_accessed_at timestamptz,
  deleted_at timestamptz,
  embedding extensions.vector(384) not null,
  fts tsvector generated always as (to_tsvector('english', content)) stored
);

-- No FK on memory_id: history outlives a hard purge of the memory.
create table agent_memory.memory_history (
  id bigint generated always as identity primary key,
  memory_id uuid not null,
  action text not null check (action in ('insert', 'update', 'move', 'delete', 'restore', 'purge')),
  member_id uuid null,
  at timestamptz not null default now(),
  prev_content text,
  prev_category text,
  prev_tags text[],
  prev_scope_id uuid
);

create table agent_memory.access_tokens (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references agent_memory.members (id) on delete cascade,
  name text,
  token_hash text unique not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);

create index memories_fts_idx on agent_memory.memories using gin (fts);
create index memories_tags_idx on agent_memory.memories using gin (tags);
create index memories_scope_created_idx on agent_memory.memories (scope_id, created_at desc) where deleted_at is null;
create index memories_deleted_idx on agent_memory.memories (deleted_at) where deleted_at is not null;

revoke all on schema agent_memory from public, anon, authenticated;
revoke all on all tables in schema agent_memory from public, anon, authenticated;
