import { z } from 'npm:zod@4.6.7';
import type { McpServer } from 'npm:@modelcontextprotocol/server@2.4.0';
import { StoreError } from './limits.ts';
import { isUuid, type PgThreadStore } from './thread-store.ts';
import { failure, success } from './tools.ts';
import type { SessionInfo, SessionRef } from './types.ts';

export const SESSION_NOTE =
  'New agent session. Keep this id and pass it as session on every later thread call and to whats_new. If you lose it, pass the same session_label to pick it up again.';

/** The public method set of PgThreadStore, so unit tests can pass a fake. */
export type ThreadStoreLike = Pick<
  PgThreadStore,
  | 'createThread'
  | 'post'
  | 'setStatus'
  | 'readThread'
  | 'listThreads'
  | 'link'
  | 'unlink'
  | 'subscribe'
  | 'unsubscribe'
  | 'whatsNew'
>;

const SESSION_HELP =
  'A session is your identity as one running agent: one conversation or job, even when several agents share a token. ' +
  'Pass session (the id returned to you) or a stable session_label of your choosing; a new label starts a new session. ' +
  "Other sessions' posts show as new to you, never your own.";

const sessionShape = {
  session: z.string().optional().describe('Your session id, returned by an earlier thread call'),
  session_label: z.string().optional().describe('A short stable name for your session (picks it up again if reused)'),
};

type SessionArgs = { session?: string; session_label?: string };

function sessionRef(a: SessionArgs): SessionRef {
  const s: SessionRef = {};
  if (a.session !== undefined) s.session = a.session;
  if (a.session_label !== undefined) s.sessionLabel = a.session_label;
  return s;
}

const withNote = (session: SessionInfo) => (session.created ? { note: SESSION_NOTE } : {});

/** Runs a handler body; the store's StoreError text is returned as is. */
async function guard(fn: () => Promise<unknown>) {
  try {
    return success(await fn());
  } catch (e) {
    return failure(e);
  }
}

function checkSession(a: SessionArgs): void {
  if (a.session !== undefined && !isUuid(a.session)) throw new StoreError('Session not found');
}
function checkThread(id: string): void {
  if (!isUuid(id)) throw new StoreError(`Thread ${id} not found`);
}
function checkMemory(id: string): void {
  if (!isUuid(id)) throw new StoreError(`Memory ${id} not found`);
}
function needSession(a: SessionArgs): void {
  if (a.session === undefined && a.session_label === undefined) throw new StoreError('Pass session or session_label');
}

export function registerThreadTools(server: McpServer, threads: ThreadStoreLike): void {
  server.registerTool('create_thread', {
    description:
      `Start a discussion thread in a scope, optionally with a first post and links to memories. Other agents and people with read access can read and answer it. ${SESSION_HELP}`,
    inputSchema: z.object({
      scope: z.string().describe('Scope to create the thread in (you need write access)'),
      title: z.string().describe('Thread title, 1-200 characters'),
      body: z.string().optional().describe('First post (optional)'),
      memory_ids: z.array(z.string()).optional().describe('Memories to link to the thread (at most 20)'),
      ...sessionShape,
    }),
  }, (a) =>
    guard(async () => {
      checkSession(a);
      const ids = a.memory_ids ?? [];
      for (const m of ids) checkMemory(m);
      const r = await threads.createThread(a.scope, a.title, a.body, ids, sessionRef(a));
      return { thread: r.thread, session: r.session, ...withNote(r.session) };
    }));

  server.registerTool('post', {
    description: `Add a post to a thread. ${SESSION_HELP}`,
    inputSchema: z.object({
      thread_id: z.string().describe('Thread id'),
      body: z.string().describe('Post text'),
      ...sessionShape,
    }),
  }, (a) =>
    guard(async () => {
      checkThread(a.thread_id);
      checkSession(a);
      const r = await threads.post(a.thread_id, a.body, sessionRef(a));
      return { threadId: a.thread_id, post: r.post, session: r.session, ...withNote(r.session) };
    }));

  server.registerTool('read_thread', {
    description:
      `Read a thread with its linked memories and posts. Given a session, it returns the posts you have not yet seen (marked new) and marks them seen; before or after (post seq numbers) pages instead and marks nothing. ${SESSION_HELP}`,
    inputSchema: z.object({
      thread_id: z.string().describe('Thread id'),
      limit: z.number().int().optional().describe('Max posts to return (default 20, 1-100)'),
      before: z.number().int().optional().describe('Page back: posts with a seq below this'),
      after: z.number().int().optional().describe('Page forward: posts with a seq above this'),
      ...sessionShape,
    }),
  }, (a) =>
    guard(async () => {
      checkThread(a.thread_id);
      checkSession(a);
      if (a.before !== undefined && a.after !== undefined) throw new StoreError('Pass before or after, not both');
      const o: { limit?: number; before?: number; after?: number } = {};
      if (a.limit !== undefined) o.limit = a.limit;
      if (a.before !== undefined) o.before = a.before;
      if (a.after !== undefined) o.after = a.after;
      return await threads.readThread(a.thread_id, o, sessionRef(a));
    }));

  server.registerTool('list_threads', {
    description: 'List threads in the scopes you can read, newest activity first. Default is open threads.',
    inputSchema: z.object({
      scopes: z.array(z.string()).optional().describe('Scopes to list; default all you can read'),
      status: z.enum(['open', 'resolved', 'all']).optional().describe('open (default), resolved or all'),
      limit: z.number().int().optional().describe('Max threads (default 20, 1-100)'),
      before: z.string().optional().describe('Cursor: the next value from the previous page'),
    }),
  }, (a) =>
    guard(async () => {
      const o: { scopes?: string[]; status?: 'open' | 'resolved' | 'all'; limit?: number; before?: string } = {};
      if (a.scopes && a.scopes.length > 0) o.scopes = a.scopes;
      if (a.status !== undefined) o.status = a.status;
      if (a.limit !== undefined) o.limit = a.limit;
      if (a.before !== undefined) o.before = a.before;
      const r = await threads.listThreads(o);
      return { threads: r.threads, next: r.next };
    }));

  for (
    const [name, status, verb] of [['resolve_thread', 'resolved', 'Resolve'], [
      'reopen_thread',
      'open',
      'Reopen',
    ]] as const
  ) {
    server.registerTool(name, {
      description: `${verb} a thread, with an optional closing note recorded as a post. ${SESSION_HELP}`,
      inputSchema: z.object({
        thread_id: z.string().describe('Thread id'),
        note: z.string().optional().describe('Note recorded with the change (optional)'),
        ...sessionShape,
      }),
    }, (a) =>
      guard(async () => {
        checkThread(a.thread_id);
        checkSession(a);
        const r = await threads.setStatus(a.thread_id, status, a.note, sessionRef(a));
        return { thread: r.thread, session: r.session, ...withNote(r.session) };
      }));
  }

  server.registerTool('link_memory', {
    description:
      "Link a memory to a thread. You need write access to the thread's scope and read access to the memory.",
    inputSchema: z.object({
      thread_id: z.string().describe('Thread id'),
      memory_id: z.string().describe('Memory id'),
    }),
  }, (a) =>
    guard(async () => {
      checkThread(a.thread_id);
      checkMemory(a.memory_id);
      await threads.link(a.thread_id, a.memory_id);
      return { linked: true };
    }));

  server.registerTool('unlink_memory', {
    description: 'Remove the link between a memory and a thread.',
    inputSchema: z.object({
      thread_id: z.string().describe('Thread id'),
      memory_id: z.string().describe('Memory id'),
    }),
  }, (a) =>
    guard(async () => {
      checkThread(a.thread_id);
      checkMemory(a.memory_id);
      return { unlinked: await threads.unlink(a.thread_id, a.memory_id) };
    }));

  server.registerTool('subscribe', {
    description: `Subscribe your session to a thread so whats_new reports its new posts. ${SESSION_HELP}`,
    inputSchema: z.object({ thread_id: z.string().describe('Thread id'), ...sessionShape }),
  }, (a) =>
    guard(async () => {
      checkThread(a.thread_id);
      checkSession(a);
      const r = await threads.subscribe(a.thread_id, sessionRef(a));
      return { subscribed: a.thread_id, session: r.session, ...withNote(r.session) };
    }));

  server.registerTool('unsubscribe', {
    description: 'Unsubscribe your session from a thread. Pass session or session_label.',
    inputSchema: z.object({ thread_id: z.string().describe('Thread id'), ...sessionShape }),
  }, (a) =>
    guard(async () => {
      needSession(a);
      checkThread(a.thread_id);
      checkSession(a);
      return { unsubscribed: await threads.unsubscribe(a.thread_id, sessionRef(a)) };
    }));

  server.registerTool('whats_new', {
    description:
      `List subscribed threads with posts you have not seen yet, newest first. Call it at the start of a session and between steps of long work. Pass session or session_label. ${SESSION_HELP}`,
    inputSchema: z.object({ ...sessionShape }),
  }, (a) =>
    guard(async () => {
      needSession(a);
      checkSession(a);
      const r = await threads.whatsNew(sessionRef(a));
      return { session: r.session, threads: r.threads };
    }));
}
