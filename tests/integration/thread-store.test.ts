import { assert, assertEquals, assertRejects } from '@std/assert';
import postgres from 'npm:postgres@3.4.5';
import { connect } from '../../supabase/functions/_shared/db.ts';
import { PgThreadStore } from '../../supabase/functions/_shared/thread-store.ts';
import { adminSql, LOCAL_DB_URL, makeWorld, type World } from '../helpers/fixtures.ts';

type Admin = ReturnType<typeof adminSql>;

async function withWorld(fn: (w: World, admin: Admin, mk: (memberId: string) => PgThreadStore) => Promise<void>) {
  const admin = adminSql();
  const sql = connect(LOCAL_DB_URL);
  const w = await makeWorld(admin);
  try {
    await fn(w, admin, (id) => new PgThreadStore(sql, id));
  } finally {
    await w.cleanup();
    await sql.end();
    await admin.end();
  }
}

async function addMemory(admin: Admin, w: World, scopeId: string, content: string): Promise<string> {
  const emb = `[${new Array(384).fill(0.1).join(',')}]`;
  const [m] = await admin`
    insert into agent_memory.memories (scope_id, content, category, embedding, created_by)
    values (${scopeId}, ${content}, 'other', ${emb}::extensions.vector, ${w.rw.id}) returning id`;
  return m.id;
}

Deno.test('createThread returns thread and new session', () =>
  withWorld(async (w, _a, mk) => {
    const s = mk(w.rw.id);
    const r = await s.createThread(w.alpha.name, 'Plan', 'first post', [], {});
    assertEquals(r.session.created, true);
    assertEquals(r.thread.postCount, 1);
    assertEquals(r.thread.status, 'open');
    assertEquals(r.thread.scope, w.alpha.name);
    assertEquals(r.thread.createdBy, w.rw.name);
  }));

Deno.test('createThread with session_label reuses the session', () =>
  withWorld(async (w, _a, mk) => {
    const s = mk(w.rw.id);
    const a = await s.createThread(w.alpha.name, 'One', 'x', [], { sessionLabel: 'lbl' });
    const b = await s.createThread(w.alpha.name, 'Two', 'y', [], { sessionLabel: 'lbl' });
    assertEquals(a.session.id, b.session.id);
    assertEquals(a.session.created, true);
    assertEquals(b.session.created, false);
  }));

Deno.test('ro cannot post; unknown scope reads as not found', () =>
  withWorld(async (w, _a, mk) => {
    await assertRejects(
      () => mk(w.ro.id).createThread(w.alpha.name, 't', 'b', [], {}),
      Error,
      `No write access to scope '${w.alpha.name}'`,
    );
    await assertRejects(
      () => mk(w.none.id).createThread(w.alpha.name, 't', 'b', [], {}),
      Error,
      `Scope '${w.alpha.name}' not found`,
    );
    const t = await mk(w.rw.id).createThread(w.alpha.name, 't', 'b', [], {});
    await assertRejects(
      () => mk(w.ro.id).post(t.thread.id, 'hi', {}),
      Error,
      `No write access to scope '${w.alpha.name}'`,
    );
  }));

Deno.test('createThread rejects more than 20 memory ids', () =>
  withWorld(async (w, _a, mk) => {
    const ids = Array.from({ length: 21 }, () => crypto.randomUUID());
    await assertRejects(
      () => mk(w.rw.id).createThread(w.alpha.name, 't', 'b', ids, {}),
      Error,
      'At most 20 memory_ids',
    );
  }));

Deno.test('none cannot read; bad ids read the same', () =>
  withWorld(async (w, _a, mk) => {
    const t = await mk(w.rw.id).createThread(w.alpha.name, 't', 'b', [], {});
    const n = mk(w.none.id);
    await assertRejects(() => n.readThread(t.thread.id, {}, {}), Error, `Thread ${t.thread.id} not found`);
    const r = crypto.randomUUID();
    await assertRejects(() => n.readThread(r, {}, {}), Error, `Thread ${r} not found`);
    await assertRejects(() => n.readThread('nope', {}, {}), Error, 'Thread nope not found');
    await assertRejects(() => n.post('nope', 'x', {}), Error, 'Thread nope not found');
    await assertRejects(
      () => mk(w.rw.id).readThread(t.thread.id, {}, { session: 'nope' }),
      Error,
      'Session not found',
    );
  }));

Deno.test("two sessions of one member see each other's posts as new", () =>
  withWorld(async (w, _a, mk) => {
    const s = mk(w.rw.id);
    const a = await s.createThread(w.alpha.name, 't', 'b', [], { sessionLabel: 'A' });
    await s.subscribe(a.thread.id, { sessionLabel: 'B' });
    await s.post(a.thread.id, 'from B', { sessionLabel: 'B' });
    const wa = await s.whatsNew({ sessionLabel: 'A' });
    assertEquals(wa.threads.length, 1);
    assertEquals(wa.threads[0].newPosts, 1);
    assertEquals(wa.threads[0].threadId, a.thread.id);
    assertEquals((await s.whatsNew({ sessionLabel: 'B' })).threads.length, 0);
    await assertRejects(() => s.whatsNew({}), Error, 'Pass session or session_label');
    await assertRejects(() => s.unsubscribe(a.thread.id, {}), Error, 'Pass session or session_label');
  }));

Deno.test('catch-up read advances marker; paging back does not', () =>
  withWorld(async (w, _a, mk) => {
    const s = mk(w.rw.id);
    const a = await s.createThread(w.alpha.name, 't', 'first', [], { sessionLabel: 'A' });
    const t = a.thread.id;
    for (let i = 0; i < 5; i++) await s.post(t, `p${i}`, { sessionLabel: 'B' });
    const r1 = await s.readThread(t, { limit: 2 }, { sessionLabel: 'A' });
    assertEquals(r1.posts.map((p) => p.seq), [2, 3]);
    assertEquals(r1.moreUnread, true);
    assert(r1.posts.every((p) => p.new === true));
    assertEquals(r1.hasOlder, true);
    assertEquals(r1.session?.label, 'A');
    const back = await s.readThread(t, { before: 2, limit: 5 }, { sessionLabel: 'A' });
    assertEquals(back.posts.map((p) => p.seq), [1]);
    assertEquals(back.posts[0].new, undefined);
    assertEquals((await s.whatsNew({ sessionLabel: 'A' })).threads[0].newPosts, 3);
    const r2 = await s.readThread(t, { limit: 5 }, { sessionLabel: 'A' });
    assertEquals(r2.posts.map((p) => p.seq), [4, 5, 6]);
    assertEquals(r2.moreUnread, false);
    // Nothing unread now: latest posts, not flagged new.
    const r3 = await s.readThread(t, { limit: 2 }, { sessionLabel: 'A' });
    assertEquals(r3.posts.map((p) => p.seq), [5, 6]);
    assertEquals(r3.posts[0].new, undefined);
    // No session: latest posts ascending.
    const r4 = await s.readThread(t, { limit: 3 }, {});
    assertEquals(r4.posts.map((p) => p.seq), [4, 5, 6]);
    assertEquals(r4.session, undefined);
    await assertRejects(() => s.readThread(t, { before: 2, after: 1 }, {}), Error, 'Pass before or after, not both');
    const af = await s.readThread(t, { after: 4, limit: 10 }, {});
    assertEquals(af.posts.map((p) => p.seq), [5, 6]);
  }));

Deno.test('resolve and reopen appear in whats_new', () =>
  withWorld(async (w, _a, mk) => {
    const s = mk(w.rw.id);
    const a = await s.createThread(w.alpha.name, 't', 'b', [], { sessionLabel: 'A' });
    const t = a.thread.id;
    const r = await s.setStatus(t, 'resolved', 'done', { sessionLabel: 'B' });
    assertEquals(r.thread.status, 'resolved');
    let wn = await s.whatsNew({ sessionLabel: 'A' });
    assertEquals(wn.threads[0].status, 'resolved');
    assertEquals(wn.threads[0].newPosts, 1);
    const view = await s.readThread(t, {}, { sessionLabel: 'A' });
    assertEquals(view.posts[0].kind, 'resolve');
    await s.setStatus(t, 'open', undefined, { sessionLabel: 'B' });
    wn = await s.whatsNew({ sessionLabel: 'A' });
    assertEquals(wn.threads[0].status, 'open');
    assertEquals(wn.threads[0].newPosts, 1);
    await assertRejects(() => s.setStatus(t, 'open', undefined, {}), Error, 'Thread is already open');
  }));

Deno.test('concurrent posts get consecutive seq', async () => {
  const admin = adminSql();
  const sql = postgres(LOCAL_DB_URL, { max: 5, prepare: false });
  const w = await makeWorld(admin);
  try {
    const t = await new PgThreadStore(sql, w.rw.id).createThread(w.alpha.name, 't', 'b', [], {});
    const res = await Promise.all(
      Array.from({ length: 10 }, (_, i) => new PgThreadStore(sql, w.rw.id).post(t.thread.id, `p${i}`, {})),
    );
    assertEquals(res.map((r) => r.post.seq).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  } finally {
    await w.cleanup();
    await sql.end();
    await admin.end();
  }
});

Deno.test('listThreads pages newest first', () =>
  withWorld(async (w, _a, mk) => {
    const s = mk(w.rw.id);
    const ids: string[] = [];
    for (const n of ['one', 'two', 'three']) {
      ids.push((await s.createThread(w.alpha.name, n, 'b', [], {})).thread.id);
    }
    const p1 = await s.listThreads({ scopes: [w.alpha.name], limit: 2 });
    assertEquals(p1.threads.map((t) => t.id), [ids[2], ids[1]]);
    assert(p1.next);
    const p2 = await s.listThreads({ scopes: [w.alpha.name], limit: 2, before: p1.next });
    assertEquals(p2.threads.map((t) => t.id), [ids[0]]);
    assertEquals(p2.next, null);
    await s.setStatus(ids[0], 'resolved', undefined, {});
    assertEquals((await s.listThreads({ scopes: [w.alpha.name] })).threads.length, 2);
    assertEquals((await s.listThreads({ scopes: [w.alpha.name], status: 'all' })).threads.length, 3);
    await assertRejects(() => s.listThreads({ before: 'garbage!' }), Error, 'Invalid cursor');
    await assertRejects(
      () => mk(w.none.id).listThreads({ scopes: [w.alpha.name] }),
      Error,
      `Scope '${w.alpha.name}' not found`,
    );
    assertEquals((await mk(w.none.id).listThreads({})).threads, []);
  }));

Deno.test('links, unlink and linkedThreads only return readable links', () =>
  withWorld(async (w, admin, mk) => {
    const s = mk(w.rw.id);
    const mA = await addMemory(admin, w, w.alpha.id, 'alpha memory '.repeat(30));
    const mB = await addMemory(admin, w, w.beta.id, 'beta memory');
    const t = await s.createThread(w.alpha.name, 't', 'b', [mA], {});
    // rw cannot read beta, so linking it reads as not found.
    await assertRejects(() => s.link(t.thread.id, mB), Error, `Memory ${mB} not found`);
    await assertRejects(() => s.link(t.thread.id, 'nope'), Error, 'Memory nope not found');
    // Make a beta link directly, as postgres, to test visibility.
    await admin`insert into agent_memory.thread_links (thread_id, memory_id, linked_by)
      values (${t.thread.id}, ${mB}, ${w.bw.id})`;
    const view = await s.readThread(t.thread.id, {}, {});
    assertEquals(view.links.length, 1);
    assertEquals(view.links[0].memoryId, mA);
    assertEquals(view.links[0].preview.length, 200);
    const lt = await s.linkedThreads([mA, mB]);
    assertEquals(lt[mA].map((x) => x.id), [t.thread.id]);
    assertEquals(lt[mB], undefined);
    const ro = await mk(w.ro.id).linkedThreads([mA, 'nope']);
    assertEquals(ro[mA].length, 1);
    assertEquals(await s.unlink(t.thread.id, mA), true);
    assertEquals(await s.unlink(t.thread.id, mA), false);
    await s.link(t.thread.id, mA);
    assertEquals((await s.readThread(t.thread.id, {}, {})).links.length, 1);
  }));

Deno.test('own posts are not unread: solo session gets latest posts', () =>
  withWorld(async (w, _a, mk) => {
    const s = mk(w.rw.id);
    const a = await s.createThread(w.alpha.name, 't', 'first', [], { sessionLabel: 'A' });
    for (let i = 0; i < 24; i++) await s.post(a.thread.id, `p${i}`, { sessionLabel: 'A' });
    const r = await s.readThread(a.thread.id, { limit: 20 }, { sessionLabel: 'A' });
    assertEquals(r.posts.map((p) => p.seq), Array.from({ length: 20 }, (_, i) => i + 6));
    assertEquals(r.moreUnread, undefined);
    assert(r.posts.every((p) => p.new === undefined));
    assertEquals((await s.whatsNew({ sessionLabel: 'A' })).threads.length, 0);
  }));

Deno.test('catch-up page mixes own and other posts', () =>
  withWorld(async (w, _a, mk) => {
    const s = mk(w.rw.id);
    const a = await s.createThread(w.alpha.name, 't', 'first', [], { sessionLabel: 'A' });
    const t = a.thread.id;
    await s.post(t, 'b2', { sessionLabel: 'B' }); // seq 2
    await s.post(t, 'a3', { sessionLabel: 'A' }); // seq 3
    await s.post(t, 'a4', { sessionLabel: 'A' }); // seq 4
    const r = await s.readThread(t, { limit: 2 }, { sessionLabel: 'A' });
    assertEquals(r.posts.map((p) => [p.seq, p.new]), [[2, true], [3, false]]);
    assertEquals(r.moreUnread, false);
    const r2 = await s.readThread(t, { limit: 10 }, { sessionLabel: 'A' });
    assertEquals(r2.posts.map((p) => p.seq), [1, 2, 3, 4]);
    assertEquals(r2.moreUnread, undefined);
  }));
