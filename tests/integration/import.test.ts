import { assert, assertEquals, assertRejects } from '@std/assert';
import { type ImportedMemory, importMemories, selectMemories } from '../../scripts/import.ts';
import { adminSql } from '../helpers/fixtures.ts';

const all: ImportedMemory[] = JSON.parse(await Deno.readTextFile('tests/fixtures/export-sample.json'));
const ID = (n: number) => all[n - 1].id;
const ids = (r: { selected: ImportedMemory[] }) => r.selected.map((m) => m.id);
const none = { includeTags: [], excludeTags: [] };

Deno.test('selectMemories: no filters selects everything', () => {
  const r = selectMemories(all, none);
  assertEquals(ids(r), all.map((m) => m.id));
  assertEquals([r.excludedByTag, r.notInIds], [0, 0]);
});

Deno.test('selectMemories: include tags are an any-of', () => {
  const r = selectMemories(all, { includeTags: ['indexing', 'networking'], excludeTags: [] });
  assertEquals(ids(r), [ID(1), ID(3)]);
  assertEquals(r.excludedByTag, 2);
});

Deno.test('selectMemories: exclude tags win over include tags', () => {
  const r = selectMemories(all, { includeTags: ['database'], excludeTags: ['private'] });
  assertEquals(ids(r), [ID(1)]);
  assertEquals(r.excludedByTag, 3);
});

Deno.test('selectMemories: ids list narrows the tag result', () => {
  const r = selectMemories(all, { includeTags: [], excludeTags: ['private'], ids: [ID(3), ID(2), ID(4)] });
  assertEquals(ids(r), [ID(3), ID(4)]);
  assertEquals([r.excludedByTag, r.notInIds], [1, 1]);
});

Deno.test('selectMemories: an empty ids list selects nothing', () => {
  const r = selectMemories(all, { ...none, ids: [] });
  assertEquals(r.selected.length, 0);
  assertEquals(r.notInIds, 4);
});

function stubEmbed(failures: number) {
  const state = { calls: 0, auth: [] as string[], bodies: [] as string[] };
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    state.calls++;
    state.auth.push(req.headers.get('authorization') ?? '');
    state.bodies.push(await req.text());
    if (state.calls <= failures) return new Response('CPU limit', { status: 546 });
    return Response.json({ embedding: Array.from({ length: 384 }, (_, i) => Math.sin(i) / 10) });
  });
  return { state, server, url: `http://127.0.0.1:${server.addr.port}` };
}

Deno.test('importMemories: executes against the local stack, retries 546, preserves fields, is idempotent', async () => {
  const sql = adminSql();
  const sfx = crypto.randomUUID().slice(0, 8);
  const scope = `imp-${sfx}`;
  const member = `imp-m-${sfx}`;
  const stub = stubEmbed(2);
  const delays: number[] = [];
  const sleep = (ms: number) => {
    delays.push(ms);
    return Promise.resolve();
  };
  const [s] = await sql`insert into agent_memory.scopes (name) values (${scope}) returning id`;
  const [m] = await sql`insert into agent_memory.members (display_name, kind) values (${member}, 'bot') returning id`;
  const dbIds = all.map((x) => x.id);
  try {
    const opts = { scope, as: member, embedUrl: stub.url, token: 'amm_stub', sleep };

    // Dry run touches nothing: selection alone never calls the database or the stub.
    selectMemories(all, none);
    assertEquals(stub.state.calls, 0);
    assertEquals((await sql`select 1 from agent_memory.memories where scope_id = ${s.id}`).length, 0);

    const bad: ImportedMemory[] = [
      { ...all[0], id: '55555555-5555-4555-8555-555555555555', category: 'nope' },
      { ...all[0], id: '66666666-6666-4666-8666-666666666666', content: '  ' },
    ];
    const first = await importMemories(sql, [...all, ...bad], { ...opts, log: () => {} });
    assertEquals([first.imported, first.skipped, first.failed], [4, 0, 2]);
    assertEquals(delays, [1000, 2000]);
    assertEquals(stub.state.calls, 2 + 4);
    assert(stub.state.auth.every((a) => a === 'Bearer amm_stub'));
    assertEquals(JSON.parse(stub.state.bodies[0]), { text: all[0].content });

    const rows = await sql`
      select id, category, tags, created_at::text c, updated_at::text u, access_count,
             last_accessed_at::text la, created_by, updated_by, embedding is not null as has_vec
      from agent_memory.memories where scope_id = ${s.id} order by id`;
    assertEquals(rows.map((r) => r.id), dbIds);
    const r1 = rows[0];
    assertEquals(r1.tags, ['database', 'indexing']);
    assertEquals(r1.category, 'architecture');
    assertEquals(r1.access_count, 7);
    assertEquals(new Date(r1.c).toISOString(), '2026-01-05T10:00:00.123Z');
    assertEquals(new Date(r1.u).toISOString(), '2026-01-06T11:30:00.456Z');
    assertEquals(new Date(r1.la).toISOString(), '2026-02-01T08:15:00.789Z');
    assertEquals(rows[1].la, null);
    assertEquals([r1.created_by, r1.updated_by], [m.id, m.id]);
    assert(rows.every((r) => r.has_vec));

    const second = await importMemories(sql, all, { ...opts, log: () => {} });
    assertEquals([second.imported, second.skipped, second.failed], [0, 4, 0]);
  } finally {
    stub.server.shutdown();
    await stub.server.finished;
    await sql`delete from agent_memory.memories where scope_id = ${s.id}`;
    await sql`delete from agent_memory.memory_history where memory_id = any(${dbIds}::uuid[])`;
    await sql`delete from agent_memory.members where id = ${m.id}`;
    await sql`delete from agent_memory.scopes where id = ${s.id}`;
    await sql.end();
  }
});

Deno.test('importMemories: gives up after five retries and counts the memory as failed', async () => {
  const sql = adminSql();
  const sfx = crypto.randomUUID().slice(0, 8);
  const stub = stubEmbed(1000);
  const delays: number[] = [];
  const [s] = await sql`insert into agent_memory.scopes (name) values (${'imp-f-' + sfx}) returning id`;
  const [m] = await sql`insert into agent_memory.members (display_name, kind) values (${
    'imp-fm-' + sfx
  }, 'bot') returning id`;
  try {
    const r = await importMemories(sql, [all[0]], {
      scope: `imp-f-${sfx}`,
      as: `imp-fm-${sfx}`,
      embedUrl: stub.url,
      token: 'amm_stub',
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      log: () => {},
    });
    assertEquals([r.imported, r.skipped, r.failed], [0, 0, 1]);
    assertEquals(delays, [1000, 2000, 4000, 8000, 16000]);
    assertEquals(stub.state.calls, 6);
    await assertRejects(
      () =>
        importMemories(sql, [all[0]], { scope: 'nope-' + sfx, as: `imp-fm-${sfx}`, embedUrl: stub.url, token: 't' }),
      Error,
      `Scope 'nope-${sfx}' not found`,
    );
  } finally {
    stub.server.shutdown();
    await stub.server.finished;
    await sql`delete from agent_memory.members where id = ${m.id}`;
    await sql`delete from agent_memory.scopes where id = ${s.id}`;
    await sql.end();
  }
});

Deno.test('CLI: dry run needs only --file, prints the summary and inserts nothing', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'import-test-' });
  try {
    const run = (...args: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args: ['run', '-A', 'scripts/import.ts', ...args],
        env: { AGENT_MEMORY_DB_URL: '', AGENT_MEMORY_URL: '', AGENT_MEMORY_TOKEN: '' },
        clearEnv: true,
        stdout: 'piped',
        stderr: 'piped',
      }).output();
    const out = `${dir}/ids.txt`;
    const r = await run('--file', 'tests/fixtures/export-sample.json', '--exclude-tag', 'private', '--write-ids', out);
    const text = new TextDecoder().decode(r.stdout);
    assertEquals(r.code, 0);
    assert(text.includes(`${ID(1)} | architecture | database,indexing | Sample: use a partial index`));
    assert(text.includes('selected 3 of 4 (excluded by tag: 1, not in ids: 0)'));
    assertEquals((await Deno.readTextFile(out)).trim().split('\n'), [ID(1), ID(3), ID(4)]);

    const x = await run('--file', 'tests/fixtures/export-sample.json', '--scope', 'a', '--as', 'b', '--execute');
    assertEquals(x.code, 1);
    const err = new TextDecoder().decode(x.stderr);
    assert(
      err.includes('AGENT_MEMORY_DB_URL') && err.includes('AGENT_MEMORY_URL') && err.includes('AGENT_MEMORY_TOKEN'),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
