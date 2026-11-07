begin;
create extension if not exists pgtap with schema extensions;
select plan(36);

-- Fixtures (as postgres): w writes s1 and s2, r reads s1, o has no grants.
insert into agent_memory.scopes (id, name) values
  ('a1000000-0000-0000-0000-0000000000a1', 's1'),
  ('a2000000-0000-0000-0000-0000000000a2', 's2');
insert into agent_memory.members (id, display_name, kind) values
  ('11111111-1111-1111-1111-111111111111', 'w', 'human'),
  ('22222222-2222-2222-2222-222222222222', 'r', 'human'),
  ('33333333-3333-3333-3333-333333333333', 'o', 'human'),
  ('44444444-4444-4444-4444-444444444444', 'w2', 'human');
insert into agent_memory.scope_grants (scope_id, member_id, access) values
  ('a1000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'write'),
  ('a2000000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', 'write'),
  ('a1000000-0000-0000-0000-0000000000a1', '22222222-2222-2222-2222-222222222222', 'read'),
  ('a1000000-0000-0000-0000-0000000000a1', '44444444-4444-4444-4444-444444444444', 'write');
insert into agent_memory.memories (id, scope_id, content, category, created_by, updated_by, embedding) values
  ('aaaaaaaa-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-0000000000a2', 's2 mem', 'other',
   '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   array_fill(0.1::real, array[384])::extensions.vector);
insert into agent_memory.agent_sessions (id, member_id, label) values
  ('51111111-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'wlabel'),
  ('52222222-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'rlabel'),
  ('54444444-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444444', 'w2label');
insert into agent_memory.threads (id, scope_id, title, created_by) values
  ('7a000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-0000000000a1', 'T1',
   '11111111-1111-1111-1111-111111111111');
insert into agent_memory.thread_posts (thread_id, seq, kind, body, author_id) values
  ('7a000000-0000-0000-0000-000000000001', 1, 'post', 'hello', '11111111-1111-1111-1111-111111111111');
insert into agent_memory.thread_links (thread_id, memory_id, linked_by) values
  ('7a000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111111');
insert into agent_memory.thread_subscriptions (session_id, thread_id, last_seen_seq) values
  ('51111111-0000-0000-0000-000000000001', '7a000000-0000-0000-0000-000000000001', 0),
  ('52222222-0000-0000-0000-000000000001', '7a000000-0000-0000-0000-000000000001', 0);

-- Function privileges
select ok(not has_function_privilege('anon', 'agent_memory.resolve_session(uuid, text, boolean)', 'execute'), 'anon cannot execute resolve_session');
select ok(not has_function_privilege('authenticated', 'agent_memory.resolve_session(uuid, text, boolean)', 'execute'), 'authenticated cannot execute resolve_session');
select ok(not has_function_privilege('anon', 'agent_memory.can_read_thread(uuid)', 'execute'), 'anon cannot execute can_read_thread');
select ok(not has_function_privilege('authenticated', 'agent_memory.can_write_thread(uuid)', 'execute'), 'authenticated cannot execute can_write_thread');
select ok(not has_function_privilege('authenticated', 'agent_memory.owns_session(uuid)', 'execute'), 'authenticated cannot execute owns_session');
select ok(not has_function_privilege('anon', 'agent_memory.session_label(uuid)', 'execute'), 'anon cannot execute session_label');
select ok(has_function_privilege('agent_memory_member', 'agent_memory.resolve_session(uuid, text, boolean)', 'execute'), 'member can execute resolve_session');
select ok(
  not exists (
    select 1 from unnest(array['agent_sessions', 'threads', 'thread_posts', 'thread_links', 'thread_subscriptions']) t
    cross join unnest(array['insert', 'update', 'delete']) p
    where has_table_privilege('agent_memory_member', 'agent_memory.' || t, p)),
  'member has no insert/update/delete on any new table');

-- w
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
create temp table res as select * from agent_memory.resolve_session(null, null, true);
grant all on res to public;
select is((select count(*) from res where created and label is null), 1::bigint, 'resolve_session(null,null,true) creates a session');
select is((select count(*) from agent_memory.resolve_session(null, null, false)), 0::bigint, 'resolve_session(null,null,false) returns no rows');
select throws_ok($$select * from agent_memory.resolve_session(null, 'x', false)$$, 'P0001', 'Session not found', 'unknown label without create raises');
select is((select count(*) from agent_memory.agent_sessions where label = 'x'), 0::bigint, 'no row created for failed label lookup');
create temp table x1 as select * from agent_memory.resolve_session(null, 'x', true);
select is((select r.id from agent_memory.resolve_session(null, 'x', true) r), (select id from x1), 'label create is idempotent');
select throws_ok($$select * from agent_memory.resolve_session('52222222-0000-0000-0000-000000000001', null, false)$$,
  'P0001', 'Session not found', 'another member''s session id raises');
select throws_ok($$select * from agent_memory.resolve_session('51111111-0000-0000-0000-000000000001', 'other', false)$$,
  'P0001', 'Session label does not match', 'mismatched label raises');
select throws_ok($$select * from agent_memory.resolve_session((select id from res), 'wlabel', false)$$,
  'P0001', 'Session label ''wlabel'' is already in use', 'duplicate label raises');
select is((select r.label from agent_memory.resolve_session((select id from res), 'attached', false) r), 'attached', 'label attached to unlabelled session');
select throws_ok($$select * from agent_memory.resolve_session(null, '  x', true)$$,
  'P0001', 'Session label must be 1-64 characters with no leading or trailing space', 'leading space refused');
select is(agent_memory.session_label('51111111-0000-0000-0000-000000000001'), 'wlabel', 'session_label returns label');
select ok(agent_memory.owns_session('51111111-0000-0000-0000-000000000001'), 'w owns own session');
select ok(not agent_memory.owns_session('52222222-0000-0000-0000-000000000001'), 'w does not own r session');
select ok(agent_memory.can_write_thread('7a000000-0000-0000-0000-000000000001'), 'w can write thread');
select is((select count(*) from agent_memory.thread_links), 1::bigint, 'w sees link to s2 memory');
select is((select created_by from agent_memory.thread_view), 'w', 'thread_view shows author name');
select is((select last_author from agent_memory.thread_view), 'w', 'thread_view shows last author');
select is((select body from agent_memory.thread_post_view), 'hello', 'thread_post_view readable');

-- Memory inserts
select throws_ok(
  $$insert into agent_memory.memories (scope_id, content, category, created_by, updated_by, created_session, embedding)
    values ('a1000000-0000-0000-0000-0000000000a1', 'x', 'other', '11111111-1111-1111-1111-111111111111',
            '11111111-1111-1111-1111-111111111111', '52222222-0000-0000-0000-000000000001',
            array_fill(0.1::real, array[384])::extensions.vector)$$,
  '42501', 'new row violates row-level security policy for table "memories"', 'foreign created_session fails RLS');
insert into agent_memory.memories (scope_id, content, category, created_by, updated_by, created_session, updated_session, embedding)
values ('a1000000-0000-0000-0000-0000000000a1', 'with session', 'other',
        '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
        '51111111-0000-0000-0000-000000000001', '51111111-0000-0000-0000-000000000001',
        array_fill(0.1::real, array[384])::extensions.vector);
select is((select created_session_label from agent_memory.memory_view where content = 'with session'),
  'wlabel', 'memory_view.created_session_label shows the label');
reset role;
select is((select session_id from agent_memory.memory_history where memory_id = (select id from agent_memory.memories where content = 'with session')),
  '51111111-0000-0000-0000-000000000001'::uuid, 'history session_id records created_session');

-- w2: a second writer can update a memory created in another member's session
select set_config('agent_memory.member_id', '44444444-4444-4444-4444-444444444444', true);
set local role agent_memory_member;
with u as (update agent_memory.memories set content = 'edited by w2', updated_by = '44444444-4444-4444-4444-444444444444',
           updated_session = null where content = 'with session' returning 1)
select is((select count(*) from u), 1::bigint, 'second writer updates memory created in another member''s session');
with u as (update agent_memory.memories set content = 'edited again', updated_by = '44444444-4444-4444-4444-444444444444',
           updated_session = '54444444-0000-0000-0000-000000000001' where content = 'edited by w2' returning 1)
select is((select count(*) from u), 1::bigint, 'second writer updates with their own updated_session');
reset role;

-- r
select set_config('agent_memory.member_id', '22222222-2222-2222-2222-222222222222', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.agent_sessions), 1::bigint, 'r sees only own sessions');
select is((select count(*) from agent_memory.thread_subscriptions), 1::bigint, 'r sees only own subscriptions');
select is((select count(*) from agent_memory.thread_links), 0::bigint, 'r cannot see link to s2 memory');
select is((select count(*) from agent_memory.threads), 1::bigint, 'r sees s1 thread');
reset role;

-- o
select set_config('agent_memory.member_id', '33333333-3333-3333-3333-333333333333', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.threads) + (select count(*) from agent_memory.thread_posts)
  + (select count(*) from agent_memory.thread_links), 0::bigint, 'outsider sees no threads, posts or links');
reset role;

select * from finish();
rollback;
