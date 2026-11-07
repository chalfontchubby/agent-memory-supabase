begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

-- Fixtures (as postgres): admin ad, writer w (s1), scope s2 (empty), scope s3 (will hold only a soft-deleted thread)
insert into agent_memory.members (id, display_name, kind, is_admin) values
  ('a1000000-0000-0000-0000-000000000001', 'ad', 'human', true),
  ('11111111-1111-1111-1111-111111111111', 'w', 'human', false);
insert into agent_memory.scopes (id, name) values
  ('a1000000-0000-0000-0000-0000000000a1', 's1'),
  ('a3000000-0000-0000-0000-0000000000a3', 's3');
insert into agent_memory.scope_grants (scope_id, member_id, access) values
  ('a1000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'write'),
  ('a3000000-0000-0000-0000-0000000000a3', '11111111-1111-1111-1111-111111111111', 'write');
insert into agent_memory.threads (id, scope_id, title, created_by, post_count) values
  ('7a000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-0000000000a1', 'T1', '11111111-1111-1111-1111-111111111111', 1),
  ('7a000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-0000000000a1', 'T2 old', '11111111-1111-1111-1111-111111111111', 1),
  ('7a000000-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-0000000000a1', 'T3 recent', '11111111-1111-1111-1111-111111111111', 1),
  ('7a000000-0000-0000-0000-000000000004', 'a1000000-0000-0000-0000-0000000000a1', 'T4 erase', '11111111-1111-1111-1111-111111111111', 1),
  ('7a000000-0000-0000-0000-000000000005', 'a3000000-0000-0000-0000-0000000000a3', 'T5 s3', '11111111-1111-1111-1111-111111111111', 1);
insert into agent_memory.thread_posts (thread_id, seq, body, author_id)
select id, 1, 'body ' || title, '11111111-1111-1111-1111-111111111111' from agent_memory.threads;

-- privileges
select ok(not has_function_privilege('agent_memory_member', 'agent_memory.adm_delete_thread(uuid,uuid,text)', 'execute'), 'member cannot execute adm_delete_thread');
select ok(not has_function_privilege('agent_memory_member', 'agent_memory.restore_thread(uuid)', 'execute'), 'member cannot execute restore_thread');
select ok(not has_function_privilege('agent_memory_member', 'agent_memory.erase_thread(uuid)', 'execute'), 'member cannot execute erase_thread');
select ok(has_function_privilege('agent_memory_member', 'agent_memory.admin_delete_thread(uuid)', 'execute'), 'member can execute admin_delete_thread');
select ok(not has_function_privilege('anon', 'agent_memory.admin_delete_thread(uuid)', 'execute'), 'anon cannot execute admin_delete_thread');

-- non-admin refused
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select throws_ok($$select agent_memory.admin_delete_thread('7a000000-0000-0000-0000-000000000001')$$,
  '42501', 'Admin only', 'non-admin cannot delete a thread');
reset role;

-- admin deletes
select set_config('agent_memory.member_id', 'a1000000-0000-0000-0000-000000000001', true);
set local role agent_memory_member;
select lives_ok($$select agent_memory.admin_delete_thread('7a000000-0000-0000-0000-000000000001')$$, 'admin deletes the thread');
reset role;
select is((select count(*) from agent_memory.admin_log where action = 'delete_thread' and target = '7a000000-0000-0000-0000-000000000001' and actor_label = 'ad' and details = '{"scope": "s1", "title": "T1"}'::jsonb), 1::bigint, 'admin_log row written');

select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.thread_view where id = '7a000000-0000-0000-0000-000000000001'), 0::bigint, 'members cannot see the deleted thread');
select is((select count(*) from agent_memory.thread_post_view where thread_id = '7a000000-0000-0000-0000-000000000001'), 0::bigint, 'members cannot see its posts');
reset role;

select set_config('agent_memory.member_id', 'a1000000-0000-0000-0000-000000000001', true);
set local role agent_memory_member;
select throws_ok($$select agent_memory.admin_delete_thread('7a000000-0000-0000-0000-000000000001')$$,
  'P0001', 'Thread 7a000000-0000-0000-0000-000000000001 not found', 'deleting again raises not found');
reset role;

-- restore
select is(agent_memory.restore_thread('7a000000-0000-0000-0000-000000000001'), true, 'restore_thread brings it back');
select is(agent_memory.restore_thread('7a000000-0000-0000-0000-000000000001'), false, 'restore_thread of a live thread is false');
select is((select deleted_at is null from agent_memory.threads where id = '7a000000-0000-0000-0000-000000000001'), true, 'thread is live again');

-- purge
update agent_memory.threads set deleted_at = now() - interval '31 days' where id = '7a000000-0000-0000-0000-000000000002';
update agent_memory.threads set deleted_at = now() - interval '1 day' where id = '7a000000-0000-0000-0000-000000000003';
select agent_memory.purge_tombstones();
select is((select count(*) from agent_memory.threads where id = '7a000000-0000-0000-0000-000000000002'), 0::bigint, '31-day-old deleted thread purged');
select is((select count(*) from agent_memory.thread_posts where thread_id = '7a000000-0000-0000-0000-000000000002'), 0::bigint, 'its posts are gone');
select is((select count(*) from agent_memory.threads where id = '7a000000-0000-0000-0000-000000000003'), 1::bigint, '1-day-old deleted thread survives');

-- scope guard: s3 holds only a soft-deleted thread
update agent_memory.threads set deleted_at = now() where id = '7a000000-0000-0000-0000-000000000005';
select throws_ok($$select agent_memory.adm_delete_scope('s3', 'a1000000-0000-0000-0000-000000000001', 'ad')$$,
  'P0001', 'Scope ''s3'' still holds 1 threads; delete or erase them first', 'scope with a soft-deleted thread cannot be deleted');

-- erase
select is(agent_memory.erase_thread('7a000000-0000-0000-0000-000000000004'), true, 'erase_thread removes a live thread');
select is(agent_memory.erase_thread('7a000000-0000-0000-0000-000000000004'), false, 'erase_thread of a missing thread is false');

select * from finish();
rollback;
