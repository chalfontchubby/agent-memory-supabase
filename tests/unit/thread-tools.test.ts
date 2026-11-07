import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { McpServer } from 'npm:@modelcontextprotocol/server@2.4.0';
import {
  registerThreadTools,
  SESSION_NOTE,
  type ThreadStoreLike,
} from '../../supabase/functions/_shared/thread-tools.ts';
import { StoreError } from '../../supabase/functions/_shared/limits.ts';

const T = '11111111-1111-4111-8111-111111111111';
const M = '22222222-2222-4222-8222-222222222222';
const S = '33333333-3333-4333-8333-333333333333';

const summary = {
  id: T,
  scope: 's',
  title: 'T',
  status: 'open' as const,
  createdBy: 'a',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastPostAt: '2026-01-01T00:00:00.000Z',
  postCount: 1,
  lastAuthor: 'a',
};
const post = { seq: 1, kind: 'post' as const, body: 'b', author: 'a', sessionLabel: 'x', createdAt: summary.createdAt };

// deno-lint-ignore no-explicit-any
type Calls = Record<string, any[][]>;
type Reg = Record<string, {
  description?: string;
  // deno-lint-ignore no-explicit-any
  handler: (args: any, ctx?: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
}>;

function setup(opts: { created?: boolean; fail?: Error } = {}) {
  const calls: Calls = {};
  const session = { id: S, label: 'x', created: opts.created ?? false };
  const rec = <R>(n: string, r: R, ...a: unknown[]) => {
    (calls[n] ??= []).push(a);
    return opts.fail ? Promise.reject(opts.fail) : Promise.resolve(r);
  };
  const store: ThreadStoreLike = {
    createThread: (...a) => rec('createThread', { thread: summary, session }, ...a),
    post: (...a) => rec('post', { post, session }, ...a),
    setStatus: (...a) => rec('setStatus', { thread: summary, session }, ...a),
    readThread: (...a) => rec('readThread', { thread: summary, links: [], posts: [], hasOlder: false }, ...a),
    listThreads: (...a) => rec('listThreads', { threads: [summary], next: null }, ...a),
    link: (...a) => rec('link', undefined, ...a),
    unlink: (...a) => rec('unlink', true, ...a),
    subscribe: (...a) => rec('subscribe', { session }, ...a),
    unsubscribe: (...a) => rec('unsubscribe', true, ...a),
    whatsNew: (...a) => rec('whatsNew', { session, threads: [] }, ...a),
  };
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerThreadTools(server, store);
  const reg = (server as unknown as { _registeredTools: Reg })._registeredTools;
  return { reg, calls };
}
const json = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

Deno.test('registers the 11 thread tools', () => {
  assertEquals(Object.keys(setup().reg).sort(), [
    'create_thread',
    'link_memory',
    'list_threads',
    'post',
    'read_thread',
    'reopen_thread',
    'resolve_thread',
    'subscribe',
    'unlink_memory',
    'unsubscribe',
    'whats_new',
  ]);
});

Deno.test('create_thread passes snake_case args through', async () => {
  const { reg, calls } = setup();
  const r = await reg.create_thread.handler({
    scope: 's',
    title: 'T',
    body: 'hi',
    memory_ids: [M],
    session_label: 'asker',
  });
  assertEquals(calls.createThread, [['s', 'T', 'hi', [M], { sessionLabel: 'asker' }]]);
  assertEquals(json(r).thread.id, T);
});

Deno.test('post, resolve and read map session and options', async () => {
  const { reg, calls } = setup();
  const p = json(await reg.post.handler({ thread_id: T, body: 'b', session: S }));
  assertEquals(calls.post, [[T, 'b', { session: S }]]);
  assertEquals(p.threadId, T);
  await reg.resolve_thread.handler({ thread_id: T, note: 'done', session_label: 'x' });
  assertEquals(calls.setStatus[0], [T, 'resolved', 'done', { sessionLabel: 'x' }]);
  await reg.reopen_thread.handler({ thread_id: T });
  assertEquals(calls.setStatus[1], [T, 'open', undefined, {}]);
  await reg.read_thread.handler({ thread_id: T, limit: 5, after: 3, session: S });
  assertEquals(calls.readThread, [[T, { limit: 5, after: 3 }, { session: S }]]);
});

Deno.test('note appears only for created sessions', async () => {
  const fresh = setup({ created: true });
  const a = json(await fresh.reg.post.handler({ thread_id: T, body: 'b', session_label: 'x' }));
  assertEquals(a.note, SESSION_NOTE);
  const b = json(await fresh.reg.subscribe.handler({ thread_id: T, session_label: 'x' }));
  assertEquals(b.note, SESSION_NOTE);
  assertEquals(b.subscribed, T);
  const old = setup({ created: false });
  const c = json(await old.reg.post.handler({ thread_id: T, body: 'b', session_label: 'x' }));
  assert(!('note' in c));
  assert(!('note' in json(await old.reg.resolve_thread.handler({ thread_id: T, session_label: 'x' }))));
});

Deno.test('link, unlink, unsubscribe, list and whats_new shapes', async () => {
  const { reg } = setup();
  assertEquals(json(await reg.link_memory.handler({ thread_id: T, memory_id: M })), { linked: true });
  assertEquals(json(await reg.unlink_memory.handler({ thread_id: T, memory_id: M })), { unlinked: true });
  assertEquals(json(await reg.unsubscribe.handler({ thread_id: T, session: S })), { unsubscribed: true });
  assertEquals(json(await reg.list_threads.handler({ status: 'all' })).next, null);
  assertEquals(json(await reg.whats_new.handler({ session: S })).threads, []);
});

Deno.test('whats_new without session or label fails with Pass session or session_label', async () => {
  const { reg, calls } = setup();
  const r = await reg.whats_new.handler({});
  assertEquals(r.isError, true);
  assertEquals(r.content[0].text, 'Pass session or session_label');
  assertEquals(calls.whatsNew, undefined);
});

Deno.test('read_thread rejects before and after together', async () => {
  const { reg, calls } = setup();
  const r = await reg.read_thread.handler({ thread_id: T, before: 5, after: 2 });
  assertEquals(r.isError, true);
  assertStringIncludes(r.content[0].text, 'before or after');
  assertEquals(calls.readThread, undefined);
});

Deno.test('bad uuid ids return not found without calling the store', async () => {
  const { reg, calls } = setup();
  const r = await reg.post.handler({ thread_id: 'nope', body: 'b' });
  assertEquals(r.isError, true);
  assertEquals(r.content[0].text, 'Thread nope not found');
  const m = await reg.link_memory.handler({ thread_id: T, memory_id: 'bad' });
  assertEquals(m.content[0].text, 'Memory bad not found');
  const c = await reg.create_thread.handler({ scope: 's', title: 't', memory_ids: ['bad'] });
  assertEquals(c.content[0].text, 'Memory bad not found');
  const s = await reg.read_thread.handler({ thread_id: T, session: 'bad' });
  assertEquals(s.content[0].text, 'Session not found');
  assertEquals(calls, {});
});

Deno.test('StoreError text is returned verbatim with isError', async () => {
  const { reg } = setup({ fail: new StoreError('Thread is already resolved') });
  const r = await reg.resolve_thread.handler({ thread_id: T, session_label: 'x' });
  assertEquals(r.isError, true);
  assertEquals(r.content[0].text, 'Thread is already resolved');
});

Deno.test('descriptions explain sessions and when to call whats_new', () => {
  const { reg } = setup();
  assertStringIncludes(reg.post.description ?? '', 'A session is');
  assertStringIncludes(reg.whats_new.description ?? '', 'start of a session');
  assertStringIncludes(reg.whats_new.description ?? '', 'between steps');
});
