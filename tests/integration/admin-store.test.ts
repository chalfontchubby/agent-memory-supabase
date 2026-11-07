import { assert, assertEquals } from '@std/assert';
import { connect, resolveMember } from '../../supabase/functions/_shared/db.ts';
import { PgAdminStore } from '../../supabase/functions/_shared/admin-store.ts';
import { StoreError } from '../../supabase/functions/_shared/limits.ts';
import { setAdmin } from '../../scripts/lib/admin-db.ts';
import { adminSql, LOCAL_DB_URL } from '../helpers/fixtures.ts';

const sfx = () => crypto.randomUUID().slice(0, 8);

interface Env {
  s: string;
  pg: ReturnType<typeof adminSql>;
  admin: PgAdminStore;
  plain: PgAdminStore;
  adminId: string;
  plainId: string;
  other: string; // a second admin's name
  /** Names created during the test, for log cleanup. */
  names: string[];
}

async function withEnv(fn: (e: Env) => Promise<void>) {
  const pg = adminSql();
  const app = connect(LOCAL_DB_URL);
  const s = sfx();
  const mk = async (name: string) =>
    (await pg`insert into agent_memory.members (display_name, kind) values (${name}, 'human') returning id`)[0]
      .id as string;
  const adminName = `adm-${s}`, plainName = `plain-${s}`, other = `adm2-${s}`;
  const names: string[] = [];
  try {
    const adminId = await mk(adminName);
    const plainId = await mk(plainName);
    await mk(other);
    await setAdmin(pg, adminName, true);
    await setAdmin(pg, other, true);
    await fn({
      s,
      pg,
      admin: new PgAdminStore(app, adminId),
      plain: new PgAdminStore(app, plainId),
      adminId,
      plainId,
      other,
      names,
    });
  } finally {
    // members cascade to grants and tokens; the log is keyed by fixed names carrying the suffix.
    await pg`delete from agent_memory.members where display_name like ${'%' + s}`;
    await pg`delete from agent_memory.scopes where name like ${'%' + s}`;
    await pg`delete from agent_memory.admin_log where target like ${'%' + s + '%'} or actor_label like ${'%' + s}`;
    await pg`delete from agent_memory.admin_log where actor_member_id is not null and not exists
      (select 1 from agent_memory.members m where m.id = actor_member_id) and target like ${'%' + s + '%'}`;
    await app.end();
    await pg.end();
  }
}

const msg = (p: Promise<unknown>) =>
  p.then(() => {
    throw new Error('expected rejection');
  }, (e) => {
    assert(e instanceof StoreError, `expected StoreError, got ${e}`);
    return e.message;
  });

Deno.test('an admin onboards a member end to end; the issued token resolves', async () => {
  await withEnv(async ({ admin, s, pg }) => {
    const scope = `team-${s}`, member = `newbie-${s}`;
    await admin.createScope(scope, 'a scope');
    await admin.createMember(member, 'human', `${member}@example.com`);
    await admin.grant(member, scope, 'write');
    const { id, token } = await admin.issueToken(member, 'laptop');
    assert(token.startsWith('amm_'));
    const memberId = await resolveMember(pg, token);
    assert(memberId);
    assertEquals(
      (await pg`select display_name from agent_memory.members where id = ${memberId}`)[0].display_name,
      member,
    );

    const scopes = await admin.listScopes();
    assertEquals(scopes.find((x) => x.name === scope), {
      name: scope,
      description: 'a scope',
      memories: 0,
      deleted: 0,
      readers: 0,
      writers: 1,
    });
    const m = (await admin.listMembers()).find((x) => x.name === member);
    assertEquals(m, {
      name: member,
      kind: 'human',
      email: `${member}@example.com`,
      isAdmin: false,
      deactivated: false,
      liveTokens: 1,
    });
    const grants = await admin.listGrants({ scope });
    assertEquals(grants.length, 1);
    assertEquals(grants[0].member, member);
    assertEquals(grants[0].access, 'write');
    assert(typeof grants[0].grantedAt === 'string');
    assertEquals((await admin.listGrants({ member })).length, 1);
    assertEquals((await admin.listGrants({ scope, member: `nobody-${s}` })).length, 0);

    const toks = await admin.listTokens(member);
    assertEquals(toks.length, 1);
    assertEquals(toks[0].id, id);
    assertEquals(toks[0].name, 'laptop');
    assertEquals(toks[0].revokedAt, null);
    assert(!JSON.stringify(toks).includes(token));

    await admin.revokeToken(id);
    assertEquals(await resolveMember(pg, token), null);
    assert((await admin.listTokens(member))[0].revokedAt);

    assertEquals(await admin.revoke(member, scope), true);
    assertEquals(await admin.revoke(member, scope), false);
    await admin.deactivateMember(member);
    assertEquals((await admin.listMembers()).find((x) => x.name === member)?.deactivated, true);
    await admin.deleteScope(scope);
    assertEquals((await admin.listScopes()).find((x) => x.name === scope), undefined);
  });
});

Deno.test('the log never holds the token or its hash', async () => {
  await withEnv(async ({ admin, s, pg }) => {
    const member = `lg-${s}`;
    await admin.createMember(member, 'bot');
    const { token } = await admin.issueToken(member, 'k');
    const { hashToken } = await import('../../supabase/functions/_shared/tokens.ts');
    const hash = await hashToken(token);
    const rows = await pg`select details::text as d, target from agent_memory.admin_log where target like ${
      '%' + s + '%'
    }`;
    assert(rows.length >= 2);
    for (const r of rows) assert(!r.d?.includes(token) && !r.d?.includes(hash));
  });
});

Deno.test('rule errors surface verbatim as StoreError', async () => {
  await withEnv(async ({ admin, other, s }) => {
    const sc = `dup-${s}`;
    await admin.createScope(sc);
    assertEquals(await msg(admin.createScope(sc)), `Scope '${sc}' already exists`);
    assertEquals(
      await msg(admin.createScope(`Bad Name ${s}`)),
      'Scope names are lowercase letters, digits and hyphens, starting with a letter or digit (max 63)',
    );
    assertEquals(await msg(admin.deleteScope(`nope-${s}`)), `Scope 'nope-${s}' not found`);
    assertEquals(await msg(admin.createMember(`adm-${s}`, 'human')), `Member 'adm-${s}' already exists`);
    assertEquals(await msg(admin.grant(`ghost-${s}`, sc, 'read')), `Member 'ghost-${s}' not found`);
    assertEquals(await msg(admin.listTokens(`ghost-${s}`)), `Member 'ghost-${s}' not found`);
    const adminMsg = `Member '${other}' is an admin; manage admins from the shell`;
    assertEquals(await msg(admin.deactivateMember(other)), adminMsg);
    assertEquals(await msg(admin.grant(other, sc, 'read')), adminMsg);
    assertEquals(await msg(admin.revoke(other, sc)), adminMsg);
    assertEquals(await msg(admin.issueToken(other, 't')), adminMsg);
    assertEquals(await msg(admin.listTokens(other)), adminMsg);
    assertEquals(await msg(admin.deactivateMember(`adm-${s}`)), "You can't deactivate yourself");
    assertEquals(
      await msg(admin.revokeToken('00000000-0000-0000-0000-000000000000')),
      'Token 00000000-0000-0000-0000-000000000000 not found',
    );
    assertEquals(await msg(admin.revokeToken('not-a-uuid')), 'Token not-a-uuid not found');
  });
});

Deno.test('a deactivated member cannot be granted or issued a token', async () => {
  await withEnv(async ({ admin, s }) => {
    const sc = `d-${s}`, m = `gone-${s}`;
    await admin.createScope(sc);
    await admin.createMember(m, 'human');
    await admin.deactivateMember(m);
    assertEquals(await msg(admin.grant(m, sc, 'read')), `Member '${m}' is deactivated`);
    assertEquals(await msg(admin.issueToken(m, 't')), `Member '${m}' is deactivated`);
  });
});

Deno.test('a non-admin gets Admin only from every method', async () => {
  await withEnv(async ({ plain, s }) => {
    const calls: [string, () => Promise<unknown>][] = [
      ['listScopes', () => plain.listScopes()],
      ['createScope', () => plain.createScope(`x-${s}`)],
      ['deleteScope', () => plain.deleteScope(`x-${s}`)],
      ['listMembers', () => plain.listMembers()],
      ['createMember', () => plain.createMember(`x-${s}`, 'human')],
      ['deactivateMember', () => plain.deactivateMember(`x-${s}`)],
      ['listGrants', () => plain.listGrants()],
      ['grant', () => plain.grant(`x-${s}`, `x-${s}`, 'read')],
      ['revoke', () => plain.revoke(`x-${s}`, `x-${s}`)],
      ['issueToken', () => plain.issueToken(`x-${s}`, 't')],
      ['listTokens', () => plain.listTokens(`x-${s}`)],
      ['revokeToken', () => plain.revokeToken('00000000-0000-0000-0000-000000000000')],
    ];
    for (const [n, f] of calls) assertEquals(await msg(f()), 'Admin only', n);
  });
});

Deno.test('an unmapped database error is logged and becomes a generic StoreError', async () => {
  const app = connect(LOCAL_DB_URL);
  const orig = console.error;
  const seen: unknown[][] = [];
  console.error = (...a: unknown[]) => void seen.push(a);
  try {
    // A member id that is not a uuid makes the database raise 22P02, which no method maps except revokeToken.
    assertEquals(await msg(new PgAdminStore(app, 'not-a-uuid').listScopes()), 'Database error');
  } finally {
    console.error = orig;
    await app.end();
  }
  assertEquals(seen.length, 1);
  assertEquals(seen[0][0], 'database error');
  assertEquals(seen[0][1], '22P02');
});
