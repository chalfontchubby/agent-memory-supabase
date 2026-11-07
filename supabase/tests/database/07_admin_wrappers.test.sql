begin;
create extension if not exists pgtap with schema extensions;
select plan(68);

-- Fixtures (as postgres): admins a1, a2; human h; bot b; deactivated admin ax; deactivated plain human x
insert into agent_memory.members (id, display_name, kind, is_admin, deactivated_at) values
  ('a1000000-0000-0000-0000-000000000001', 'a1', 'human', true, null),
  ('a2000000-0000-0000-0000-000000000002', 'a2', 'human', true, null),
  ('c0000000-0000-0000-0000-00000000000c', 'h', 'human', false, null),
  ('b0000000-0000-0000-0000-00000000000b', 'b', 'bot', false, null),
  ('ae000000-0000-0000-0000-0000000000ae', 'ax', 'human', true, now()),
  ('d0000000-0000-0000-0000-0000000000d0', 'x', 'human', false, now());
insert into agent_memory.scopes (name) values ('s1');
insert into agent_memory.access_tokens (id, member_id, name, token_hash) values
  ('11111111-0000-0000-0000-0000000000a2', 'a2000000-0000-0000-0000-000000000002', 'a2 laptop', 'hash-a2'),
  ('11111111-0000-0000-0000-0000000000a1', 'a1000000-0000-0000-0000-000000000001', 'a1 only', 'hash-a1');

-- privileges
select ok(not has_function_privilege('agent_memory_member', 'agent_memory.adm_set_admin(text,boolean,uuid,text)', 'execute'), 'member cannot execute adm_set_admin');
select ok(not has_function_privilege('agent_memory_member', 'agent_memory.adm_reactivate_member(text,uuid,text)', 'execute'), 'member cannot execute adm_reactivate_member');
select ok(not has_function_privilege('agent_memory_member', 'agent_memory.adm_grant(text,text,text,uuid,text)', 'execute'), 'member cannot execute adm_grant');
select ok(not has_function_privilege('agent_memory_member', 'agent_memory.require_admin()', 'execute'), 'member cannot execute require_admin');
select ok(has_function_privilege('agent_memory_member', 'agent_memory.admin_grant(text,text,text)', 'execute'), 'member can execute admin_grant');
select ok(not has_function_privilege('anon', 'agent_memory.admin_grant(text,text,text)', 'execute'), 'anon cannot execute admin_grant');
select ok(not has_function_privilege('authenticated', 'agent_memory.admin_list_members()', 'execute'), 'authenticated cannot execute admin_list_members');

-- non-admins and the deactivated admin: all 12 wrappers refuse
create temp table callers (who text, id uuid);
insert into callers values
  ('h', 'c0000000-0000-0000-0000-00000000000c'),
  ('b', 'b0000000-0000-0000-0000-00000000000b'),
  ('ax', 'ae000000-0000-0000-0000-0000000000ae');
grant all on callers to agent_memory_member;

do $$
declare
  c record;
  r text;
begin
  for c in select * from callers order by who loop
    perform set_config('agent_memory.member_id', c.id::text, true);
    set local role agent_memory_member;
    for r in select unnest(array[
      $q$select agent_memory.admin_create_scope('zz', null)$q$,
      $q$select agent_memory.admin_delete_scope('s1')$q$,
      $q$select agent_memory.admin_create_member('zz', 'human', null)$q$,
      $q$select agent_memory.admin_deactivate_member('h')$q$,
      $q$select agent_memory.admin_grant('h', 's1', 'read')$q$,
      $q$select agent_memory.admin_revoke('h', 's1')$q$,
      $q$select agent_memory.admin_issue_token('h', 'n', 'hz')$q$,
      $q$select agent_memory.admin_revoke_token('11111111-0000-0000-0000-0000000000a2')$q$,
      $q$select * from agent_memory.admin_list_scopes()$q$,
      $q$select * from agent_memory.admin_list_members()$q$,
      $q$select * from agent_memory.admin_list_grants(null, null)$q$,
      $q$select * from agent_memory.admin_list_tokens('h')$q$
    ]) loop
      begin
        execute r;
        raise exception 'NOT REFUSED: % as %', r, c.who;
      exception when insufficient_privilege then
        null;
      end;
    end loop;
    reset role;
  end loop;
end $$;
select pass('all 12 wrappers refuse h, b and ax with 42501');

-- explicit throws_ok per caller, per wrapper
select set_config('agent_memory.member_id', 'c0000000-0000-0000-0000-00000000000c', true);
set local role agent_memory_member;
select throws_ok($$select agent_memory.admin_create_scope('zz', null)$$, '42501', 'Admin only', 'h: create_scope');
select throws_ok($$select agent_memory.admin_delete_scope('s1')$$, '42501', 'Admin only', 'h: delete_scope');
select throws_ok($$select agent_memory.admin_create_member('zz', 'human', null)$$, '42501', 'Admin only', 'h: create_member');
select throws_ok($$select agent_memory.admin_deactivate_member('b')$$, '42501', 'Admin only', 'h: deactivate_member');
select throws_ok($$select agent_memory.admin_grant('h', 's1', 'read')$$, '42501', 'Admin only', 'h: grant (even to self)');
select throws_ok($$select agent_memory.admin_revoke('h', 's1')$$, '42501', 'Admin only', 'h: revoke');
select throws_ok($$select agent_memory.admin_issue_token('h', 'n', 'hz')$$, '42501', 'Admin only', 'h: issue_token');
select throws_ok($$select agent_memory.admin_revoke_token('11111111-0000-0000-0000-0000000000a2')$$, '42501', 'Admin only', 'h: revoke_token');
select throws_ok($$select * from agent_memory.admin_list_scopes()$$, '42501', 'Admin only', 'h: list_scopes');
select throws_ok($$select * from agent_memory.admin_list_members()$$, '42501', 'Admin only', 'h: list_members');
select throws_ok($$select * from agent_memory.admin_list_grants(null, null)$$, '42501', 'Admin only', 'h: list_grants');
select throws_ok($$select * from agent_memory.admin_list_tokens('h')$$, '42501', 'Admin only', 'h: list_tokens');
reset role;

select set_config('agent_memory.member_id', 'b0000000-0000-0000-0000-00000000000b', true);
set local role agent_memory_member;
select throws_ok($$select agent_memory.admin_grant('b', 's1', 'write')$$, '42501', 'Admin only', 'bot: grant');
select throws_ok($$select * from agent_memory.admin_list_members()$$, '42501', 'Admin only', 'bot: list_members');
reset role;

select set_config('agent_memory.member_id', 'ae000000-0000-0000-0000-0000000000ae', true);
set local role agent_memory_member;
select throws_ok($$select agent_memory.admin_create_scope('zz', null)$$, '42501', 'Admin only', 'deactivated admin: create_scope');
select throws_ok($$select * from agent_memory.admin_list_members()$$, '42501', 'Admin only', 'deactivated admin: list_members');
reset role;

-- no caller identity at all
select set_config('agent_memory.member_id', '', true);
set local role agent_memory_member;
select throws_ok($$select * from agent_memory.admin_list_scopes()$$, '42501', 'Admin only', 'no member id: refused');
reset role;

-- as a1
select set_config('agent_memory.member_id', 'a1000000-0000-0000-0000-000000000001', true);
set local role agent_memory_member;
select lives_ok($$select agent_memory.admin_create_scope('s2', 'second')$$, 'a1 creates scope');
select lives_ok($$select agent_memory.admin_create_member('newbie', 'human', null)$$, 'a1 creates member');
select lives_ok($$select agent_memory.admin_grant('h', 's1', 'write')$$, 'a1 grants h');
select lives_ok($$select agent_memory.admin_grant('a1', 's1', 'read')$$, 'a1 may grant self');
select is(agent_memory.admin_revoke('h', 's2'), false, 'revoke of absent grant returns false');
select is(agent_memory.admin_revoke('h', 's1'), true, 'revoke of present grant returns true');
select lives_ok($$select agent_memory.admin_issue_token('h', 'h laptop', 'hash-h-1')$$, 'a1 issues token for h');
reset role;

select is((select count(*) from agent_memory.admin_log
  where actor_member_id = 'a1000000-0000-0000-0000-000000000001' and actor_label = 'a1'
    and action in ('create_scope', 'create_member', 'grant', 'revoke', 'issue_token')), 6::bigint,
  'log rows carry a1 as actor with label a1');
select is((select count(*) from agent_memory.admin_log where details::text like '%hash-h-1%'), 0::bigint, 'log holds no hash');
select is((select expires_at from agent_memory.access_tokens where token_hash = 'hash-h-1'), null, 'issued token has no expiry');

-- other-admin guard
select set_config('agent_memory.member_id', 'a1000000-0000-0000-0000-000000000001', true);
set local role agent_memory_member;
select throws_ok($$select agent_memory.admin_deactivate_member('a2')$$, 'P0001', 'Member ''a2'' is an admin; manage admins from the shell', 'deactivate refuses another admin');
select throws_ok($$select agent_memory.admin_grant('a2', 's1', 'read')$$, 'P0001', 'Member ''a2'' is an admin; manage admins from the shell', 'grant refuses another admin');
select throws_ok($$select agent_memory.admin_revoke('a2', 's1')$$, 'P0001', 'Member ''a2'' is an admin; manage admins from the shell', 'revoke refuses another admin');
select throws_ok($$select agent_memory.admin_issue_token('a2', 'n', 'hash-evil')$$, 'P0001', 'Member ''a2'' is an admin; manage admins from the shell', 'issue_token refuses another admin');
select throws_ok($$select * from agent_memory.admin_list_tokens('a2')$$, 'P0001', 'Member ''a2'' is an admin; manage admins from the shell', 'list_tokens refuses another admin');
select throws_ok($$select agent_memory.admin_revoke_token('11111111-0000-0000-0000-0000000000a2')$$, 'P0001', 'Member ''a2'' is an admin; manage admins from the shell', 'revoke_token refuses another admin''s token');
select throws_ok($$select agent_memory.admin_deactivate_member('a1')$$, 'P0001', 'You can''t deactivate yourself', 'cannot deactivate self');
-- deactivated admin (is_admin still set in this fixture) is also protected
select throws_ok($$select agent_memory.admin_grant('ax', 's1', 'read')$$, 'P0001', 'Member ''ax'' is an admin; manage admins from the shell', 'flagged-admin ax also protected');
reset role;

select is((select revoked_at from agent_memory.access_tokens where id = '11111111-0000-0000-0000-0000000000a2'), null, 'a2 token untouched');
select is((select count(*) from agent_memory.access_tokens where token_hash = 'hash-evil'), 0::bigint, 'no token issued for a2');
select is((select deactivated_at from agent_memory.members where display_name = 'a2'), null, 'a2 not deactivated');
select is((select count(*) from agent_memory.admin_log where target in ('a2', 'ax')), 0::bigint, 'refusals wrote no log rows');

-- revoke_token and the last-live-token rule
select set_config('agent_memory.member_id', 'a1000000-0000-0000-0000-000000000001', true);
set local role agent_memory_member;
select throws_ok($$select agent_memory.admin_revoke_token('11111111-0000-0000-0000-0000000000a1')$$, 'P0001', 'You can''t revoke your last live token', 'refuses own last live token');
select lives_ok($$select agent_memory.admin_issue_token('a1', 'a1 laptop', 'hash-a1-2')$$, 'a1 issues own token');
select lives_ok($$select agent_memory.admin_revoke_token('11111111-0000-0000-0000-0000000000a1')$$, 'with two live tokens, revoke one');
select throws_ok($$select agent_memory.admin_revoke_token((select id from agent_memory.admin_list_tokens('a1') where revoked_at is null))$$,
  'P0001', 'You can''t revoke your last live token', 'now the remaining one is last');
select throws_ok($$select agent_memory.admin_revoke_token('99999999-9999-9999-9999-999999999999')$$, 'P0001',
  'Token 99999999-9999-9999-9999-999999999999 not found', 'unknown token id');
select lives_ok($$select agent_memory.admin_revoke_token((select id from agent_memory.admin_list_tokens('h') limit 1))$$, 'revoke h token');
reset role;

-- token for deactivated / unknown members
select set_config('agent_memory.member_id', 'a1000000-0000-0000-0000-000000000001', true);
create temp table tcount as select count(*) n from agent_memory.access_tokens;
set local role agent_memory_member;
select throws_ok($$select agent_memory.admin_issue_token('ghost', 'n', 'hg')$$, 'P0001', 'Member ''ghost'' not found', 'issue_token unknown member');
select throws_ok($$select agent_memory.admin_issue_token('x', 'n', 'hx')$$, 'P0001', 'Member ''x'' is deactivated', 'issue_token deactivated member');
reset role;
select is((select count(*) from agent_memory.access_tokens), (select n from tcount), 'token count unchanged by refusals');

-- exact name matching
set local role agent_memory_member;
select throws_ok($$select agent_memory.admin_grant('H', 's1', 'read')$$, 'P0001', 'Member ''H'' not found', 'name match is case sensitive');
select throws_ok($$select agent_memory.admin_grant('h ', 's1', 'read')$$, 'P0001', 'Member ''h '' not found', 'name match is exact (trailing space)');
reset role;

-- listings
set local role agent_memory_member;
select is((select is_admin from agent_memory.admin_list_members() where name = 'a2'), true, 'list_members shows a2 as admin');
select is((select deactivated from agent_memory.admin_list_members() where name = 'x'), true, 'list_members shows x deactivated');
select is((select live_tokens from agent_memory.admin_list_members() where name = 'a1'), 1, 'list_members counts a1 live tokens');
select is((select writers from agent_memory.admin_list_scopes() where name = 's1'), 0, 'list_scopes writers');
select is((select readers from agent_memory.admin_list_scopes() where name = 's1'), 1, 'list_scopes readers');
select is((select count(*) from agent_memory.admin_list_grants('s1', null)), 1::bigint, 'list_grants filtered by scope');
select is((select count(*) from agent_memory.admin_list_grants(null, 'h')), 0::bigint, 'list_grants filtered by member');
select is((select count(*) from agent_memory.admin_list_grants(null, null)), 1::bigint, 'list_grants unfiltered');
select is((select count(*) from agent_memory.admin_list_tokens('h')), 1::bigint, 'list_tokens returns h token');
reset role;
select is((select array_agg(nm order by ord) from pg_proc p, lateral unnest(p.proargnames) with ordinality as u(nm, ord)
  where p.pronamespace = 'agent_memory'::regnamespace and p.proname = 'admin_list_tokens' and ord > 1),
  array['id', 'name', 'created_at', 'last_used_at', 'revoked_at'], 'list_tokens columns carry no hash');

select * from finish();
rollback;
