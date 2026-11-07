begin;
create extension if not exists pgtap with schema extensions;
select plan(40);

-- one-hot vector at dim i, optionally with weight w at dim j
create function pg_temp.v(i int, j int default 1, w real default 0) returns extensions.vector
language sql immutable as $$
  select (array_agg(case when d = i then 1::real when d = j and w > 0 then w else 0::real end order by d))::extensions.vector
  from generate_series(1, 384) d
$$;

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

insert into agent_memory.memories (id, scope_id, content, category, tags, created_at, created_by, updated_by, embedding) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a',
   'charge window opens at midnight', 'other', '{battery}', '2026-01-10', '11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', pg_temp.v(1)),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a',
   'charge schedule notes', 'learning', '{grid}', '2026-02-10', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', pg_temp.v(2)),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-00000000000a',
   'window cleaning reminder', 'other', '{}', '2026-03-10', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', pg_temp.v(3)),
  ('cccccccc-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-00000000000c',
   'unrelated gamma note about tariffs', 'other', '{battery}', '2026-04-10', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', pg_temp.v(4)),
  ('bbbbbbbb-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-00000000000b',
   'charge window beta secret', 'other', '{battery}', '2026-01-11', '44444444-4444-4444-4444-444444444444', '44444444-4444-4444-4444-444444444444', pg_temp.v(1));

-- Review Focus 3 volume: 12 more in alpha (15 total), 1000 in beta nearer to the query vector than any alpha row.
insert into agent_memory.memories (scope_id, content, category, created_by, updated_by, embedding)
select 'a0000000-0000-0000-0000-00000000000a', 'alpha filler ' || i, 'other',
       '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', pg_temp.v(10 + i, 1, 0.2)
from generate_series(1, 12) i;
insert into agent_memory.memories (scope_id, content, category, created_by, updated_by, embedding)
select 'b0000000-0000-0000-0000-00000000000b', 'beta filler ' || i, 'other',
       '44444444-4444-4444-4444-444444444444', '44444444-4444-4444-4444-444444444444', pg_temp.v(1, 100 + (i % 200), 0.01)
from generate_series(1, 1000) i;
analyze agent_memory.memories;

-- member_name / view privileges
select ok(not has_function_privilege('anon', 'agent_memory.member_name(uuid)', 'execute'), 'anon cannot execute member_name');
select ok(not has_function_privilege('authenticated', 'agent_memory.member_name(uuid)', 'execute'), 'authenticated cannot execute member_name');
select ok(has_function_privilege('agent_memory_member', 'agent_memory.member_name(uuid)', 'execute'), 'member can execute member_name');
select ok(has_table_privilege('agent_memory_member', 'agent_memory.memory_view', 'select'), 'member can select memory_view');
select ok(not has_table_privilege('anon', 'agent_memory.memory_view', 'select'), 'anon cannot select memory_view');

-- rw
select set_config('agent_memory.member_id', '11111111-1111-1111-1111-111111111111', true);
set local role agent_memory_member;

select is((select created_by || '/' || updated_by || '/' || scope from agent_memory.memory_view where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'rw/bw/alpha', 'view shows names and scope');
select is((select count(*) from agent_memory.memory_view where scope = 'beta'), 0::bigint, 'view hides beta from rw');

select is((select id from agent_memory.search_memories('charge window', null, 'keyword', null, null, null, null, null, 10) limit 1),
  'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'keyword: memory with both words ranks first');
select is((select id from agent_memory.search_memories('x', pg_temp.v(1), 'semantic', null, null, null, null, null, 10) limit 1),
  'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'semantic: nearest vector first (dim 1)');
select is((select id from agent_memory.search_memories('x', pg_temp.v(2), 'semantic', null, null, null, null, null, 10) limit 1),
  'aaaaaaaa-0000-0000-0000-000000000002'::uuid, 'semantic: nearest vector first (dim 2)');
select ok((select raw_score from agent_memory.search_memories('x', pg_temp.v(1), 'semantic', null, null, null, null, null, 10) limit 1) > 0.49,
  'semantic score is 1/(1+distance)');

-- hybrid: gamma note matches only the vector arm, midnight memory only the keyword arm (limit 3)
select ok(exists (select 1 from agent_memory.search_memories('charge window', pg_temp.v(4), 'hybrid', null, null, null, null, null, 3)
                  where id = 'cccccccc-0000-0000-0000-000000000004'), 'hybrid includes row found only by semantic arm');
select ok(exists (select 1 from agent_memory.search_memories('charge window', pg_temp.v(4), 'hybrid', null, null, null, null, null, 3)
                  where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'hybrid includes row found only by keyword arm');
select is((select count(*) from agent_memory.search_memories('charge window', pg_temp.v(1), 'hybrid', null, null, null, null, null, 2)), 2::bigint,
  'hybrid with p_limit 2 returns exactly 2 although more rows match');

-- filters
select ok(not exists (select 1 from agent_memory.search_memories('x', pg_temp.v(1), 'semantic', null, 'learning', null, null, null, 20)
                      where category <> 'learning') and exists (select 1 from agent_memory.search_memories('x', pg_temp.v(1), 'semantic', null, 'learning', null, null, null, 20)),
  'category filter excludes other categories');
select ok(not exists (select 1 from agent_memory.search_memories('charge', null, 'keyword', null, 'other', null, null, null, 20) where id = 'aaaaaaaa-0000-0000-0000-000000000002'),
  'keyword category filter excludes matching learning row');
select is((select array_agg(id order by id) from agent_memory.search_memories('x', pg_temp.v(1), 'semantic', null, null, array['battery'], null, null, 20)),
  array['aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000004']::uuid[], 'tags overlap filter');
select ok(not exists (select 1 from agent_memory.search_memories('x', pg_temp.v(1), 'semantic', null, null, null, '2026-02-01', null, 20) where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'after filter excludes older row');
select ok(not exists (select 1 from agent_memory.search_memories('x', pg_temp.v(1), 'semantic', null, null, null, null, '2026-02-01', 20) where id = 'aaaaaaaa-0000-0000-0000-000000000002'),
  'before filter excludes newer row');
select is((select array_agg(id) from agent_memory.search_memories('x', pg_temp.v(1), 'semantic', array['c0000000-0000-0000-0000-00000000000c']::uuid[], null, null, null, null, 20)),
  array['cccccccc-0000-0000-0000-000000000004']::uuid[], 'p_scope_ids restricts to gamma');
select is((select count(*) from agent_memory.search_memories('charge', null, 'keyword', array['c0000000-0000-0000-0000-00000000000c']::uuid[], null, null, null, null, 20)),
  0::bigint, 'keyword p_scope_ids excludes alpha match');

-- Review Focus 2: stop words and punctuation
select ok((select count(*) from agent_memory.search_memories('the', pg_temp.v(1), 'hybrid', null, null, null, null, null, 5)) > 0,
  'hybrid with stop-word-only query still returns semantic hits');
select lives_ok($$select * from agent_memory.search_memories('???', null, 'keyword', null, null, null, null, null, 5)$$, 'keyword with ??? does not error');
select is((select count(*) from agent_memory.search_memories('???', null, 'keyword', null, null, null, null, null, 5)), 0::bigint, 'keyword with ??? returns 0 rows');
select is((select count(*) from agent_memory.search_memories('the', null, 'keyword', null, null, null, null, null, 5)), 0::bigint, 'keyword with stop word returns 0 rows');

-- Filters must apply inside each arm, before its LIMIT: p_limit is smaller than the matching readable count and the
-- nearest unfiltered row is excluded by the filter.
select is((select array_agg(id) from agent_memory.search_memories('zzzz', pg_temp.v(1), 'hybrid', null, 'learning', null, null, null, 1)),
  array['aaaaaaaa-0000-0000-0000-000000000002']::uuid[], 'hybrid category filter applies before limit');
select is((select array_agg(id) from agent_memory.search_memories('zzzz', pg_temp.v(1), 'hybrid', null, null, array['grid'], null, null, 1)),
  array['aaaaaaaa-0000-0000-0000-000000000002']::uuid[], 'hybrid tags filter applies before limit');
select is((select array_agg(id) from agent_memory.search_memories('zzzz', pg_temp.v(1), 'hybrid', null, null, null, '2026-02-01', '2026-02-28', 1)),
  array['aaaaaaaa-0000-0000-0000-000000000002']::uuid[], 'hybrid after/before filters apply before limit');
select is((select array_agg(id) from agent_memory.search_memories('charge', null, 'keyword', null, 'learning', null, null, null, 1)),
  array['aaaaaaaa-0000-0000-0000-000000000002']::uuid[], 'keyword category filter applies before limit');
select is((select array_agg(id) from agent_memory.search_memories('x', pg_temp.v(1), 'semantic', array['c0000000-0000-0000-0000-00000000000c']::uuid[], null, null, null, null, 1)),
  array['cccccccc-0000-0000-0000-000000000004']::uuid[], 'semantic scope filter applies before limit');

select throws_ok($$select * from agent_memory.search_memories('x', null, null, null, null, null, null, null, 5)$$, '22023', null, 'null mode raises 22023');
select throws_ok($$select * from agent_memory.search_memories('x', null, 'keyword', null, null, null, null, null, 0)$$, '22023', null, 'p_limit 0 raises 22023');
select throws_ok($$select * from agent_memory.search_memories('x', null, 'keyword', null, null, null, null, null, null)$$, '22023', null, 'null p_limit raises 22023');

reset role;

-- ro: alpha-only member
select set_config('agent_memory.member_id', '22222222-2222-2222-2222-222222222222', true);
set local role agent_memory_member;
discard plans;

select is((select count(*) from agent_memory.search_memories('x', pg_temp.v(1), 'semantic', null, null, null, null, null, 10)), 10::bigint,
  'small scope gets a full page from the vector arm');
select is((select array_agg(id order by raw_score desc, id) from agent_memory.search_memories('x', pg_temp.v(1), 'semantic', null, null, null, null, null, 10)),
  (select array_agg(id order by dist, id) from (select m.id, m.embedding operator(extensions.<=>) pg_temp.v(1) as dist
     from agent_memory.memories m where m.scope_id = 'a0000000-0000-0000-0000-00000000000a' order by 2, 1 limit 10) n),
  'the 10 rows are the alpha rows nearest the query');

select is((select count(*) from agent_memory.search_memories('charge window', pg_temp.v(1), 'keyword', array['b0000000-0000-0000-0000-00000000000b']::uuid[], null, null, null, null, 10)),
  0::bigint, 'beta rows hidden in keyword mode even when named');
select is((select count(*) from agent_memory.search_memories('charge window', pg_temp.v(1), 'semantic', array['b0000000-0000-0000-0000-00000000000b']::uuid[], null, null, null, null, 10)),
  0::bigint, 'beta rows hidden in semantic mode even when named');
select is((select count(*) from agent_memory.search_memories('charge window', pg_temp.v(1), 'hybrid', array['b0000000-0000-0000-0000-00000000000b']::uuid[], null, null, null, null, 10)),
  0::bigint, 'beta rows hidden in hybrid mode even when named');

select is((select count(*) from agent_memory.related_memories('bbbbbbbb-0000-0000-0000-000000000005', null, 10)), 0::bigint,
  'related_memories on an unreadable id returns nothing');
select ok((select count(*) from agent_memory.related_memories('aaaaaaaa-0000-0000-0000-000000000001', null, 5)) = 5
  and not exists (select 1 from agent_memory.related_memories('aaaaaaaa-0000-0000-0000-000000000001', null, 5) where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'related_memories returns neighbours excluding the memory itself');

reset role;
select * from finish();
rollback;
