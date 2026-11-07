begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

insert into agent_memory.scopes (id, name) values ('e0000000-0000-0000-0000-00000000000e', 'erase-scope');
insert into agent_memory.members (id, display_name, kind) values
  ('55555555-5555-5555-5555-555555555555', 'eraser', 'human');
insert into agent_memory.scope_grants (scope_id, member_id, access) values
  ('e0000000-0000-0000-0000-00000000000e', '55555555-5555-5555-5555-555555555555', 'write');

-- p: purged by tombstone expiry; l: erased while live; s: erased while soft-deleted; k: kept (control)
insert into agent_memory.memories (id, scope_id, content, category, tags, created_by, updated_by, embedding)
select v.id::uuid, 'e0000000-0000-0000-0000-00000000000e', v.content, 'other', '{secret-tag}',
  '55555555-5555-5555-5555-555555555555', '55555555-5555-5555-5555-555555555555',
  array_fill(0.1::real, array[384])::extensions.vector
from (values
  ('eeeeeeee-0000-0000-0000-00000000000a', 'purge me'),
  ('eeeeeeee-0000-0000-0000-00000000000b', 'erase me live'),
  ('eeeeeeee-0000-0000-0000-00000000000c', 'erase me deleted'),
  ('eeeeeeee-0000-0000-0000-00000000000d', 'keep me')) as v(id, content);

-- As the member: change content and tags, then soft-delete, so history holds old content.
select set_config('agent_memory.member_id', '55555555-5555-5555-5555-555555555555', true);
set local role agent_memory_member;
update agent_memory.memories set content = content || ' v2', category = 'learning', tags = '{t2}',
  updated_by = '55555555-5555-5555-5555-555555555555';
select agent_memory.soft_delete(array['eeeeeeee-0000-0000-0000-00000000000a', 'eeeeeeee-0000-0000-0000-00000000000c']::uuid[]);
reset role;
select set_config('agent_memory.member_id', '', true);

select is((select count(*) from agent_memory.memory_history
  where memory_id = 'eeeeeeee-0000-0000-0000-00000000000a' and prev_content is not null),
  2::bigint, 'before purge: update and delete rows hold previous content');

-- (b) tombstone purge
update agent_memory.memories set deleted_at = now() - interval '31 days'
  where id = 'eeeeeeee-0000-0000-0000-00000000000a';
select is(agent_memory.purge_tombstones(), 1, 'purge_tombstones purges the expired tombstone');
select is((select count(*) from agent_memory.memories where id = 'eeeeeeee-0000-0000-0000-00000000000a'),
  0::bigint, 'purged memory is gone');
select is((select count(*) from agent_memory.memory_history
  where memory_id = 'eeeeeeee-0000-0000-0000-00000000000a'
    and (prev_content is not null or prev_tags is not null or prev_category is not null)),
  0::bigint, 'purge: no history row keeps content, tags or category');
select is((select array_agg(action order by id) from agent_memory.memory_history
  where memory_id = 'eeeeeeee-0000-0000-0000-00000000000a'),
  array['insert', 'update', 'delete', 'purge'], 'purge: the history trail itself is kept');
select is((select count(*) from agent_memory.memory_history
  where memory_id = 'eeeeeeee-0000-0000-0000-00000000000a' and action = 'purge' and member_id is null),
  1::bigint, 'purge row exists with member_id null');
select is((select prev_scope_id from agent_memory.memory_history
  where memory_id = 'eeeeeeee-0000-0000-0000-00000000000a' and action = 'purge'),
  'e0000000-0000-0000-0000-00000000000e'::uuid, 'purge row keeps the scope');

-- (c) erase a live memory
select is(agent_memory.erase('eeeeeeee-0000-0000-0000-00000000000b'), true, 'erase of a live memory returns true');
select is((select count(*) from agent_memory.memories where id = 'eeeeeeee-0000-0000-0000-00000000000b'),
  0::bigint, 'erased live memory is gone');
select is((select count(*) from agent_memory.memory_history
  where memory_id = 'eeeeeeee-0000-0000-0000-00000000000b'
    and (prev_content is not null or prev_tags is not null or prev_category is not null)),
  0::bigint, 'erase live: no history row keeps content, tags or category');
select is((select count(*) from agent_memory.memory_history
  where memory_id = 'eeeeeeee-0000-0000-0000-00000000000b' and action = 'purge' and member_id is null),
  1::bigint, 'erase live: purge row exists with member_id null');

-- erase a soft-deleted memory, well inside the 30 days
select is(agent_memory.erase('eeeeeeee-0000-0000-0000-00000000000c'), true, 'erase of a soft-deleted memory returns true');
select is((select count(*) from agent_memory.memories where id = 'eeeeeeee-0000-0000-0000-00000000000c'),
  0::bigint, 'erased soft-deleted memory is gone');
select is((select count(*) from agent_memory.memory_history
  where memory_id = 'eeeeeeee-0000-0000-0000-00000000000c'
    and (prev_content is not null or prev_tags is not null or prev_category is not null)),
  0::bigint, 'erase deleted: no history row keeps content, tags or category');
select is((select count(*) from agent_memory.memory_history
  where memory_id = 'eeeeeeee-0000-0000-0000-00000000000c' and action = 'purge' and member_id is null),
  1::bigint, 'erase deleted: purge row exists with member_id null');

select is(agent_memory.erase('eeeeeeee-0000-0000-0000-00000000000c'), false, 'erase of an erased id returns false');
select is(agent_memory.erase('eeeeeeee-0000-0000-0000-0000000000ff'), false, 'erase of an unknown id returns false');

-- The scrub is targeted: other memories keep their history.
select is((select prev_content from agent_memory.memory_history
  where memory_id = 'eeeeeeee-0000-0000-0000-00000000000d' and action = 'update'),
  'keep me', 'an unrelated memory keeps its history');
select is((select count(*) from agent_memory.memories where id = 'eeeeeeee-0000-0000-0000-00000000000d'),
  1::bigint, 'an unrelated memory is untouched');

-- Privileges: erase and scrub_history are postgres-only.
select set_config('agent_memory.member_id', '55555555-5555-5555-5555-555555555555', true);
set local role agent_memory_member;
select throws_ok($$select agent_memory.erase('eeeeeeee-0000-0000-0000-00000000000d')$$,
  '42501', 'permission denied for function erase', 'member cannot erase');
select throws_ok($$select agent_memory.scrub_history(array['eeeeeeee-0000-0000-0000-00000000000d']::uuid[])$$,
  '42501', 'permission denied for function scrub_history', 'member cannot scrub history');
reset role;
select is((select count(*) from agent_memory.memories where id = 'eeeeeeee-0000-0000-0000-00000000000d'),
  1::bigint, 'the denied erase changed nothing');

select * from finish();
rollback;
