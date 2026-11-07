import type postgres from 'npm:postgres@3.4.5';
import { type Sql, withMember } from './db.ts';
import { checkLimit, StoreError, THREAD_LINKS_MAX, THREAD_READ_DEFAULT } from './limits.ts';
import type {
  LinkedThread,
  SessionInfo,
  SessionRef,
  ThreadPost,
  ThreadStatus,
  ThreadSummary,
  ThreadView,
  WhatsNewItem,
} from './types.ts';

type Tx = postgres.TransactionSql;
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);

const iso = (v: Date | string): string => new Date(v).toISOString();

const notFoundThread = (id: string) => new StoreError(`Thread ${id} not found`);
const notFoundMemory = (id: string) => new StoreError(`Memory ${id} not found`);
const noSession = () => new StoreError('Session not found');
const needSession = () => new StoreError('Pass session or session_label');

const toSummary = (r: Row): ThreadSummary => ({
  id: r.id,
  scope: r.scope,
  title: r.title,
  status: r.status,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
  lastPostAt: iso(r.last_post_at),
  postCount: r.post_count,
  lastAuthor: r.last_author,
});

const toPost = (r: Row): ThreadPost => ({
  seq: r.seq,
  kind: r.kind,
  body: r.body,
  author: r.author,
  sessionLabel: r.session_label,
  createdAt: iso(r.created_at),
});

const toSession = (r: Row): SessionInfo => ({ id: r.id, label: r.label, created: r.created });

/** Threads, posts, links and subscriptions, called as the member. The database functions apply every rule. */
export class PgThreadStore {
  constructor(private readonly sql: Sql, private readonly memberId: string) {}

  /** Postgres rule texts (P0001) are user-safe and pass through; anything else is logged and hidden. */
  private async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await withMember(this.sql, this.memberId, fn);
    } catch (e) {
      if (e instanceof StoreError) throw e;
      const err = e as { code?: string; message?: string };
      if (err.code === 'P0001') throw new StoreError(err.message ?? 'Database error');
      console.error('database error', err.code, err.message);
      throw new StoreError('Database error');
    }
  }

  /** Resolves the caller's session; null when none was named and create is false. */
  private async session(tx: Tx, s: SessionRef, create: boolean): Promise<SessionInfo | null> {
    if (s.session !== undefined && !isUuid(s.session)) throw noSession();
    const rows = await tx<Row[]>`
      select * from agent_memory.resolve_session(
        ${s.session ?? null}::uuid, ${s.sessionLabel ?? null}::text, ${create})`;
    return rows[0] ? toSession(rows[0]) : null;
  }

  private async summary(tx: Tx, id: string): Promise<ThreadSummary> {
    const rows = await tx<Row[]>`select * from agent_memory.thread_view where id = ${id}::uuid`;
    if (!rows[0]) throw notFoundThread(id);
    return toSummary(rows[0]);
  }

  private async scopeIds(tx: Tx, names?: string[]): Promise<string[]> {
    if (!names || names.length === 0) {
      const rows = await tx<Row[]>`
        select scope_id as id from agent_memory.scope_grants where member_id = ${this.memberId}::uuid`;
      return rows.map((r) => r.id);
    }
    const unique = [...new Set(names)];
    const rows = await tx<Row[]>`
      select s.id, s.name from agent_memory.scopes s
      join agent_memory.scope_grants g on g.scope_id = s.id and g.member_id = ${this.memberId}::uuid
      where s.name = any(${unique}::text[])`;
    const found = new Set(rows.map((r) => r.name));
    for (const n of unique) if (!found.has(n)) throw new StoreError(`Scope '${n}' not found`);
    return rows.map((r) => r.id);
  }

  async createThread(
    scope: string,
    title: string,
    body: string | undefined,
    memoryIds: string[],
    s: SessionRef,
  ): Promise<{ thread: ThreadSummary; session: SessionInfo }> {
    if (memoryIds.length > THREAD_LINKS_MAX) throw new StoreError(`At most ${THREAD_LINKS_MAX} memory_ids`);
    for (const m of memoryIds) if (!isUuid(m)) throw notFoundMemory(m);
    return await this.run(async (tx) => {
      // Resolve the scope by name first so the SQL's uuid-bearing text never reaches a client.
      const rows = await tx<Row[]>`
        select s.id, g.access from agent_memory.scopes s
        join agent_memory.scope_grants g on g.scope_id = s.id and g.member_id = ${this.memberId}::uuid
        where s.name = ${scope}`;
      if (!rows[0]) throw new StoreError(`Scope '${scope}' not found`);
      if (rows[0].access !== 'write') throw new StoreError(`No write access to scope '${scope}'`);
      const session = (await this.session(tx, s, true))!;
      const [r] = await tx<Row[]>`
        select agent_memory.create_thread(
          ${rows[0].id}::uuid, ${title}::text, ${body ?? null}::text, ${memoryIds}::uuid[], ${session.id}::uuid) as id`;
      return { thread: await this.summary(tx, r.id), session };
    });
  }

  async post(threadId: string, body: string, s: SessionRef): Promise<{ post: ThreadPost; session: SessionInfo }> {
    if (!isUuid(threadId)) throw notFoundThread(threadId);
    return await this.run(async (tx) => {
      const session = (await this.session(tx, s, true))!;
      const [r] = await tx<Row[]>`
        select agent_memory.post_to_thread(${threadId}::uuid, ${body}::text, ${session.id}::uuid) as seq`;
      return { post: await this.postAt(tx, threadId, r.seq), session };
    });
  }

  async setStatus(
    threadId: string,
    status: ThreadStatus,
    note: string | undefined,
    s: SessionRef,
  ): Promise<{ thread: ThreadSummary; session: SessionInfo }> {
    if (!isUuid(threadId)) throw notFoundThread(threadId);
    return await this.run(async (tx) => {
      const session = (await this.session(tx, s, true))!;
      await tx`
        select agent_memory.set_thread_status(
          ${threadId}::uuid, ${status}::text, ${note ?? null}::text, ${session.id}::uuid)`;
      return { thread: await this.summary(tx, threadId), session };
    });
  }

  private async postAt(tx: Tx, threadId: string, seq: number): Promise<ThreadPost> {
    const rows = await tx<Row[]>`
      select * from agent_memory.thread_post_view where thread_id = ${threadId}::uuid and seq = ${seq}::int`;
    return toPost(rows[0]);
  }

  async readThread(
    threadId: string,
    o: { limit?: number; before?: number; after?: number },
    s: SessionRef,
  ): Promise<ThreadView> {
    if (!isUuid(threadId)) throw notFoundThread(threadId);
    const limit = o.limit ?? THREAD_READ_DEFAULT;
    checkLimit(limit);
    if (o.before !== undefined && o.after !== undefined) throw new StoreError('Pass before or after, not both');
    return await this.run(async (tx) => {
      const thread = await this.summary(tx, threadId);
      const session = await this.session(tx, s, false);
      const linkRows = await tx<Row[]>`
        select l.memory_id, m.scope, left(m.content, 200) as preview
        from agent_memory.thread_links l
        join agent_memory.memory_view m on m.id = l.memory_id
        where l.thread_id = ${threadId}::uuid
        order by l.linked_at, l.memory_id`;
      const links = linkRows.map((r) => ({ memoryId: r.memory_id, scope: r.scope, preview: r.preview }));

      let posts: ThreadPost[] | undefined;
      let moreUnread: boolean | undefined;
      if (session && o.before === undefined && o.after === undefined) {
        const sub = await tx<Row[]>`
          select last_seen_seq from agent_memory.thread_subscriptions
          where session_id = ${session.id}::uuid and thread_id = ${threadId}::uuid`;
        if (sub[0]) {
          const unreadFrom = (seq: number) =>
            tx<Row[]>`
              select 1 from agent_memory.thread_post_view
              where thread_id = ${threadId}::uuid and seq > ${seq}::int
                and session_id is distinct from ${session.id}::uuid limit 1`;
          // Catch-up applies only when someone else has posted past the marker.
          if ((await unreadFrom(sub[0].last_seen_seq)).length > 0) {
            const page = await tx<Row[]>`
              select * from agent_memory.thread_post_view
              where thread_id = ${threadId}::uuid and seq > ${sub[0].last_seen_seq}::int
              order by seq limit ${limit}`;
            const lastSeq: number = page[page.length - 1].seq;
            posts = page.map((r) => ({ ...toPost(r), new: r.session_id !== session.id }));
            moreUnread = (await unreadFrom(lastSeq)).length > 0;
            // Only ever the highest seq actually returned: mark_seen does not clamp.
            await tx`
              select agent_memory.mark_seen(${session.id}::uuid, ${threadId}::uuid, ${lastSeq}::int)`;
          }
        }
      }
      if (!posts) {
        let rows: Row[];
        if (o.after !== undefined) {
          rows = await tx<Row[]>`
            select * from agent_memory.thread_post_view
            where thread_id = ${threadId}::uuid and seq > ${o.after}::int order by seq limit ${limit}`;
        } else {
          rows = (await tx<Row[]>`
            select * from agent_memory.thread_post_view
            where thread_id = ${threadId}::uuid and (${o.before ?? null}::int is null or seq < ${o.before ?? null}::int)
            order by seq desc limit ${limit}`).reverse();
        }
        posts = rows.map(toPost);
      }
      const view: ThreadView = { thread, links, posts, hasOlder: posts.length > 0 && posts[0].seq > 1 };
      if (moreUnread !== undefined) view.moreUnread = moreUnread;
      if (session) view.session = session;
      return view;
    });
  }

  async listThreads(
    o: { scopes?: string[]; status?: ThreadStatus | 'all'; limit?: number; before?: string },
  ): Promise<{ threads: ThreadSummary[]; next: string | null }> {
    const limit = o.limit ?? 20;
    checkLimit(limit);
    const status = o.status ?? 'open';
    let cur: { ts: string; id: string } | null = null;
    if (o.before !== undefined) cur = decodeCursor(o.before);
    return await this.run(async (tx) => {
      const ids = await this.scopeIds(tx, o.scopes);
      if (ids.length === 0) return { threads: [], next: null };
      let rows: Row[];
      try {
        rows = await tx<Row[]>`
        select *, last_post_at::text as lp_text from agent_memory.thread_view
        where scope_id = any(${ids}::uuid[])
          and (${status}::text = 'all' or status = ${status}::text)
          and (${cur?.ts ?? null}::text is null
            or (last_post_at, id) < (${cur?.ts ?? null}::text::timestamptz, ${cur?.id ?? null}::uuid))
        order by last_post_at desc, id desc
        limit ${limit + 1}`;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === '22007' || code === '22008') throw new StoreError('Invalid cursor');
        throw e;
      }
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        threads: page.map(toSummary),
        next: rows.length > limit ? btoa(`${last.lp_text}|${last.id}`) : null,
      };
    });
  }

  async link(threadId: string, memoryId: string): Promise<void> {
    if (!isUuid(threadId)) throw notFoundThread(threadId);
    if (!isUuid(memoryId)) throw notFoundMemory(memoryId);
    return await this.run(async (tx) => {
      await tx`select agent_memory.link_memory(${threadId}::uuid, ${memoryId}::uuid)`;
    });
  }

  async unlink(threadId: string, memoryId: string): Promise<boolean> {
    if (!isUuid(threadId)) throw notFoundThread(threadId);
    if (!isUuid(memoryId)) throw notFoundMemory(memoryId);
    return await this.run(async (tx) => {
      const [r] = await tx<Row[]>`
        select agent_memory.unlink_memory(${threadId}::uuid, ${memoryId}::uuid) as removed`;
      return r.removed === true;
    });
  }

  async subscribe(threadId: string, s: SessionRef): Promise<{ session: SessionInfo }> {
    if (!isUuid(threadId)) throw notFoundThread(threadId);
    return await this.run(async (tx) => {
      const session = (await this.session(tx, s, true))!;
      await tx`select agent_memory.subscribe(${threadId}::uuid, ${session.id}::uuid)`;
      return { session };
    });
  }

  async unsubscribe(threadId: string, s: SessionRef): Promise<boolean> {
    if (s.session === undefined && s.sessionLabel === undefined) throw needSession();
    if (!isUuid(threadId)) throw notFoundThread(threadId);
    return await this.run(async (tx) => {
      const session = await this.session(tx, s, false);
      if (!session) throw needSession();
      const [r] = await tx<Row[]>`
        select agent_memory.unsubscribe(${threadId}::uuid, ${session.id}::uuid) as removed`;
      return r.removed === true;
    });
  }

  async whatsNew(s: SessionRef): Promise<{ session: SessionInfo; threads: WhatsNewItem[] }> {
    if (s.session === undefined && s.sessionLabel === undefined) throw needSession();
    return await this.run(async (tx) => {
      const session = await this.session(tx, s, false);
      if (!session) throw needSession();
      const rows = await tx<Row[]>`select * from agent_memory.whats_new(${session.id}::uuid)`;
      return {
        session,
        threads: rows.map((r) => ({
          threadId: r.thread_id,
          title: r.title,
          scope: r.scope,
          status: r.status,
          newPosts: r.new_posts,
          lastPostAt: iso(r.last_post_at),
          lastAuthor: r.last_author,
        })),
      };
    });
  }

  async linkedThreads(memoryIds: string[]): Promise<Record<string, LinkedThread[]>> {
    const ids = [...new Set(memoryIds.filter(isUuid))];
    if (ids.length === 0) return {};
    return await this.run(async (tx) => {
      const rows = await tx<Row[]>`
        select l.memory_id, t.id, t.title, t.scope, t.status, t.last_post_at
        from agent_memory.thread_links l
        join agent_memory.thread_view t on t.id = l.thread_id
        where l.memory_id = any(${ids}::uuid[])
        order by t.last_post_at desc, t.id desc`;
      const out: Record<string, LinkedThread[]> = {};
      for (const r of rows) {
        (out[r.memory_id] ??= []).push({
          id: r.id,
          title: r.title,
          scope: r.scope,
          status: r.status,
          lastPostAt: iso(r.last_post_at),
        });
      }
      return out;
    });
  }
}

const TS_RE = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(\.\d+)?([+-]\d\d(:?\d\d)?|Z)?$/;

function decodeCursor(c: string): { ts: string; id: string } {
  try {
    const [ts, id, ...rest] = atob(c).split('|');
    if (rest.length === 0 && TS_RE.test(ts ?? '') && isUuid(id)) return { ts, id };
  } catch { /* fall through */ }
  throw new StoreError('Invalid cursor');
}
