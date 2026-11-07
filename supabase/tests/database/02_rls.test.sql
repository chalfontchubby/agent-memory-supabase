begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

-- pgTAP runs inside the member role below, so let it reach the extensions schema (rolled back).
grant usage on schema extensions to agent_memory_member;
grant all on all tables in schema extensions to agent_memory_member;

-- Fixtures (as postgres)
insert into agent_memory.scopes (id, name) values
  ('a0000000-0000-0000-0000-00000000000a', 'alpha'),
  ('b0000000-0000-0000-0000-00000000000b', 'beta');
insert into agent_memory.members (id, display_name, kind) values
  ('11111111-1111-1111-1111-111111111111', 'rw', 'human'),
  ('22222222-2222-2222-2222-222222222222', 'ro', 'human'),
  ('33333333-3333-3333-3333-333333333333', 'none', 'human'),
  ('44444444-4444-4444-4444-444444444444', 'bw', 'bot');
insert into agent_memory.scope_grants (scope_id, member_id, access) values
  ('a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'write'),
  ('a0000000-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222', 'read'),
  ('b0000000-0000-0000-0000-00000000000b', '44444444-4444-4444-4444-444444444444', 'write');
insert into agent_memory.memories (id, scope_id, content, category, created_by, embedding) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'alpha mem', 'other',
   '11111111-1111-1111-1111-111111111111', array_fill(0.1::real, array[384])::extensions.vector),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 'beta mem', 'other',
   '44444444-4444-4444-4444-444444444444', array_fill(0.1::real, array[384])::extensions.vector);

-- ro
select set_config('agent_memory.member_id', '22222222-2222-2222-2222-222222222222', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.memories), 1::bigint, 'ro sees only alpha memory');
select is((select count(*) from agent_memory.scopes), 1::bigint, 'ro sees only alpha scope');
select is((select count(*) from agent_memory.scope_grants), 1::bigint, 'ro sees only own grants');
select throws_ok(
  $$insert into agent_memory.memories (scope_id, content, category, created_by, embedding)
    values ('a0000000-0000-0000-0000-00000000000a', 'x', 'other', '22222222-2222-2222-2222-222222222222',
            array_fill(0.1::real, array[384])::extensions.vector)$$,
  '42501', null, 'ro cannot insert into alpha');
with u as (update agent_memory.memories set content = 'hacked'
           where id = 'aaaaaaaa-0000-0000-0000-000000000001' returning 1)
select is((select count(*) from u), 0::bigint, 'ro update touches 0 rows');
select throws_ok($$select count(*) from agent_memory.access_tokens$$, '42501', null, 'member cannot read access_tokens');
select throws_ok($$select count(*) from agent_memory.members$$, '42501', null, 'member cannot read members');
select throws_ok($$select count(*) from agent_memory.memory_history$$, '42501', null, 'member cannot read memory_history');
select throws_ok(
  $$insert into agent_memory.scope_grants (scope_id, member_id, access)
    values ('a0000000-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222', 'write')$$,
  '42501', null, 'member cannot insert grants');
reset role;

-- none
select set_config('agent_memory.member_id', '33333333-3333-3333-3333-333333333333', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.memories), 0::bigint, 'member with no grants sees nothing');
reset role;

-- no member id set
select set_config('agent_memory.member_id', '', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.memories), 0::bigint, 'no member id sees nothing');
reset role;

-- bw
select set_config('agent_memory.member_id', '44444444-4444-4444-4444-444444444444', true);
set local role agent_memory_member;
select is((select content from agent_memory.memories), 'beta mem', 'bw sees only beta memory');
reset role;

-- rw
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select is((select content from agent_memory.memories), 'alpha mem', 'rw sees only alpha memory');
select throws_ok(
  $$insert into agent_memory.memories (scope_id, content, category, created_by, embedding)
    values ('b0000000-0000-0000-0000-00000000000b', 'x', 'other', '11111111-1111-1111-1111-111111111111',
            array_fill(0.1::real, array[384])::extensions.vector)$$,
  '42501', null, 'rw cannot insert into beta');
select throws_ok(
  $$insert into agent_memory.memories (scope_id, content, category, created_by, embedding)
    values ('a0000000-0000-0000-0000-00000000000a', 'x', 'other', '44444444-4444-4444-4444-444444444444',
            array_fill(0.1::real, array[384])::extensions.vector)$$,
  '42501', null, 'rw cannot insert with another created_by');
select throws_ok(
  $$update agent_memory.memories set scope_id = 'b0000000-0000-0000-0000-00000000000b'
    where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  '42501', null, 'rw cannot move to a scope without write');
reset role;

-- grant rw write on beta; move now succeeds
insert into agent_memory.scope_grants (scope_id, member_id, access) values
  ('b0000000-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', 'write');
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
with u as (update agent_memory.memories set scope_id = 'b0000000-0000-0000-0000-00000000000b'
           where id = 'aaaaaaaa-0000-0000-0000-000000000001' returning 1)
select is((select count(*) from u), 1::bigint, 'rw with write on both can move');
reset role;

-- soft-deleted invisible
update agent_memory.memories set deleted_at = now() where id = 'bbbbbbbb-0000-0000-0000-000000000001';
select set_config('agent_memory.member_id', '44444444-4444-4444-4444-444444444444', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.memories where id = 'bbbbbbbb-0000-0000-0000-000000000001'),
  0::bigint, 'soft-deleted row invisible');
select throws_ok($$delete from agent_memory.memories$$, '42501', null, 'member cannot hard delete');
reset role;

select is((select count(*) from pg_tables where schemaname = 'agent_memory' and tableowner = 'agent_memory_member'),
  0::bigint, 'member owns no tables');

set local role anon;
select throws_ok($$select * from agent_memory.memories$$, '42501', null, 'anon has no access');
reset role;

select * from finish();
rollback;
