begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

select has_table('agent_memory'::name, 'scopes'::name, 'scopes exists');
select has_table('agent_memory'::name, 'members'::name, 'members exists');
select has_table('agent_memory'::name, 'scope_grants'::name, 'scope_grants exists');
select has_table('agent_memory'::name, 'memories'::name, 'memories exists');
select has_table('agent_memory'::name, 'memory_history'::name, 'memory_history exists');
select has_table('agent_memory'::name, 'access_tokens'::name, 'access_tokens exists');

select has_extension('vector');
select has_extension('pg_cron');

select col_type_is('agent_memory'::name, 'memories'::name, 'embedding'::name, 'extensions.vector(384)'::text);

select ok(not has_schema_privilege('anon', 'agent_memory', 'USAGE'), 'anon has no usage on agent_memory');
select ok(not has_schema_privilege('authenticated', 'agent_memory', 'USAGE'),
  'authenticated has no usage on agent_memory');
select ok(not (select rolbypassrls from pg_roles where rolname = 'agent_memory_member'),
  'agent_memory_member does not bypass RLS');

insert into agent_memory.scopes (id, name) values ('00000000-0000-0000-0000-000000000001', 'ok-scope');

select throws_ok(
  $$insert into agent_memory.memories (scope_id, content, category, embedding)
    values ('00000000-0000-0000-0000-000000000001', 'x', 'nope', array_fill(0, array[384])::extensions.vector)$$,
  '23514', null, 'invalid category is rejected');

select throws_ok(
  $$insert into agent_memory.scopes (name) values ('Bad Name')$$,
  '23514', null, 'invalid scope name is rejected');

select * from finish();
rollback;
