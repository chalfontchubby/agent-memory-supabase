begin;
create extension if not exists pgtap with schema extensions;
select plan(48);

-- schema
select has_column('agent_memory'::name, 'members'::name, 'is_admin'::name, 'members.is_admin exists');
select has_column('agent_memory'::name, 'members'::name, 'deactivated_at'::name, 'members.deactivated_at exists');
select has_table('agent_memory'::name, 'admin_log'::name, 'admin_log exists');
select throws_ok(
  $$insert into agent_memory.members (display_name, kind, is_admin) values ('robot', 'bot', true)$$,
  '23514', null, 'a bot cannot be flagged admin');

-- fixtures via the core functions
select lives_ok($$select agent_memory.adm_create_member('alice', 'human', 'Alice@Example.com', null, 'test')$$, 'create member');
select is((select count(*) from agent_memory.admin_log where action = 'create_member'), 1::bigint, 'create_member logs one row');
select agent_memory.adm_create_member('bob', 'human', null, null, 'test');
select agent_memory.adm_create_member('botty', 'bot', null, null, 'test');
select agent_memory.adm_create_scope('s1', 'first', null, 'test');
select is((select count(*) from agent_memory.admin_log where action = 'create_scope'), 1::bigint, 'create_scope logs one row');

select agent_memory.adm_grant('alice', 's1', 'write', null, 'test');
select is((select count(*) from agent_memory.admin_log where action = 'grant'), 1::bigint, 'grant logs one row');
select agent_memory.adm_grant('alice', 's1', 'read', null, 'test');
select is((select access from agent_memory.scope_grants g join agent_memory.members m on m.id = g.member_id where m.display_name = 'alice'),
  'read', 'grant upserts');
select throws_ok($$select agent_memory.adm_grant('alice', 's1', 'admin', null, 'test')$$,
  'P0001', 'Access must be read or write', 'bad access refused');

select agent_memory.adm_issue_token('alice', 'laptop', 'hash-alice-1', null, null, 'test');
select is((select count(*) from agent_memory.admin_log where action = 'issue_token'), 1::bigint, 'issue_token logs one row');
select is((select count(*) from agent_memory.admin_log
  where action = 'issue_token' and (details::text like '%token_hash%' or details::text like '%amm_%' or details::text like '%hash-alice-1%')),
  0::bigint, 'issue_token log holds no hash or token');
select is(agent_memory.resolve_token('hash-alice-1'),
  (select id from agent_memory.members where display_name = 'alice'), 'resolve_token finds active member');

-- deactivation
select agent_memory.adm_deactivate_member('alice', null, 'test');
select is(agent_memory.resolve_token('hash-alice-1'), null, 'deactivated tokens stop resolving');
select is((select count(*) from agent_memory.resolve_member('hash-alice-1')), 0::bigint, 'resolve_member returns no rows when deactivated');
select is((select count(*) from agent_memory.scope_grants g join agent_memory.members m on m.id = g.member_id where m.display_name = 'alice'),
  0::bigint, 'deactivation deletes grants');
select is((select count(*) from agent_memory.access_tokens t join agent_memory.members m on m.id = t.member_id
  where m.display_name = 'alice' and t.revoked_at is null), 0::bigint, 'deactivation revokes tokens');
select is((select count(*) from agent_memory.admin_log where action = 'deactivate_member'), 1::bigint, 'deactivate logs one row');
select throws_ok($$select agent_memory.adm_grant('alice', 's1', 'read', null, 'test')$$,
  'P0001', 'Member ''alice'' is deactivated', 'grant to deactivated member refused');
select throws_ok($$select agent_memory.adm_issue_token('alice', 'x', 'h2', null, null, 'test')$$,
  'P0001', 'Member ''alice'' is deactivated', 'token for deactivated member refused');
select agent_memory.adm_reactivate_member('alice', null, 'test');
select is((select deactivated_at from agent_memory.members where display_name = 'alice'), null, 'reactivate clears deactivated_at');
select is((select count(*) from agent_memory.scope_grants g join agent_memory.members m on m.id = g.member_id where m.display_name = 'alice'),
  0::bigint, 'reactivate restores no grants');
select is((select count(*) from agent_memory.admin_log where action = 'reactivate_member'), 1::bigint, 'reactivate logs one row');

-- admin flag
select throws_ok($$select agent_memory.adm_set_admin('botty', true, null, 'test')$$,
  'P0001', 'A bot can''t be an admin', 'bot cannot be admin');
select agent_memory.adm_set_admin('alice', true, null, 'test');
select is((select is_admin from agent_memory.resolve_member('hash-alice-1')), null, 'revoked token still does not resolve');
select agent_memory.adm_issue_token('alice', 'second', 'hash-alice-2', null, null, 'test');
select is((select is_admin from agent_memory.resolve_member('hash-alice-2')), true, 'resolve_member reports is_admin');
select throws_ok($$select agent_memory.adm_set_admin('alice', false, null, 'test')$$,
  'P0001', 'Can''t remove the last active admin', 'last admin cannot be demoted');
select throws_ok($$select agent_memory.adm_deactivate_member('alice', null, 'test')$$,
  'P0001', 'Can''t remove the last active admin', 'last admin cannot be deactivated');
select agent_memory.adm_set_admin('bob', true, null, 'test');
select lives_ok($$select agent_memory.adm_set_admin('alice', false, null, 'test')$$, 'with two admins, demotion works');
select is((select count(*) from agent_memory.admin_log where action = 'set_admin'), 3::bigint, 'set_admin logs one row each');

-- duplicates and names
select throws_ok($$select agent_memory.adm_create_scope('s1', null, null, 'test')$$, 'P0001', 'Scope ''s1'' already exists', 'dup scope');
select throws_ok($$select agent_memory.adm_create_member('bob', 'human', null, null, 'test')$$, 'P0001', 'Member ''bob'' already exists', 'dup member');
select throws_ok($$select agent_memory.adm_create_scope('Bad Name', null, null, 'test')$$, 'P0001',
  'Scope names are lowercase letters, digits and hyphens, starting with a letter or digit (max 63)', 'bad scope name');

-- delete scope counts soft-deleted memories
insert into agent_memory.memories (id, scope_id, content, category, embedding, deleted_at)
select v.id::uuid, (select id from agent_memory.scopes where name = 's1'), 'c', 'other',
  array_fill(0.1::real, array[384])::extensions.vector, v.d
from (values ('eeeeeeee-0000-0000-0000-000000000001', null::timestamptz),
             ('eeeeeeee-0000-0000-0000-000000000002', now())) as v(id, d);
select agent_memory.adm_grant('bob', 's1', 'read', null, 'test');
select throws_ok($$select agent_memory.adm_delete_scope('s1', null, 'test')$$, 'P0001',
  'Scope ''s1'' still holds 2 memories; move, delete or erase them first', 'delete counts live and soft-deleted');
select agent_memory.erase('eeeeeeee-0000-0000-0000-000000000001');
select agent_memory.erase('eeeeeeee-0000-0000-0000-000000000002');
select lives_ok($$select agent_memory.adm_delete_scope('s1', null, 'test')$$, 'delete empty scope');
select is((select count(*) from agent_memory.scope_grants), 0::bigint, 'scope grants gone');

-- revoke, tokens
select agent_memory.adm_create_scope('s2', null, null, 'test');
select agent_memory.adm_grant('bob', 's2', 'read', null, 'test');
select is(agent_memory.adm_revoke('bob', 's2', null, 'test'), true, 'revoke returns true');
select is(agent_memory.adm_revoke('bob', 's2', null, 'test'), false, 'revoke again returns false');
select agent_memory.adm_revoke_token((select id from agent_memory.access_tokens where token_hash = 'hash-alice-2'), null, 'test');
select is(agent_memory.resolve_token('hash-alice-2'), null, 'revoked token stops resolving');
select throws_ok($$select agent_memory.adm_revoke_token('00000000-0000-0000-0000-000000000000', null, 'test')$$,
  'P0001', 'Token 00000000-0000-0000-0000-000000000000 not found', 'unknown token');
select is((select count(*) from agent_memory.admin_log where action = 'revoke'), 1::bigint, 'revoke logs only when a grant existed');
select is((select count(*) from agent_memory.admin_log where action = 'delete_scope'), 1::bigint, 'delete_scope logs one row');
select is((select count(*) from agent_memory.admin_log where action = 'revoke_token'), 1::bigint, 'revoke_token logs one row');

-- member role has no access
set local role agent_memory_member;
select throws_ok($$select * from agent_memory.admin_log$$, '42501', null, 'member cannot read admin_log');
select throws_ok($$select agent_memory.adm_create_scope('zz', null, null, 'x')$$, '42501', null, 'member cannot call adm_*');
reset role;
select is((select count(*) from pg_catalog.pg_proc p, (values ('anon'), ('authenticated'), ('agent_memory_member')) r(rn)
  where p.pronamespace = 'agent_memory'::regnamespace and (p.proname like 'adm\_%' or p.proname = 'resolve_member')
    and has_function_privilege(r.rn, p.oid, 'execute')), 0::bigint, 'no client role can execute adm_* or resolve_member');
select is((select count(*) from agent_memory.admin_log where actor_label is null), 0::bigint, 'actor_label always set');
select is((select count(*) from agent_memory.admin_log), 19::bigint, 'total log rows match successful calls');
select * from finish();
rollback;
