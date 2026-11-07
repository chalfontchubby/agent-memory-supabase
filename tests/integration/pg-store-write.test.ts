import { assert, assertEquals, assertNotEquals, assertRejects } from '@std/assert';
import { connect } from '../../supabase/functions/_shared/db.ts';
import { PgMemoryStore } from '../../supabase/functions/_shared/pg-store.ts';
import { adminSql, LOCAL_DB_URL, makeWorld, type World } from '../helpers/fixtures.ts';
import { FakeEmbedder } from '../helpers/fake-embedder.ts';

async function withWorld(
  fn: (
    w: World,
    admin: ReturnType<typeof adminSql>,
    mk: (memberId: string) => [PgMemoryStore, FakeEmbedder],
  ) => Promise<void>,
) {
  const admin = adminSql();
  const sql = connect(LOCAL_DB_URL);
  const w = await makeWorld(admin);
  try {
    await fn(w, admin, (id) => {
      const e = new FakeEmbedder();
      return [new PgMemoryStore(sql, id, e, 30), e];
    });
  } finally {
    await w.cleanup();
    await sql.end();
    await admin.end();
  }
}

const req = (content: string, tags: string[] = []) => ({ content, category: 'other' as const, tags });
const embOf = async (admin: ReturnType<typeof adminSql>, id: string) =>
  (await admin`select embedding::text as e from agent_memory.memories where id = ${id}`)[0].e as string;

Deno.test('store as rw returns scope and author, embedding stored', () =>
  withWorld(async (w, admin, mk) => {
    const [s] = mk(w.rw.id);
    const m = await s.store(w.alpha.name, req('hello world', ['a']));
    assertEquals(m.scope, w.alpha.name);
    assertEquals(m.createdBy, w.rw.name);
    assertEquals(m.updatedBy, w.rw.name);
    assertEquals(m.tags, ['a']);
    const [r] = await admin`select vector_dims(embedding) as d from agent_memory.memories where id = ${m.id}`;
    assertEquals(r.d, 384);
  }));

Deno.test('store permission errors', () =>
  withWorld(async (w, _a, mk) => {
    const [ro] = mk(w.ro.id);
    await assertRejects(() => ro.store(w.alpha.name, req('x')), Error, `No write access to scope '${w.alpha.name}'`);
    await assertRejects(() => ro.store(w.beta.name, req('x')), Error, `Scope '${w.beta.name}' not found`);
    await assertRejects(() => ro.store("it's-ünïcode", req('x')), Error, "Scope 'it's-ünïcode' not found");
  }));

Deno.test('storeBatch cap and success', () =>
  withWorld(async (w, _a, mk) => {
    const [s, e] = mk(w.rw.id);
    await assertRejects(
      () => s.storeBatch(w.alpha.name, [req('a'), req('b'), req('c')]),
      Error,
      'store_batch accepts at most 2 memories per call on this server; split the batch or call store for each memory.',
    );
    assertEquals(e.calls, 0);
    const out = await s.storeBatch(w.alpha.name, [req('a'), req('b')]);
    assertEquals(out.map((m) => m.content), ['a', 'b']);
  }));

Deno.test('storeBatch is all-or-nothing', () =>
  withWorld(async (w, admin, mk) => {
    const [s] = mk(w.rw.id);
    await assertRejects(() =>
      s.storeBatch(w.alpha.name, [req('ok'), { content: 'bad', category: 'nope' as never, tags: [] }])
    );
    const [r] = await admin`select count(*)::int as n from agent_memory.memories where scope_id = ${w.alpha.id}`;
    assertEquals(r.n, 0);
  }));

Deno.test('update with only tags/category keeps content and embedding', () =>
  withWorld(async (w, admin, mk) => {
    const [s, e] = mk(w.rw.id);
    const m = await s.store(w.alpha.name, req('keep me', ['x']));
    const before = await embOf(admin, m.id);
    const calls = e.calls;
    const u1 = await s.update(m.id, { tags: ['y', 'z'] });
    assertEquals(u1.tags, ['y', 'z']);
    assertEquals(u1.content, 'keep me');
    const u2 = await s.update(m.id, { category: 'learning' });
    assertEquals(u2.category, 'learning');
    assertEquals(u2.tags, ['y', 'z']);
    assertEquals(await embOf(admin, m.id), before);
    assertEquals(e.calls, calls);
  }));

Deno.test('update scope moves memory, needs write on both', () =>
  withWorld(async (w, admin, mk) => {
    const [s] = mk(w.rw.id);
    const m = await s.store(w.alpha.name, req('movable'));
    await assertRejects(() => s.update(m.id, { scope: w.beta.name }), Error, `Scope '${w.beta.name}' not found`);
    await admin`insert into agent_memory.scope_grants (scope_id, member_id, access)
      values (${w.beta.id}, ${w.rw.id}, 'read')`;
    await assertRejects(
      () => s.update(m.id, { scope: w.beta.name }),
      Error,
      `No write access to scope '${w.beta.name}'`,
    );
    await admin`update agent_memory.scope_grants set access = 'write' where scope_id = ${w.beta.id} and member_id = ${w.rw.id}`;
    const moved = await s.update(m.id, { scope: w.beta.name });
    assertEquals(moved.scope, w.beta.name);
    assertEquals(moved.content, 'movable');
  }));

Deno.test('update content: same -> no embed; new -> one embed and fts finds it', () =>
  withWorld(async (w, admin, mk) => {
    const [s, e] = mk(w.rw.id);
    const m = await s.store(w.alpha.name, req('original text'));
    const c = e.calls;
    await s.update(m.id, { content: 'original text' });
    assertEquals(e.calls, c);
    const u = await s.update(m.id, { content: 'brand zebra phrase' });
    assertEquals(e.calls, c + 1);
    assertEquals(u.content, 'brand zebra phrase');
    const r = await admin`select id from agent_memory.memories where fts @@ plainto_tsquery('english', 'zebra')
      and id = ${m.id}`;
    assertEquals(r.length, 1);
    assertNotEquals(u.updatedAt, m.createdAt);
  }));

Deno.test('non-uuid id reads as not found', () =>
  withWorld(async (w, _a, mk) => {
    const [s] = mk(w.rw.id);
    await assertRejects(() => s.update('not-a-uuid', { tags: [] }), Error, 'Memory not-a-uuid not found');
    await assertRejects(() => s.delete('x'), Error, 'Memory x not found');
  }));

Deno.test('content round-trips exactly', () =>
  withWorld(async (w, _a, mk) => {
    const [s] = mk(w.rw.id);
    const body = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(' ');
    for (const c of [`it's "quoted" 100% ünïcode \\ ; --`, body]) {
      const m = await s.store(w.alpha.name, req(c, ["t'ag", '%']));
      assertEquals(m.content, c);
      assertEquals(m.tags, ["t'ag", '%']);
    }
  }));

Deno.test('update and delete permissions', () =>
  withWorld(async (w, _a, mk) => {
    const [rw] = mk(w.rw.id);
    const [ro] = mk(w.ro.id);
    const [none] = mk(w.none.id);
    const m = await rw.store(w.alpha.name, req('target'));
    await assertRejects(() => ro.delete(m.id), Error, `No write access to scope '${w.alpha.name}'`);
    await assertRejects(() => ro.update(m.id, { tags: [] }), Error, `No write access to scope '${w.alpha.name}'`);
    await assertRejects(() => none.delete(m.id), Error, `Memory ${m.id} not found`);
    await rw.delete(m.id);
    await assertRejects(() => rw.delete(m.id), Error, `Memory ${m.id} not found`);
    await assertRejects(() => ro.update(m.id, { tags: [] }), Error, `Memory ${m.id} not found`);
  }));

Deno.test('prune dry-run, evergreen exclusion and real delete', () =>
  withWorld(async (w, admin, mk) => {
    const [s] = mk(w.rw.id);
    const old = await s.store(w.alpha.name, req('old one'));
    const ever = await s.store(w.alpha.name, req('old evergreen', ['evergreen']));
    const fresh = await s.store(w.alpha.name, req('fresh'));
    await admin`update agent_memory.memories set updated_at = now() - interval '200 days'
      where id = any(${[old.id, ever.id]}::uuid[])`;
    const dry = await s.prune({ scope: w.alpha.name, minStrength: 0 });
    assertEquals(dry.dryRun, true);
    assertEquals(dry.pruned, 0);
    assertEquals(dry.inspected, 3);
    assertEquals(dry.candidates.map((c) => c.id), [old.id]);
    assertEquals(dry.candidates[0].reason, 'never accessed, 200 days old > 90');
    const real = await s.prune({ scope: w.alpha.name, minStrength: 0, dryRun: false });
    assertEquals(real.pruned, 1);
    const left =
      await admin`select id from agent_memory.memories where scope_id = ${w.alpha.id} and deleted_at is null`;
    assertEquals(left.map((r) => r.id).sort(), [ever.id, fresh.id].sort());
    const [ro] = mk(w.ro.id);
    await assertRejects(() => ro.prune({ scope: w.alpha.name }), Error, `No write access to scope '${w.alpha.name}'`);
    const [none] = mk(w.none.id);
    await assertRejects(() => none.prune({ scope: w.alpha.name }), Error, `Scope '${w.alpha.name}' not found`);
  }));

Deno.test('prune default strength threshold reports strength reason', () =>
  withWorld(async (w, admin, mk) => {
    const [s] = mk(w.rw.id);
    const m = await s.store(w.alpha.name, req('ancient'));
    await admin`update agent_memory.memories set updated_at = now() - interval '1000 days' where id = ${m.id}`;
    const r = await s.prune({ scope: w.alpha.name });
    assert(/^strength 0\.\d{4} < 0\.05$/.test(r.candidates[0].reason));
  }));

Deno.test('listScopes as ro', () =>
  withWorld(async (w, _a, mk) => {
    const [rw] = mk(w.rw.id);
    await rw.store(w.alpha.name, req('one'));
    const [ro] = mk(w.ro.id);
    assertEquals(await ro.listScopes(), [
      { scope: w.alpha.name, access: 'read', memoryCount: 1, description: null },
    ]);
  }));
