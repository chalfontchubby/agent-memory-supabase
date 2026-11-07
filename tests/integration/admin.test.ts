import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { hashToken } from '../../supabase/functions/_shared/tokens.ts';
import {
  createMember,
  createScope,
  eraseMemory,
  firstLine,
  grant,
  issueToken,
  listDeleted,
  listGrants,
  listScopes,
  listTokens,
  parseExpires,
  restoreMemories,
  restoreMemory,
  revoke,
  revokeToken,
} from '../../scripts/lib/admin-db.ts';
import { adminSql, LOCAL_DB_URL } from '../helpers/fixtures.ts';

const sfx = () => crypto.randomUUID().slice(0, 8);
const resolve = async (sql: ReturnType<typeof adminSql>, token: string) =>
  (await sql`select agent_memory.resolve_token(${await hashToken(token)}) as id`)[0].id as string | null;

async function withAdmin(fn: (sql: ReturnType<typeof adminSql>, s: string) => Promise<void>) {
  const sql = adminSql();
  const s = sfx();
  try {
    await fn(sql, s);
  } finally {
    // members cascade to grants and tokens
    await sql`delete from agent_memory.members where display_name like ${'%' + s}`;
    const gone = await sql`
      delete from agent_memory.memories where scope_id in
        (select id from agent_memory.scopes where name like ${'%' + s}) returning id`;
    await sql`delete from agent_memory.memory_history where memory_id = any(${gone.map((r) => r.id)}::uuid[])`;
    await sql`delete from agent_memory.scopes where name like ${'%' + s}`;
    await sql.end();
  }
}

Deno.test('scope, member, grant, token lifecycle', () =>
  withAdmin(async (sql, s) => {
    const scope = `team-${s}`;
    await createScope(sql, scope, 'desc');
    assert((await listScopes(sql)).some((r) => r.name === scope && r.description === 'desc'));
    await createMember(sql, `bot-${s}`, { kind: 'bot' });

    await grant(sql, `bot-${s}`, scope, 'read');
    await grant(sql, `bot-${s}`, scope, 'write');
    const mine = (await listGrants(sql)).filter((g) => g.scope === scope);
    assertEquals(mine.length, 1);
    assertEquals(mine[0].access, 'write');
    assertEquals(mine[0].member, `bot-${s}`);

    const token = await issueToken(sql, `bot-${s}`, 'laptop');
    assert(token.startsWith('amm_'));
    const memberId = (await sql`select id from agent_memory.members where display_name = ${'bot-' + s}`)[0].id;
    assertEquals(await resolve(sql, token), memberId);

    const listed = await listTokens(sql, `bot-${s}`);
    assertEquals(listed.length, 1);
    assertEquals(listed[0].name, 'laptop');
    const dump = JSON.stringify(listed);
    assert(!dump.includes('amm_'));
    assert(!dump.includes(await hashToken(token)));

    await revokeToken(sql, listed[0].id);
    assertEquals(await resolve(sql, token), null);

    await revoke(sql, `bot-${s}`, scope);
    assertEquals((await listGrants(sql)).filter((g) => g.scope === scope).length, 0);
  }));

Deno.test('expired token does not resolve', () =>
  withAdmin(async (sql, s) => {
    await createMember(sql, `bot-${s}`, { kind: 'bot' });
    const token = await issueToken(sql, `bot-${s}`, 'short', new Date(Date.now() - 1000));
    assertEquals(await resolve(sql, token), null);
  }));

Deno.test('unknown names and bad scope names give friendly errors', () =>
  withAdmin(async (sql, s) => {
    await createMember(sql, `bot-${s}`, { kind: 'bot' });
    await assertRejects(() => grant(sql, `ghost-${s}`, 'x', 'read'), Error, `Member 'ghost-${s}' not found`);
    await assertRejects(() => grant(sql, `bot-${s}`, `nope-${s}`, 'read'), Error, `Scope 'nope-${s}' not found`);
    await assertRejects(() => revoke(sql, `bot-${s}`, `nope-${s}`), Error, `Scope 'nope-${s}' not found`);
    await assertRejects(() => issueToken(sql, `ghost-${s}`, 'n'), Error, `Member 'ghost-${s}' not found`);
    await assertRejects(() => listTokens(sql, `ghost-${s}`), Error, `Member 'ghost-${s}' not found`);
    await assertRejects(() => createScope(sql, 'Bad_Name'), Error, "Invalid scope name 'Bad_Name'");
    await assertRejects(() => grant(sql, `bot-${s}`, `team-${s}`, 'admin' as 'read'), Error, 'read or write');
  }));

Deno.test('restoreMemory brings back a soft-deleted memory', () =>
  withAdmin(async (sql, s) => {
    const scope = `team-${s}`;
    const sc = await createScope(sql, scope);
    const emb = `[${new Array(384).fill(0.1).join(',')}]`;
    const [m] = await sql`
      insert into agent_memory.memories (scope_id, content, category, embedding, deleted_at)
      values (${sc.id}, 'gone', 'other', ${emb}::extensions.vector, now()) returning id`;
    await restoreMemory(sql, m.id);
    const [r] = await sql`select deleted_at from agent_memory.memories where id = ${m.id}`;
    assertEquals(r.deleted_at, null);
    const h = await sql`select action, member_id from agent_memory.memory_history
      where memory_id = ${m.id} and action = 'restore'`;
    assertEquals(h.length, 1);
    assertEquals(h[0].member_id, null);
    await assertRejects(() => restoreMemory(sql, m.id), Error, `Memory ${m.id} not found or not deleted`);
  }));

Deno.test('create-member --human links auth.users by email, case-insensitively', () =>
  withAdmin(async (sql, s) => {
    const email = `Admin-${s}@example.test`;
    const uid = crypto.randomUUID();
    await sql`insert into auth.users (id, email, instance_id, aud, role)
      values (${uid}, ${email}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`;
    try {
      const linked = await createMember(sql, `h-${s}`, { kind: 'human', email: email.toLowerCase() });
      assertEquals(linked.authUserId, uid);
      const unlinked = await createMember(sql, `h2-${s}`, { kind: 'human', email: `none-${s}@example.test` });
      assertEquals(unlinked.authUserId, null);
      await assertRejects(() => createMember(sql, `h3-${s}`, { kind: 'human' }), Error, 'requires an email');
    } finally {
      await sql`delete from auth.users where id = ${uid}`;
    }
  }));

Deno.test('parseExpires: ISO date and Nd', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  assertEquals(parseExpires('30d', now).toISOString(), '2026-01-31T00:00:00.000Z');
  assertEquals(parseExpires('2027-03-04', now).toISOString(), '2027-03-04T00:00:00.000Z');
  try {
    parseExpires('soon', now);
    throw new Error('should have thrown');
  } catch (e) {
    assert((e as Error).message.includes("Invalid --expires 'soon'"));
  }
});

async function cli(...args: string[]) {
  const r = await new Deno.Command(Deno.execPath(), {
    args: ['run', '-A', 'scripts/admin.ts', ...args],
    env: { AGENT_MEMORY_DB_URL: LOCAL_DB_URL },
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  return { code: r.code, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) };
}

const EMB = `[${new Array(384).fill(0.1).join(',')}]`;
type AdminSql = ReturnType<typeof adminSql>;

async function addMemory(sql: AdminSql, scopeId: string, content: string, deleted = false): Promise<string> {
  const [m] = await sql`
    insert into agent_memory.memories (scope_id, content, category, tags, embedding, deleted_at)
    values (${scopeId}, ${content}, 'other', '{t}', ${EMB}::extensions.vector, ${deleted ? new Date() : null})
    returning id`;
  return m.id;
}

/** Soft-delete as a member (history records them), or as admin when memberId is null. */
async function softDelete(sql: AdminSql, ids: string[], memberId: string | null) {
  if (memberId === null) {
    await sql`update agent_memory.memories set deleted_at = now() where id = any(${ids}::uuid[])`;
    return;
  }
  await sql.begin(async (tx) => {
    await tx`select set_config('agent_memory.member_id', ${memberId}, true)`;
    await tx`select agent_memory.soft_delete(${ids}::uuid[])`;
  });
}

const scrubbedRows = async (sql: AdminSql, id: string) =>
  (await sql`select count(*)::int as n from agent_memory.memory_history where memory_id = ${id}
    and (prev_content is not null or prev_tags is not null or prev_category is not null)`)[0].n as number;

Deno.test('erase needs --yes, then hard-deletes and scrubs history', () =>
  withAdmin(async (sql, s) => {
    const sc = await createScope(sql, `team-${s}`);
    const live = await addMemory(sql, sc.id, 'top secret line\nsecond line');
    await sql`update agent_memory.memories set content = 'top secret line v2' where id = ${live}`;
    const gone = await addMemory(sql, sc.id, 'deleted secret', true);
    try {
      assertEquals(await scrubbedRows(sql, live), 1);

      const dry = await cli('erase', live);
      assertEquals(dry.code, 1);
      assertStringIncludes(dry.out, live);
      assertStringIncludes(dry.out, `team-${s}`);
      assertStringIncludes(dry.out, 'top secret line v2');
      assertStringIncludes(dry.out, '--yes');
      assertEquals((await sql`select 1 from agent_memory.memories where id = ${live}`).length, 1);

      const done = await cli('erase', live, '--yes');
      assertEquals(done.code, 0, done.err);
      assertStringIncludes(done.out, `Erased memory ${live}`);
      assertEquals((await sql`select 1 from agent_memory.memories where id = ${live}`).length, 0);
      assertEquals(await scrubbedRows(sql, live), 0);
      const purge = await sql`select member_id from agent_memory.memory_history
        where memory_id = ${live} and action = 'purge'`;
      assertEquals(purge.map((r) => r.member_id), [null]);

      const again = await cli('erase', live, '--yes');
      assertEquals(again.code, 1);
      assertStringIncludes(again.err, `Memory ${live} not found`);
      assertEquals((await cli('erase', 'not-a-uuid')).code, 1);

      // Soft-deleted memories can be erased too, via the library.
      await eraseMemory(sql, gone);
      assertEquals((await sql`select 1 from agent_memory.memories where id = ${gone}`).length, 0);
      assertEquals(await scrubbedRows(sql, gone), 0);
      await assertRejects(() => eraseMemory(sql, gone), Error, `Memory ${gone} not found`);
    } finally {
      await sql`delete from agent_memory.memory_history where memory_id = any(${[live, gone]}::uuid[])`;
    }
  }));

Deno.test('list-deleted shows scope, deleter and first line, and filters', () =>
  withAdmin(async (sql, s) => {
    const a = await createScope(sql, `team-${s}`);
    const b = await createScope(sql, `other-${s}`);
    const bot = await createMember(sql, `bot-${s}`, { kind: 'bot' });
    await grant(sql, `bot-${s}`, `team-${s}`, 'write');
    const long = 'L'.repeat(120);
    const byBot = await addMemory(sql, a.id, `${long}\nsecond line`);
    const byAdmin = await addMemory(sql, b.id, 'admin removed this');
    const live = await addMemory(sql, a.id, 'still here');
    await softDelete(sql, [byBot], bot.id);
    await softDelete(sql, [byAdmin], null);

    const mine = (await listDeleted(sql)).filter((r) => r.scope.endsWith(s));
    assertEquals(mine.map((r) => r.id).sort(), [byBot, byAdmin].sort());
    const botRow = mine.find((r) => r.id === byBot)!;
    assertEquals(botRow.scope, `team-${s}`);
    assertEquals(botRow.deletedBy, `bot-${s}`);
    assertEquals(botRow.firstLine, 'L'.repeat(80));
    assert(botRow.deletedAt instanceof Date);
    assertEquals(mine.find((r) => r.id === byAdmin)!.deletedBy, 'admin');
    assert(!mine.some((r) => r.id === live));

    assertEquals((await listDeleted(sql, { scope: `team-${s}` })).map((r) => r.id), [byBot]);
    assertEquals((await listDeleted(sql, { by: `bot-${s}` })).map((r) => r.id), [byBot]);
    assert((await listDeleted(sql, { by: 'admin' })).some((r) => r.id === byAdmin));
    assert(!(await listDeleted(sql, { by: 'admin' })).some((r) => r.id === byBot));
    assertEquals(await listDeleted(sql, { scope: `team-${s}`, since: '2999-01-01' }), []);
    assertEquals((await listDeleted(sql, { scope: `team-${s}`, since: '2000-01-01T00:00:00Z' })).length, 1);
    await assertRejects(() => listDeleted(sql, { by: `ghost-${s}` }), Error, `Member 'ghost-${s}' not found`);
    await assertRejects(() => listDeleted(sql, { scope: `nope-${s}` }), Error, `Scope 'nope-${s}' not found`);
    await assertRejects(() => listDeleted(sql, { since: 'yesterday' }), Error, "Invalid --since 'yesterday'");

    const out = await cli('list-deleted', '--scope', `team-${s}`);
    assertEquals(out.code, 0, out.err);
    assertStringIncludes(out.out, byBot);
    assertStringIncludes(out.out, `bot-${s}`);
    assert(!out.out.includes(byAdmin));
    assertEquals(firstLine('  a\nb'), 'a');
  }));

Deno.test('restore takes several ids, or filters with --yes', () =>
  withAdmin(async (sql, s) => {
    const sc = await createScope(sql, `team-${s}`);
    const bot = await createMember(sql, `bot-${s}`, { kind: 'bot' });
    await grant(sql, `bot-${s}`, `team-${s}`, 'write');
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await addMemory(sql, sc.id, `pruned ${i}`));
    await softDelete(sql, ids.slice(0, 4), bot.id);
    await softDelete(sql, [ids[4]], null);
    const deleted = async () =>
      (await sql`select id from agent_memory.memories where scope_id = ${sc.id} and deleted_at is not null`)
        .map((r) => r.id).sort();

    // Several ids at once.
    const two = await cli('restore', ids[0], ids[1]);
    assertEquals(two.code, 0, two.err);
    assertStringIncludes(two.out, 'Restored 2 memories');
    assertEquals(await deleted(), ids.slice(2).sort());

    // A filter without --yes only lists, and exits 1.
    const dry = await cli('restore', '--by', `bot-${s}`);
    assertEquals(dry.code, 1);
    assertStringIncludes(dry.out, ids[2]);
    assertStringIncludes(dry.out, ids[3]);
    assert(!dry.out.includes(ids[4]));
    assertStringIncludes(dry.out, 'Would restore 2 memories');
    assertEquals(await deleted(), ids.slice(2).sort());

    const yes = await cli('restore', '--by', `bot-${s}`, '--scope', `team-${s}`, '--yes');
    assertEquals(yes.code, 0, yes.err);
    assertStringIncludes(yes.out, 'Restored 2 memories');
    assertEquals(await deleted(), [ids[4]]);

    // Guard rails.
    const bare = await cli('restore', '--yes');
    assertEquals(bare.code, 1);
    assertStringIncludes(bare.err, 'Usage: restore');
    const both = await cli('restore', ids[4], '--scope', `team-${s}`);
    assertEquals(both.code, 1);
    assertStringIncludes(both.err, 'not both');
    assertEquals(await deleted(), [ids[4]]);
    const partial = await cli('restore', ids[4], ids[0]);
    assertEquals(partial.code, 1);
    assertStringIncludes(partial.out, 'Restored 1 memory');
    assertStringIncludes(partial.err, `Not found or not deleted: ${ids[0]}`);
    assertEquals(await deleted(), []);

    const r = await restoreMemories(sql, ['not-a-uuid']);
    assertEquals(r, { restored: [], missing: ['not-a-uuid'] });
  }));
