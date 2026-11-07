begin;
create extension if not exists pgtap with schema extensions;
select plan(29);

grant usage on schema extensions to agent_memory_member;

insert into agent_memory.scopes (id, name) values
  ('a0000000-0000-0000-0000-00000000000a', 'alpha'),
  ('b0000000-0000-0000-0000-00000000000b', 'beta'),
  ('c0000000-0000-0000-0000-00000000000c', 'gamma');
insert into agent_memory.members (id, display_name, kind) values
  ('11111111-1111-1111-1111-111111111111', 'rw', 'human'),
  ('22222222-2222-2222-2222-222222222222', 'ro', 'human'),
  ('44444444-4444-4444-4444-444444444444', 'bw', 'bot');
insert into agent_memory.scope_grants (scope_id, member_id, access) values
  ('a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'write'),
  ('c0000000-0000-0000-0000-00000000000c', '11111111-1111-1111-1111-111111111111', 'write'),
  ('a0000000-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222', 'read'),
  ('b0000000-0000-0000-0000-00000000000b', '44444444-4444-4444-4444-444444444444', 'write');
insert into agent_memory.memories (id, scope_id, content, category, tags, created_by, updated_by, embedding) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'alpha mem', 'other', '{t1}',
   '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   array_fill(0.1::real, array[384])::extensions.vector),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 'beta mem', 'other', '{}',
   '44444444-4444-4444-4444-444444444444', '44444444-4444-4444-4444-444444444444',
   array_fill(0.1::real, array[384])::extensions.vector);

-- Tokens
insert into agent_memory.access_tokens (member_id, token_hash, revoked_at, expires_at) values
  ('11111111-1111-1111-1111-111111111111', encode(extensions.digest('amm_ok', 'sha256'), 'hex'), null, null),
  ('11111111-1111-1111-1111-111111111111', encode(extensions.digest('amm_revoked', 'sha256'), 'hex'), now(), null),
  ('11111111-1111-1111-1111-111111111111', encode(extensions.digest('amm_expired', 'sha256'), 'hex'), null, now() - interval '1 day'),
  ('22222222-2222-2222-2222-222222222222', encode(extensions.digest('amm_future', 'sha256'), 'hex'), null, now() + interval '1 day');

select is(agent_memory.resolve_token(encode(extensions.digest('amm_ok', 'sha256'), 'hex')),
  '11111111-1111-1111-1111-111111111111'::uuid, 'valid token resolves to member');
select isnt((select last_used_at from agent_memory.access_tokens where token_hash = encode(extensions.digest('amm_ok', 'sha256'), 'hex')),
  null, 'last_used_at set');
select is(agent_memory.resolve_token(encode(extensions.digest('amm_future', 'sha256'), 'hex')),
  '22222222-2222-2222-2222-222222222222'::uuid, 'unexpired token resolves');
select is(agent_memory.resolve_token(encode(extensions.digest('amm_revoked', 'sha256'), 'hex')), null, 'revoked token null');
select is(agent_memory.resolve_token(encode(extensions.digest('amm_expired', 'sha256'), 'hex')), null, 'expired token null');
select is(agent_memory.resolve_token(encode(extensions.digest('amm_nope', 'sha256'), 'hex')), null, 'unknown token null');

-- History for insert
select is((select count(*) from agent_memory.memory_history where memory_id = 'aaaaaaaa-0000-0000-0000-000000000001' and action = 'insert'),
  1::bigint, 'insert writes history');

-- touch_accessed as ro (backdate so the one-hour guard allows the first touch)
update agent_memory.memories set updated_at = now() - interval '2 hours'
  where id in ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001');
select set_config('agent_memory.member_id', '22222222-2222-2222-2222-222222222222', true);
set local role agent_memory_member;
select agent_memory.touch_accessed(array['aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001']::uuid[]);
select is((select access_count from agent_memory.memories where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 1, 'touch increments readable memory');
select agent_memory.touch_accessed(array['aaaaaaaa-0000-0000-0000-000000000001']::uuid[]);
select is((select access_count from agent_memory.memories where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 1, 'second touch within the hour ignored');
select is((select content from agent_memory.memories where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'alpha mem', 'content unchanged by touch');
reset role;
select is((select access_count from agent_memory.memories where id = 'bbbbbbbb-0000-0000-0000-000000000001'), 0, 'unreadable memory not touched');
select is((select count(*) from agent_memory.memory_history where memory_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  1::bigint, 'touch writes no history');

-- soft_delete
select set_config('agent_memory.member_id', '22222222-2222-2222-2222-222222222222', true);
set local role agent_memory_member;
select is(agent_memory.soft_delete(array['aaaaaaaa-0000-0000-0000-000000000001']::uuid[]), '{}'::uuid[], 'ro soft_delete deletes nothing');
reset role;
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select is(agent_memory.soft_delete(array['aaaaaaaa-0000-0000-0000-000000000001']::uuid[]),
  array['aaaaaaaa-0000-0000-0000-000000000001']::uuid[], 'rw soft_delete returns id');
select is((select count(*) from agent_memory.memories where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 0::bigint, 'deleted row invisible');
reset role;
select set_config('agent_memory.member_id', '', true);
select is(agent_memory.restore('aaaaaaaa-0000-0000-0000-000000000001'), true, 'restore returns true');
select is(agent_memory.restore('aaaaaaaa-0000-0000-0000-000000000001'), false, 'restore of live row returns false');
select is((select array_agg(action order by id) from agent_memory.memory_history
  where memory_id = 'aaaaaaaa-0000-0000-0000-000000000001' and action in ('delete', 'restore')),
  array['delete', 'restore'], 'delete then restore in history');
select is((select member_id from agent_memory.memory_history where memory_id = 'aaaaaaaa-0000-0000-0000-000000000001' and action = 'delete'),
  '11111111-1111-1111-1111-111111111111'::uuid, 'delete attributed to rw');
select is((select member_id from agent_memory.memory_history where memory_id = 'aaaaaaaa-0000-0000-0000-000000000001' and action = 'restore'),
  null, 'restore by admin has null member');

-- update and move as rw
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
update agent_memory.memories set tags = '{t2}', updated_by = '11111111-1111-1111-1111-111111111111'
  where id = 'aaaaaaaa-0000-0000-0000-000000000001';
update agent_memory.memories set scope_id = 'c0000000-0000-0000-0000-00000000000c', updated_by = '11111111-1111-1111-1111-111111111111'
  where id = 'aaaaaaaa-0000-0000-0000-000000000001';
reset role;
select is((select prev_tags from agent_memory.memory_history where memory_id = 'aaaaaaaa-0000-0000-0000-000000000001' and action = 'update'),
  array['t1'], 'update history has previous tags');
select is((select prev_scope_id from agent_memory.memory_history where memory_id = 'aaaaaaaa-0000-0000-0000-000000000001' and action = 'move'),
  'a0000000-0000-0000-0000-00000000000a'::uuid, 'move history has previous scope');

-- purge
insert into agent_memory.memories (id, scope_id, content, category, deleted_at, embedding) values
  ('dddddddd-0000-0000-0000-000000000031', 'a0000000-0000-0000-0000-00000000000a', 'old', 'other', now() - interval '31 days',
   array_fill(0.1::real, array[384])::extensions.vector),
  ('dddddddd-0000-0000-0000-000000000029', 'a0000000-0000-0000-0000-00000000000a', 'recent', 'other', now() - interval '29 days',
   array_fill(0.1::real, array[384])::extensions.vector);
select is(agent_memory.purge_tombstones(), 1, 'purge removes one row');
select is((select count(*) from agent_memory.memories where id = 'dddddddd-0000-0000-0000-000000000031'), 0::bigint, '31-day row gone');
select is((select count(*) from agent_memory.memories where id = 'dddddddd-0000-0000-0000-000000000029'), 1::bigint, '29-day row kept');
select is((select count(*) from agent_memory.memory_history where memory_id = 'dddddddd-0000-0000-0000-000000000031' and action = 'purge'),
  1::bigint, 'purge recorded in history');

select is((select count(*) from cron.job where jobname = 'agent-memory-purge-tombstones'), 1::bigint, 'cron job scheduled');

-- member privileges
set local role agent_memory_member;
select throws_ok($$select agent_memory.resolve_token('x')$$, '42501', 'permission denied for function resolve_token', 'member cannot resolve_token');
select throws_ok($$select agent_memory.restore('aaaaaaaa-0000-0000-0000-000000000001')$$, '42501', 'permission denied for function restore', 'member cannot restore');
reset role;

select * from finish();
rollback;
