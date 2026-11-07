# Discussion threads — design

Date: 2026-11-07
Status: approved (builder check done)
Builds on: [the hosted memory design](2026-11-07-supabase-agent-memory-design.md) and
[admin through the MCP](2026-11-07-mcp-admin-design.md)

## 1. Intent

Memories hold settled facts, and an agent replaces one when the facts change. Some work is a conversation, not a fact:

- One window starts debugging an issue. Another agent, in another window or as a bot, needs to see how far it got
  and add what it has found.
- An agent asks a question and stops. Some time later another agent or a human answers it, and the agent that asked,
  or whichever agent picks the work up next, has to find that answer.

Updating a memory loses what came before, and it doesn't tell anyone that something changed. A **thread** is an
append-only discussion in a scope. Agents and humans post to it, see who wrote each post, and poll to find out what is
new on the threads they follow.

## 2. Decisions (the maintainer's)

- **A thread lives in a scope and follows the memory rules.** If you can read the scope, you can read its threads. If
  you can write to it, you can open threads and post.
- **A thread has a title and is either open or resolved.**
- **A thread can be linked to one or more memories.**
- **Every post records who wrote it.** The author comes from the token, as it does for memories.
- **The MCP tools cover:** creating a thread, posting, listing open threads newest first, and reading a thread with a
  post limit and paging.
- **`recall` lists the threads linked to the memories it returns.** In v1 that means explicitly linked threads only.
  Finding threads by topic is a later feature.
- **Subscriptions and a "what's new" poll.** An agent subscribes to threads and polls for those with new posts. Nothing
  is pushed.
- **Agent sessions are held by the agent, not by the transport.** Two agents can share one token, so per-member state
  isn't enough. Subscribing hands back a session ID. The agent keeps it in its context and passes it to later calls,
  or passes in one it already has. The poll is keyed by the session.
- **Writes record the session.** Posting on a thread, and storing or updating a memory, record the session ID next to
  the member.

## 3. Proposed by Claude in the conversation, accepted

- **Posts are append-only.** They can't be edited or deleted one by one.
- **Anyone who can write to the scope can resolve or reopen a thread.** Resolving takes an optional note, which is
  stored as the thread's last post, so the outcome is the last thing a reader sees.
- **Links can be added and removed after the thread is created.** The root-cause memory is often written halfway
  through.
- **Your own session's posts are not "new" to you.** Another session's posts are new, even when it's the same member.
- **A session belongs to the member that created it.** If any other member passes that ID, it's treated as unknown,
  with the same "not found" text whether the ID exists or not. A session ID is a handle, not a credential. Identity
  still comes only from the token.
- **Session IDs are optional everywhere except the poll.** Without one, a write is attributed to the member alone, as
  it is today.
- **Sessions can carry a label**, like `inverter-debug`, which is shown next to the member name, e.g. `alice ·
  inverter-debug`. The label is something the agent says about itself and never stands in for identity.
- **Recovering a session by label.** If the conversation is summarised and the ID drops out, an agent that still
  remembers its label can pass the label and pick up that member's existing session with that label.
- **Links can cross scopes, but only readable memories show.** A thread in scope A can link a memory in scope B. Each
  reader sees only the links to memories they can read, so a link never reveals that a hidden memory exists.
- **Admins can delete a thread.** It's a soft delete with the same 30-day window as memories, after which it's purged.
- **Posts have the same size limit as memory content.**
- **Threads are included in backup and restore.**
- **The MCP transport's own `Mcp-Session-Id` is not used.** The server stays stateless, and the agent-held session
  replaces it.

## 4. Builder's calls (Claude's, made while writing this up; the maintainer can overrule)

- **Writing to a thread subscribes the session that wrote.** `create_thread`, `post`, `resolve_thread`,
  `reopen_thread` and `subscribe` subscribe the session they use, whether they created it or it was passed in. A
  session that asks a question is therefore always signed up for the answer.
- **Which tools create a session.** Only those five, the thread-writing tools, create a session. They create one
  when given neither `session` nor `session_label`, and return its ID with a reminder to pass it next time. `store`,
  `store_batch`, `update`, `read_thread`, `unsubscribe` and `whats_new` never create one. Given a label that doesn't
  match, they fail with "Session not found". Without that, a mistyped label in `whats_new` would quietly create an
  empty session and report "nothing new".
- **`session_label` is "find or create" only in the thread-writing tools.** If it names an existing session of the
  caller's, that session is used. Otherwise a thread-writing tool creates a session with that label. Labels are
  unique per member.
- **When both `session` and `session_label` are given:**
  - If the session has no label yet, the label is attached to it, so a session that started unlabelled can be
    recovered by label later. That fails if another of the member's sessions already has the label.
  - If the session has a different label, the call is an error.
- **Where a new subscription's marker starts.** It starts at the thread's current `seq` when the subscription is
  created, whether that's by `subscribe` or as a side effect of a write. Anything already there was readable when
  the session joined, and everything after it counts as new.
  - Posting never moves an existing subscription's marker. Only catch-up reading does. The session's own posts are
    left out of its unread count by `session_id`, not by moving the marker, so a post from another session that
    lands between two of yours is never skipped.
  - Reading a thread doesn't subscribe you to it.
- **Resolving an already-resolved thread, or reopening an open one,** is refused with "Thread is already
  resolved/open" and writes no post.
- **Ordering uses a per-thread sequence number, not a global ID or a timestamp.** Each post takes `seq =
  post_count + 1` while holding a row lock on the thread. Posts to one thread are therefore serialised, gapless and
  numbered in commit order. A "seen up to `seq` N" marker can't skip a post that was committed late. A global
  identity column could skip one under concurrent posting.
- **Resolving and reopening are posts too**, of kind `resolve` and `reopen`. The status change shows up in the poll
  and in the history with no extra mechanism. A resolve with no note is still a post, with empty text.
- **What `read_thread` returns:**
  - With a session, and no `before` or `after`, it catches up. It returns that session's unread posts oldest first,
    up to `limit`, with `more_unread: true` if more remain, and moves the session's marker to the last post returned.
    If there's nothing unread, it returns the latest `limit` posts.
  - Without a session, it returns the latest `limit` posts in time order.
  - `before: <seq>` pages back to older posts and `after: <seq>` pages forward.
  - Only the catch-up case moves the marker, and the marker never moves backwards.
  - Default `limit` is 20, maximum `MAX_LIMIT` (100).
- **Subscribing to an existing thread sets the marker to the thread's current `seq`.** From then on the session hears
  about new posts. The earlier history is still readable with `read_thread`. When a session creates a thread, it
  starts at the opening post.
- **`list_threads` orders by `last_post_at` descending**, defaults to `status: open`, and pages by a `before` cursor
  (a `(last_post_at, id)` pair, encoded as an opaque string).
- **The session goes on the memory row and on each history row.** The new columns are `memories.created_session`,
  `memories.updated_session` and `memory_history.session_id`, all null for existing rows. Where memory results
  already show `createdBy` and `updatedBy`, they also show the session label.
- **Deleting a scope** is refused while it still holds threads, live or soft-deleted, as it is for memories.
- **Purging a memory** removes its links (FK cascade). While a memory is soft-deleted its links are hidden, because
  readers can't see the memory.
- **Title limit:** 1–200 characters after trimming.
- **No embeddings for threads in v1.** Threads cost no extra CPU, and full-text search over threads is a later
  feature.
- **No `list_sessions` tool and no session clean-up in v1.** Recovering by label covers the lost-ID case. Sessions
  are small rows.
- **Memory writes check that the session is the caller's.** This sits in the database: an RLS `with check` that
  `created_session`/`updated_session` belong to `current_member_id()`. The TypeScript layer doesn't enforce it.
- **`read_thread` returns the thread's readable links** as `{ memoryId, scope, preview }`, where `preview` is the
  first 200 characters of the memory.
- **A backup limited to some scopes** (`--scope`) includes the threads in those scopes and their posts. It includes
  the sessions those posts and subscriptions refer to, and only the links whose memory is in the backup too.

## 5. Goals

1. Two agents on the same issue can hand findings to each other through a thread. That still works when they share
   a token.
2. An agent that asked a question learns there's an answer on its next `whats_new`, including after it has been
   restarted, provided it still has its session ID or label.
3. `recall` surfaces the live discussion next to the facts.
4. Threads obey scope grants exactly as memories do, proven by pgTAP tests against real Postgres in the same way as
   the existing RLS tests.
5. Nothing that works today changes. The existing tools keep their behaviour, and the new parameters are optional.

## 6. Non-goals

- Finding threads by topic, by embedding or by full-text search. That's a later feature.
- Pushing notifications to agents. Webhooks and Slack are out.
- Editing or deleting single posts.
- Moving a thread to another scope.
- Reactions, mentions, assignees and per-post status.
- A web UI.
- Using the MCP transport's `Mcp-Session-Id`.

## 7. Anti-goals (would make this a failure even if it works)

- A post or link that reveals that a memory, thread or session exists to someone who can't read it.
- A session ID that lets anyone act as, or read as, another member.
- A poll that silently misses a post, for example one committed out of order or made by another session of the same
  member.
- Threads that push a request over the ~1 s CPU budget.

## 8. Data model (new migration, `supabase/migrations/2026110718xxxx_threads.sql`)

Never edit an existing migration. The new one has to build from empty with `supabase db reset`.

```
agent_sessions   id uuid pk, member_id → members, label text null, created_at, last_seen_at
                 unique (member_id, label) where label is not null
threads          id uuid pk, scope_id → scopes, title text, status open|resolved,
                 created_by → members, created_session → agent_sessions null,
                 created_at, last_post_at, post_count int, resolved_at, resolved_by, deleted_at
thread_posts     id bigint identity pk, thread_id → threads (cascade), seq int, kind post|resolve|reopen,
                 body text, author_id → members, session_id → agent_sessions null, created_at
                 unique (thread_id, seq)
thread_links     thread_id → threads (cascade), memory_id → memories (cascade), linked_by, linked_at
                 pk (thread_id, memory_id)
thread_subscriptions  session_id → agent_sessions (cascade), thread_id → threads (cascade),
                 last_seen_seq int, subscribed_at;  pk (session_id, thread_id)
memories         + created_session, updated_session → agent_sessions null
memory_history   + session_id null (no FK, as with member_id)
```

Indexes: `threads (scope_id, status, last_post_at desc) where deleted_at is null`, plus `thread_links (memory_id)` for
the recall join.

**Where the rules live.** As in the rest of the system, the rules are in Postgres:

- **RLS select policies.** A thread, its posts and its links are visible when `can_read(thread.scope_id)` holds and
  the thread isn't deleted. A link is visible only when its memory is readable as well. A session or subscription is
  visible only to its own member.
- **Every write is a SECURITY DEFINER function** with `search_path = ''`, fully qualified names, and execute revoked
  from public and granted to `agent_memory_member`. Each one checks `can_write`/`can_read` and session ownership
  itself. The functions are `create_thread`, `post_to_thread` (lock the thread, bump `post_count`, insert the post,
  set `last_post_at`), `set_thread_status`, `link_memory`, `unlink_memory`, `resolve_session` (find or create by ID
  or label), `subscribe`, `unsubscribe`, `mark_seen` and `whats_new`. Members get no direct insert or update grants
  on the new tables.
- **Admin deletion follows the two layers from the admin design.** `adm_delete_thread` is postgres-only and writes
  `admin_log`. `admin_delete_thread` is member-callable, calls `require_admin()` first and then the core function.
  Tombstone purge extends the existing nightly job, so threads soft-deleted more than 30 days ago are hard-deleted
  and their posts cascade.

## 9. MCP tools (added to `registerTools`, so every member sees them)

| Tool | Arguments | Needs |
|------|-----------|-------|
| `create_thread` | `scope`, `title`, `body?` (first post), `memory_ids?`, `session?`, `session_label?` | write |
| `post` | `thread_id`, `body`, `session?`, `session_label?` | write |
| `read_thread` | `thread_id`, `limit?`, `before?`, `after?`, `session?`, `session_label?` | read |
| `list_threads` | `scopes?`, `status?` (`open`/`resolved`/`all`), `limit?`, `before?` | read |
| `resolve_thread` | `thread_id`, `note?`, `session?`, `session_label?` | write |
| `reopen_thread` | `thread_id`, `note?`, `session?`, `session_label?` | write |
| `link_memory` / `unlink_memory` | `thread_id`, `memory_id` | write on the thread's scope; read on the memory |
| `subscribe` / `unsubscribe` | `thread_id`, `session?`, `session_label?` | read |
| `whats_new` | `session` or `session_label` | — |

Plus `admin_delete_thread(thread_id)` in `registerAdminTools`.

**Changes to existing tools:**

- `store`, `store_batch` and `update` accept an optional `session` or `session_label`.
- In `recall` results, each memory carries `threads: [{ id, title, scope, status, lastPostAt }]`. The list holds the
  readable, non-deleted threads linked to that memory, and is fetched in one query for all the returned memory IDs.

**Responses:**

- Every thread tool that used a session returns `session: { id, label }`. The memory tools (`store`, `store_batch`,
  `update`) instead report the session as `createdSession`/`updatedSession` labels and don't echo the session id.
- A post renders as `{ seq, kind, body, author, sessionLabel, createdAt, new? }`.
- `whats_new` returns `[{ threadId, title, scope, status, newPosts, lastPostAt, lastAuthor }]`, newest first, and
  updates `last_seen_at` on the session.

**Errors** are `StoreError` text, safe to show as is. "Thread not found", "Memory not found" and "Session not found"
read the same whether the thing is absent or just unreadable.

**Limits** go in `_shared/limits.ts`: `THREAD_TITLE_MAX = 200` and `THREAD_READ_DEFAULT = 20`. Bodies use
`MAX_CONTENT_CHARS`. The maximum number of `memory_ids` on create is the builder's choice; 20 would do.

## 10. Scripts

- **`backup.ts` and restore** carry sessions, threads, posts, links and subscriptions, keep IDs and `seq`, and bind
  timestamps as text (`::text::timestamptz`).
- **`admin.ts`** gets `delete-thread`, plus the existing restore and erase commands extended to threads.
- **`smoke.ts`** creates a thread, posts to it, reads it, polls `whats_new`, resolves the thread, then deletes it with
  an admin token.
- **The LanceDB importer** is unchanged.

## 11. Tests

- **pgTAP:**
  - Visibility of every new table is checked for a read member, a write member, an outsider and a deactivated member.
  - Cross-scope links are hidden from members who can't read the memory.
  - A session passed by a non-owner is refused with the same text as a missing one.
  - Posting serialises `seq` with no gaps.
  - Every write function refuses read-only members.
  - Scope deletion is refused while threads exist.
  - Purge removes threads and posts.
- **Integration:**
  - Two sessions of one member each see the other's posts as new and never their own.
  - Catch-up reading advances the marker, and paging back doesn't move it.
  - Resolve and reopen show up in `whats_new`.
  - `recall` lists only linked threads that the caller can read.
  - Writing a memory records the session.
  - Backup and restore round-trip with no data lost.
- **Unit:** tool argument validation and the session-argument precedence rules.
- **E2E:** two MCP clients on one token hold a question-and-answer exchange through a thread.

## 12. Rollout

The migration only adds things: new tables plus nullable columns on `memories` and `memory_history`. Existing rows
aren't rewritten beyond adding the null columns. Hosted rollout follows the repo rules:

1. Take a backup.
2. Run `supabase db push --remote --dry-run`.
3. Push the migration, with the user's consent for that run.
4. Deploy the function, also with consent.
5. Run `smoke.ts` against the hosted project.

## 13. Left to the builder

- Exact column names, function signatures and the cursor encoding.
- How the tool descriptions explain sessions to an agent. They should say plainly: "keep this ID and pass it back".
- The post render format beyond the fields listed above.
- Whether `last_seen_at` on sessions is updated on every call or throttled, as `touch_accessed` is.
