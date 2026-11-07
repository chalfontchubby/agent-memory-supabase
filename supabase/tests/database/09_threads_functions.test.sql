begin;
create extension if not exists pgtap with schema extensions;
select plan(60);

-- Fixtures (as postgres): w writes s1, r reads s1, o has no grants. s3 is granted to nobody.
insert into agent_memory.scopes (id, name) values
  ('a1000000-0000-0000-0000-0000000000a1', 's1'),
  ('a3000000-0000-0000-0000-0000000000a3', 's3');
insert into agent_memory.members (id, display_name, kind) values
  ('11111111-1111-1111-1111-111111111111', 'w', 'human'),
  ('22222222-2222-2222-2222-222222222222', 'r', 'human');
insert into agent_memory.scope_grants (scope_id, member_id, access) values
  ('a1000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'write'),
  ('a1000000-0000-0000-0000-0000000000a1', '22222222-2222-2222-2222-222222222222', 'read');
insert into agent_memory.memories (id, scope_id, content, category, created_by, updated_by, embedding) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-0000000000a1', 's1 mem', 'other',
   '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   array_fill(0.1::real, array[384])::extensions.vector),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'a3000000-0000-0000-0000-0000000000a3', 's3 mem', 'other',
   '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   array_fill(0.1::real, array[384])::extensions.vector);
insert into agent_memory.agent_sessions (id, member_id, label) values
  ('51111111-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'A'),
  ('51111111-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', 'B'),
  ('51111111-0000-0000-0000-00000000000c', '11111111-1111-1111-1111-111111111111', 'C'),
  ('52222222-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'rlabel');
insert into agent_memory.threads (id, scope_id, title, created_by) values
  ('7a000000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-0000000000a1', 'T0',
   '11111111-1111-1111-1111-111111111111');

-- Function privileges
select ok(not has_function_privilege('agent_memory_member', 'agent_memory.append_post(uuid, text, text, uuid)', 'execute'), 'member cannot execute append_post');
select ok(not has_function_privilege('anon', 'agent_memory.create_thread(uuid, text, text, uuid[], uuid)', 'execute'), 'anon cannot execute create_thread');
select ok(has_function_privilege('agent_memory_member', 'agent_memory.create_thread(uuid, text, text, uuid[], uuid)', 'execute'), 'member can execute create_thread');
select ok(has_function_privilege('agent_memory_member', 'agent_memory.whats_new(uuid)', 'execute'), 'member can execute whats_new');

-- r: read-only member is refused everywhere
select set_config('agent_memory.member_id', '22222222-2222-2222-2222-222222222222', true);
set local role agent_memory_member;
select throws_ok($$select agent_memory.create_thread('a1000000-0000-0000-0000-0000000000a1', 'x', 'y', null, null)$$,
  'P0001', 'No write access to scope ''s1''', 'read-only cannot create_thread');
select throws_ok($$select agent_memory.post_to_thread('7a000000-0000-0000-0000-000000000000', 'y', null)$$,
  'P0001', 'No write access to scope ''s1''', 'read-only cannot post_to_thread');
select throws_ok($$select agent_memory.set_thread_status('7a000000-0000-0000-0000-000000000000', 'resolved', null, null)$$,
  'P0001', 'No write access to scope ''s1''', 'read-only cannot set_thread_status');
select throws_ok($$select agent_memory.link_memory('7a000000-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000001')$$,
  'P0001', 'No write access to scope ''s1''', 'read-only cannot link_memory');
select throws_ok($$select agent_memory.unlink_memory('7a000000-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000001')$$,
  'P0001', 'No write access to scope ''s1''', 'read-only cannot unlink_memory');
select lives_ok($$select agent_memory.subscribe('7a000000-0000-0000-0000-000000000000', '52222222-0000-0000-0000-000000000001')$$,
  'read-only can subscribe to a readable thread');

-- w
reset role;
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;

select throws_ok($$select agent_memory.create_thread('a1000000-0000-0000-0000-0000000000a1', '   ', 'b', null, null)$$,
  'P0001', 'Title must be 1-200 characters', 'whitespace title refused');
select throws_ok($$select agent_memory.create_thread('a1000000-0000-0000-0000-0000000000a1', repeat('x', 201), 'b', null, null)$$,
  'P0001', 'Title must be 1-200 characters', 'over-long title refused');
select throws_ok($$select agent_memory.create_thread('a1000000-0000-0000-0000-0000000000a1', 't', 'b', array['aaaaaaaa-0000-0000-0000-000000000003']::uuid[], null)$$,
  'P0001', 'Memory aaaaaaaa-0000-0000-0000-000000000003 not found', 'unreadable memory refused');
select is((select count(*) from agent_memory.threads where title = 't'), 0::bigint, 'failed create_thread leaves no thread');

-- Posts, seq and counters (T2: no body, no session)
create temp table t2 as select agent_memory.create_thread('a1000000-0000-0000-0000-0000000000a1', '  T2  ', '  ', null, null) as id;
grant all on t2 to public;
select is((select title from agent_memory.threads where id = (select id from t2)), 'T2', 'title is trimmed');
select is((select post_count from agent_memory.threads where id = (select id from t2)), 0, 'blank body writes no post');
select throws_ok($$select agent_memory.post_to_thread((select id from t2), ' ', null)$$,
  'P0001', 'Post body is empty', 'whitespace post body refused');
select throws_ok($$select agent_memory.post_to_thread((select id from t2), repeat('x', 20001), null)$$,
  'P0001', 'content too long (max 20000 characters)', 'over-long post refused');
select is(agent_memory.post_to_thread((select id from t2), 'one', null), 1, 'first post is seq 1');
select is(agent_memory.post_to_thread((select id from t2), 'two', null), 2, 'second post is seq 2');
select is(agent_memory.post_to_thread((select id from t2), 'three', null), 3, 'third post is seq 3');
select is((select post_count from agent_memory.threads where id = (select id from t2)), 3, 'post_count is 3');
select is((select last_post_at from agent_memory.threads where id = (select id from t2)),
  (select max(created_at) from agent_memory.thread_posts where thread_id = (select id from t2)), 'last_post_at matches last post');

-- Status
select is(agent_memory.set_thread_status((select id from t2), 'resolved', '  ', null), 4, 'resolve appends seq 4');
select is((select body from agent_memory.thread_posts where thread_id = (select id from t2) and seq = 4), '', 'blank note stored as empty body');
select is((select kind from agent_memory.thread_posts where thread_id = (select id from t2) and seq = 4), 'resolve', 'resolve post kind');
select is((select status from agent_memory.threads where id = (select id from t2)), 'resolved', 'status is resolved');
select throws_ok($$select agent_memory.set_thread_status((select id from t2), 'resolved', null, null)$$,
  'P0001', 'Thread is already resolved', 'resolve twice refused');
select is(agent_memory.set_thread_status((select id from t2), 'open', ' back ', null), 5, 'reopen appends seq 5');
select is((select kind || ':' || body from agent_memory.thread_posts where thread_id = (select id from t2) and seq = 5), 'reopen:back', 'reopen post kind and trimmed note');
select is((select status || coalesce(resolved_by::text, '-') from agent_memory.threads where id = (select id from t2)), 'open-', 'reopen clears resolved_by');
select throws_ok($$select agent_memory.set_thread_status((select id from t2), 'open', null, null)$$,
  'P0001', 'Thread is already open', 'open twice refused');

-- Subscription markers
create temp table t1 as select agent_memory.create_thread('a1000000-0000-0000-0000-0000000000a1', 'T1', 'first',
  array['aaaaaaaa-0000-0000-0000-000000000001']::uuid[], '51111111-0000-0000-0000-00000000000a') as id;
grant all on t1 to public;
select is((select count(*) from agent_memory.thread_links where thread_id = (select id from t1)), 1::bigint, 'create_thread links memories');
select is((select last_seen_seq from agent_memory.thread_subscriptions where thread_id = (select id from t1)
  and session_id = '51111111-0000-0000-0000-00000000000a'), 1, 'creator session marker at post_count');
select is(agent_memory.post_to_thread((select id from t1), 'from B', '51111111-0000-0000-0000-00000000000b'), 2, 'B posts seq 2');
select is((select new_posts from agent_memory.whats_new('51111111-0000-0000-0000-00000000000a')), 1, 'A sees 1 new post');
select is((select count(*) from agent_memory.whats_new('51111111-0000-0000-0000-00000000000b')), 0::bigint, 'B does not see its own post');
select is(agent_memory.post_to_thread((select id from t1), 'from A', '51111111-0000-0000-0000-00000000000a'), 3, 'A posts seq 3');
select is((select new_posts from agent_memory.whats_new('51111111-0000-0000-0000-00000000000a')), 1, 'A own post adds nothing and marker stays');
select is((select last_author from agent_memory.whats_new('51111111-0000-0000-0000-00000000000a')), 'w', 'last_author is a name');
select agent_memory.mark_seen('51111111-0000-0000-0000-00000000000a', (select id from t1), 3);
select is((select count(*) from agent_memory.whats_new('51111111-0000-0000-0000-00000000000a')), 0::bigint, 'mark_seen empties whats_new');
select agent_memory.mark_seen('51111111-0000-0000-0000-00000000000a', (select id from t1), 1);
select is((select last_seen_seq from agent_memory.thread_subscriptions where thread_id = (select id from t1)
  and session_id = '51111111-0000-0000-0000-00000000000a'), 3, 'mark_seen never moves the marker back');
select is(agent_memory.post_to_thread((select id from t1), 'B again', '51111111-0000-0000-0000-00000000000b'), 4, 'B posts seq 4');
select is((select new_posts from agent_memory.whats_new('51111111-0000-0000-0000-00000000000a')), 1, 'A sees B seq 4 only');
select agent_memory.subscribe((select id from t1), '51111111-0000-0000-0000-00000000000c');
select is((select count(*) from agent_memory.whats_new('51111111-0000-0000-0000-00000000000c')), 0::bigint, 'late subscriber C sees nothing');

-- Links follow memory soft-delete
select agent_memory.link_memory((select id from t1), 'aaaaaaaa-0000-0000-0000-000000000001');
select is((select count(*) from agent_memory.thread_links where thread_id = (select id from t1)), 1::bigint, 'linking twice does nothing');
select agent_memory.soft_delete(array['aaaaaaaa-0000-0000-0000-000000000001']::uuid[]);
select is((select count(*) from agent_memory.thread_links where thread_id = (select id from t1)), 0::bigint, 'soft-deleted memory hides its link');
reset role;
select agent_memory.restore('aaaaaaaa-0000-0000-0000-000000000001'); -- restore is postgres-only
set local role agent_memory_member;
select is((select count(*) from agent_memory.thread_links where thread_id = (select id from t1)), 1::bigint, 'restore shows the link again');
select ok(agent_memory.unlink_memory((select id from t1), 'aaaaaaaa-0000-0000-0000-000000000001'), 'unlink returns true');
select ok(not agent_memory.unlink_memory((select id from t1), 'aaaaaaaa-0000-0000-0000-000000000001'), 'unlink again returns false');
select ok(agent_memory.unsubscribe((select id from t1), '51111111-0000-0000-0000-00000000000c'), 'unsubscribe returns true');

-- Sessions
select is((select count(*) from agent_memory.agent_sessions where member_id = '11111111-1111-1111-1111-111111111111'), 3::bigint, 'baseline session count');
select throws_ok($$select * from agent_memory.resolve_session(null, 'typo', false)$$, 'P0001', 'Session not found', 'typo label raises');
select is((select count(*) from agent_memory.agent_sessions where member_id = '11111111-1111-1111-1111-111111111111'), 3::bigint, 'non-creating call creates no session');
select throws_ok($$select agent_memory.post_to_thread((select id from t1), 'x', '52222222-0000-0000-0000-000000000001')$$,
  'P0001', 'Session not found', 'post_to_thread refuses another member''s session');
select throws_ok($$select agent_memory.subscribe((select id from t1), '52222222-0000-0000-0000-000000000001')$$,
  'P0001', 'Session not found', 'subscribe refuses another member''s session');
select throws_ok($$select * from agent_memory.whats_new('52222222-0000-0000-0000-000000000001')$$,
  'P0001', 'Session not found', 'whats_new refuses another member''s session');

-- Revoked grant hides the subscribed thread
reset role;
delete from agent_memory.scope_grants where scope_id = 'a1000000-0000-0000-0000-0000000000a1'
  and member_id = '11111111-1111-1111-1111-111111111111';
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;
select is((select count(*) from agent_memory.whats_new('51111111-0000-0000-0000-00000000000a')), 0::bigint, 'revoked grant: whats_new omits thread');
select throws_ok(format('select agent_memory.post_to_thread(%L, ''x'', null)', (select id from t1)),
  'P0001', format('Thread %s not found', (select id from t1)), 'revoked grant: post_to_thread raises');
select ok(not agent_memory.can_read_thread((select id from t1)), 'revoked grant: can_read_thread is false');
select * from finish();
rollback;
