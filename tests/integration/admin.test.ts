import { assert, assertEquals, assertRejects } from '@std/assert';
import { hashToken } from '../../supabase/functions/_shared/tokens.ts';
import {
  createMember,
  createScope,
  grant,
  issueToken,
  listGrants,
  listScopes,
  listTokens,
  parseExpires,
  restoreMemory,
  revoke,
  revokeToken,
} from '../../scripts/lib/admin-db.ts';
import { adminSql } from '../helpers/fixtures.ts';

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
