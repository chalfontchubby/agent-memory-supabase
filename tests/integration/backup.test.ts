// Wipes the shared local test database (truncate ... cascade) to prove a restore into an empty install.
// To stay safe it snapshots everything first and puts it back afterwards (access tokens are not
// restorable by design, so tokens in the local DB are lost). Keep this in its own file: deno test
// runs files sequentially, so no other integration file overlaps it.
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from '@std/assert';
import { exportBackup, restoreBackup } from '../../scripts/backup.ts';
import { adminSql, LOCAL_DB_URL } from '../helpers/fixtures.ts';

const sql = adminSql();
const dir = await Deno.makeTempDir({ prefix: 'backup-test-' });

const vec = (seed: number) => `[${Array.from({ length: 384 }, (_, i) => Math.sin(seed + i) / 10).join(',')}]`;

async function truncateAll() {
  await sql`truncate agent_memory.memories, agent_memory.memory_history, agent_memory.scope_grants,
    agent_memory.access_tokens, agent_memory.members, agent_memory.scopes cascade`;
}

async function cli(...args: string[]) {
  const r = await new Deno.Command(Deno.execPath(), {
    args: ['run', '-A', 'scripts/backup.ts', ...args],
    env: { AGENT_MEMORY_DB_URL: LOCAL_DB_URL },
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  return { code: r.code, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) };
}

async function snapshotRows() {
  const mem = await sql`select id, scope_id, content, category, tags, created_at::text, updated_at::text,
    created_by, updated_by, access_count, last_accessed_at::text, deleted_at::text, embedding::text
    from agent_memory.memories order by id`;
  const grants = await sql`select scope_id, member_id, access, granted_at::text, granted_by
    from agent_memory.scope_grants order by member_id`;
  const members =
    await sql`select id, display_name, kind, email, auth_user_id, created_at::text from agent_memory.members order by id`;
  const scopes = await sql`select id, description, created_at::text, name from agent_memory.scopes order by name`;
  return { mem, grants, members, scopes };
}

Deno.test('backup and restore-backup round trip', async () => {
  const original = await exportBackup(sql); // whatever the local DB holds now, put back at the end
  const originalFile = `${dir}/original-local-db.json`;
  await Deno.writeTextFile(originalFile, JSON.stringify(original), { mode: 0o600 });
  let safe = false;
  try {
    await truncateAll();
    const [a] =
      await sql`insert into agent_memory.scopes (name, description) values ('bk-alpha', 'first') returning id`;
    const [b] = await sql`insert into agent_memory.scopes (name) values ('bk-beta') returning id`;
    const [ann] = await sql`insert into agent_memory.members (display_name, kind, email, auth_user_id)
      values ('bk-ann', 'human', 'ann@example.test', gen_random_uuid()) returning id`;
    const [bot] =
      await sql`insert into agent_memory.members (display_name, kind) values ('bk-bot', 'bot') returning id`;
    await sql`insert into agent_memory.scope_grants (scope_id, member_id, access, granted_by)
      values (${a.id}, ${ann.id}, 'write', 'tester'), (${b.id}, ${bot.id}, 'read', 'tester')`;
    const mk = async (scope: string, content: string, seed: number, by: string, extra = sql`null`) => {
      const [r] = await sql`insert into agent_memory.memories
        (scope_id, content, category, tags, created_by, updated_by, access_count, last_accessed_at, deleted_at, embedding)
        values (${scope}, ${content}, 'learning', ${sql.array(['x', 'y,z', 'q"uote'], 1009)}, ${by}, ${by}, ${seed},
                now(), ${extra}, ${vec(seed)}::extensions.vector) returning id`;
      return r.id as string;
    };
    const live = await mk(a.id, 'live memory', 3, ann.id);
    const dead = await mk(a.id, 'deleted memory', 4, ann.id, sql`now()`);
    await mk(b.id, 'other scope memory', 5, bot.id);
    // a token whose hash must never appear
    await sql`insert into agent_memory.access_tokens (member_id, name, token_hash)
      values (${ann.id}, 'laptop', ${'f'.repeat(64)})`;

    // --- backup file
    const full = `${dir}/full.json`;
    const r1 = await cli('backup', '--out', full);
    assertEquals(r1.code, 0, r1.err);
    assertEquals((await Deno.stat(full)).mode! & 0o777, 0o600);
    const again = await cli('backup', '--out', full);
    assertEquals(again.code, 1);
    assertStringIncludes(again.err, `${full} already exists`);
    const text = await Deno.readTextFile(full);
    assert(!text.includes('token_hash'));
    assert(!text.includes('amm_'));
    assert(!text.includes('f'.repeat(64)));
    const data = JSON.parse(text);
    assertEquals(data.format, 'agent-memory-supabase-backup');
    assertEquals(data.version, 1);
    assertEquals(data.memories.length, 3);
    assertEquals(data.memories.find((m: { id: string }) => m.id === dead).deletedAt !== null, true);
    assertEquals(data.memories.find((m: { id: string }) => m.id === live).deletedAt, null);
    assertEquals(data.memories.find((m: { id: string }) => m.id === live).createdBy, 'bk-ann');
    assertEquals(data.memories[0].embedding.length, 384);

    // --- --scope limits memories, grants and members
    const only = `${dir}/only.json`;
    const r2 = await cli('backup', '--scope', 'bk-alpha', '--out', only);
    assertEquals(r2.code, 0, r2.err);
    const sc = JSON.parse(await Deno.readTextFile(only));
    assertEquals(sc.scopes.map((s: { name: string }) => s.name), ['bk-alpha']);
    assertEquals(sc.memories.length, 2);
    assertEquals(sc.grants.map((g: { member: string }) => g.member), ['bk-ann']);
    assertEquals(sc.members.map((m: { displayName: string }) => m.displayName), ['bk-ann']);
    const r3 = await cli('backup', '--scope', 'nope', '--out', `${dir}/nope.json`);
    assertEquals(r3.code, 1);
    assertStringIncludes(r3.err, "Scope 'nope' not found");

    // --- wipe, restore, compare
    const before = await snapshotRows();
    await truncateAll();
    const r4 = await cli('restore-backup', full);
    assertEquals(r4.code, 0, r4.err);
    const after = await snapshotRows();
    assertEquals(after.scopes.length, 2);
    assert(before.members.some((m) => m.auth_user_id !== null));
    assertEquals(after.members, before.members); // incl. auth_user_id and created_at
    assertEquals(after.scopes, before.scopes); // ids preserved
    assertEquals(after.mem, before.mem); // includes embedding::text and microsecond timestamps
    assertEquals(after.grants, before.grants);
    const hist = await sql`select action, member_id from agent_memory.memory_history`;
    assertEquals(hist.length, 3);
    assert(hist.every((h) => h.action === 'insert' && h.member_id === null));
    assertEquals((await sql`select count(*)::int as n from agent_memory.access_tokens`)[0].n, 0);

    // --- refuses into a non-empty install
    const r5 = await cli('restore-backup', full);
    assertEquals(r5.code, 1);
    assertStringIncludes(r5.err, 'restore-backup needs an empty install');
    assertNotEquals(r5.out.includes('Restored'), true);
    assertEquals((await sql`select count(*)::int as n from agent_memory.memories`)[0].n, 3);
  } finally {
    try {
      await truncateAll();
      await restoreBackup(sql, original);
      safe = true;
    } catch (e) {
      console.error(
        `Safety restore failed (${(e as Error).message}); the local DB snapshot is kept at ${originalFile}`,
      );
    } finally {
      await sql.end();
    }
    if (safe) await Deno.remove(dir, { recursive: true });
  }
});
