# Supabase-hosted agent memory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hosted MCP memory server on Supabase — the agent-memory-mcp tool set plus scopes with per-member
read/write access enforced by Postgres RLS — with admin, import and backup scripts.

**Architecture:** One Edge Function (`agent-memory`) speaks stateless MCP over Streamable HTTP. It resolves a bearer
token to a member id, then runs every query inside a transaction that switches to the non-`BYPASSRLS` role
`agent_memory_member` with the member id in a transaction-local setting, so RLS enforces scope access. Everything
lives in the `agent_memory` schema, which is not exposed through the Data API. Search ranks in SQL (full-text +
pgvector, RRF); temporal decay is applied in TypeScript, ported from the original.

**Tech Stack:** Supabase (Postgres 17, pgvector ≥ 0.8, pg_cron, Edge Runtime with `gte-small`), Deno 2,
`npm:@modelcontextprotocol/server@^2` (`createMcpHandler`), `npm:zod@^4`, `npm:postgres@3.4.5`, pgTAP via
`supabase test db`, `jsr:@std/assert`, `jsr:@std/cli`. Node only for the LanceDB exporter
(`@lancedb/lancedb@^0.26.2`).

**Spec:** [docs/superpowers/specs/2026-11-07-supabase-agent-memory-design.md](../specs/2026-11-07-supabase-agent-memory-design.md)
and the spike that settles §7.8:
[docs/superpowers/specs/2026-11-07-embedding-spike-results.md](../specs/2026-11-07-embedding-spike-results.md).
Reference implementation of the original (tool schemas, decay maths, tests): `~/agent-memory-mcp`
(chalfontchubby fork) — `src/tools.ts`, `src/memory-store.ts`, `tests/temporal-decay.test.ts`.

## Global Constraints

- Public repo, GPL-3.0-or-later. **No secrets in the repo**: credentials only from env vars / the gitignored `.env`.
  No project ref, company, customer or personal names in committed files.
- **Every database change is a migration file in `supabase/migrations/`.** Applying the migrations in order to an
  empty database (`supabase db reset` locally, `supabase db push` remotely) must create the complete working
  database, cron job included. No SQL is ever applied by hand, through the dashboard or by a script, to create or
  change schema objects; a fix to an earlier migration that has been pushed is a new migration. Scripts only
  read and write rows.
- All database objects in schema `agent_memory`; **no triggers on `auth.users`**, no requirement that members exist
  in `auth.users`. Schema `agent_memory` is **never** added to `[api] schemas`; `anon` and `authenticated` get no
  privileges on it.
- Policies key on the member id from `agent_memory.current_member_id()`, never `auth.uid()`.
- Embeddings: `gte-small`, `vector(384)`, `mean_pool: true, normalize: true`, one embed per call for
  `store`/`update`/`search`. Embeds run **sequentially** (parallel inference saves no CPU — spike).
- CPU budget ≈ 1 s per request (spike): **`STORE_BATCH_MAX = 2`**, **`RECALL_EMBED_TOPICS_MAX = 5`**.
- Categories exactly the original 12: `code-solution, bug-fix, architecture, learning, tool-usage, debugging,
  performance, security, observation, personal, relationship, other`.
- Decay: half-life default 30 days from env `MEMORY_DECAY_HALF_LIFE` (≤ 0 or non-numeric disables); importance
  multiplier 1–3× (`(1 + min(access,20)/20) × (1.5 if <7 days since access, 1.2 if <30, else 1.0)`); tags
  `evergreen` / `never-forget` exempt; re-sort after decay. Access counted at most once per hour per memory.
- RRF k = 60; over-fetch `limit × 3` per arm; default `limit` 10; `recall` defaults `limit_per_topic` 5,
  `include_recent` 5; `find_related` default 5; `prune` defaults `dryRun: true`, `minStrength: 0.05`,
  `maxDormantDays: 90`.
- Tool names and argument shapes as the original (`~/agent-memory-mcp/src/tools.ts`), plus scope arguments (spec
  §7.3). Results are `{ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }`; failures add
  `isError: true`. Every returned memory carries `scope`, `createdBy`, `updatedBy` (display names).
- Errors never reveal a memory or scope the caller can't read: `Memory <id> not found` and
  `Scope '<name>' not found` read the same whether the thing is absent or unreadable.
- Token format `amm_` + 43-char base64url (32 random bytes); stored as lowercase hex SHA-256 only.
- Delete and prune are soft (`deleted_at`); soft-deleted rows are invisible to every tool; hard-deleted after
  30 days by pg_cron.
- Supabase CLI ≥ 2.117 (MCP guide requirement). Deploy with `--use-api` (no Docker needed for deploys).
- Scripts read the database URL from env `AGENT_MEMORY_DB_URL` (session pooler, port 5432). **Deviation from spec
  §7.5:** the admin/backup scripts use a direct DB connection, not the service-role key, because the schema is
  deliberately not exposed over the Data API. The credential still lives only in env.

## Review Focus

1. **Partial updates on a moved or tagged memory** — `update` with only `tags`, only `category` or only `scope` must
   keep content and embedding (anti-goal "silent data loss"). Test: Task 6 `update with only tags keeps content and
   embedding`.
2. **A query with no searchable words** (`"???"`, `"the"`, `""`) — `websearch_to_tsquery` yields an empty query.
   Expected: keyword mode returns `[]`, hybrid falls back to the semantic arm, no SQL error. Test: Task 4
   `hybrid with stop-word-only query still returns semantic hits`.
3. **A small scope inside a large table** — HNSW post-filtering can return fewer than `limit` rows when the caller's
   scopes are a small fraction of the table. Expected: a member who can read 15 of 1,000 rows still gets 10
   results. Test: Task 4 `small scope gets a full page from the vector arm`.
4. **Malformed ids and names** — `update`/`delete`/`find_related` with a non-uuid id, or a scope name with quotes
   or unicode. Expected: `Memory <id> not found` / `Scope '<name>' not found`, never a raw Postgres error.
   Test: Task 6 `non-uuid id reads as not found`.
5. **`scopes: []`** and an unreadable scope in `scopes` — `[]` means "all readable scopes" (same as omitted); a
   named unreadable scope is an error and returns no results at all. Test: Task 8
   `empty scopes array means all readable scopes`.

---

## File Structure

```
deno.json                                   tasks, fmt/lint config (repo root; scripts + tests)
supabase/config.toml                        local stack; [functions.agent-memory] verify_jwt = false
supabase/migrations/20261107120000_schema.sql      tables, indexes, extensions, role
supabase/migrations/20261107120100_rls.sql         identity helpers, policies, grants
supabase/migrations/20261107120200_functions.sql   tokens, access tracking, soft delete, history, purge cron
supabase/migrations/20261107120300_search.sql      memory_view, search_memories, related_memories
supabase/tests/database/0{1..4}_*.test.sql  pgTAP: schema, RLS, functions, search
supabase/functions/agent-memory/index.ts    Deno.serve: routing, bearer auth, MCP handler, /embed
supabase/functions/_shared/types.ts         categories, Memory, SearchResult, request shapes, Embedder, MemoryStore
supabase/functions/_shared/limits.ts        STORE_BATCH_MAX, RECALL_EMBED_TOPICS_MAX, defaults
supabase/functions/_shared/decay.ts         parseDecayHalfLife, computeDecayFactor, importanceMultiplier, applyDecay
supabase/functions/_shared/tokens.ts        generateToken, hashToken
supabase/functions/_shared/db.ts            connect, resolveMember, withMember
supabase/functions/_shared/pg-store.ts      PgMemoryStore implements MemoryStore
supabase/functions/_shared/tools.ts         handlers + registerTools(server, store)
supabase/functions/_shared/embedder.ts      GteSmallEmbedder (Supabase.ai)
tests/unit/*.test.ts                        decay, tokens, tools (mock store)
tests/integration/*.test.ts                 PgMemoryStore against the local stack
tests/helpers/{fake-embedder.ts,fixtures.ts}
tests/e2e/function.test.ts                  local `supabase functions serve` over real MCP
scripts/admin.ts  scripts/backup.ts  scripts/import.ts  scripts/smoke.ts  scripts/lib/admin-db.ts
scripts/lancedb-export/{package.json,export.mjs}
.github/workflows/ci.yml
README.md
```

---

### Task 1: Scaffold and schema

**Files:**
- Create: `deno.json`, `supabase/config.toml` (via `supabase init`, then edited),
  `supabase/migrations/20261107120000_schema.sql`, `supabase/tests/database/01_schema.test.sql`
- Modify: `.gitignore` (add `memories*.json`, `backup*.json`, `ids*.txt` — import/backup outputs never committed)

**Interfaces:**
- Produces tables (exact names; later tasks rely on them):
  - `agent_memory.scopes(id uuid pk default gen_random_uuid(), name text unique not null check (name ~ '^[a-z0-9][a-z0-9-]{0,62}$'), description text, created_at timestamptz default now())`
  - `agent_memory.members(id uuid pk, display_name text unique not null, kind text check in ('human','bot'), email text, auth_user_id uuid null, created_at)` — `auth_user_id` has **no** FK to `auth.users` (installable anywhere).
  - `agent_memory.scope_grants(scope_id fk, member_id fk, access text check in ('read','write'), granted_at, granted_by text, primary key (scope_id, member_id))`
  - `agent_memory.memories(id uuid pk default gen_random_uuid(), scope_id fk not null, content text not null, category text not null check in (12 categories), tags text[] not null default '{}', created_at, updated_at, created_by uuid fk members, updated_by uuid fk members, access_count int not null default 0, last_accessed_at timestamptz, deleted_at timestamptz, embedding extensions.vector(384) not null, fts tsvector generated always as (to_tsvector('english', content)) stored)`
  - `agent_memory.memory_history(id bigint identity pk, memory_id uuid not null (no FK — history outlives purge), action text check in ('insert','update','move','delete','restore','purge'), member_id uuid null, at timestamptz default now(), prev_content text, prev_category text, prev_tags text[], prev_scope_id uuid)`
  - `agent_memory.access_tokens(id uuid pk, member_id fk, name text, token_hash text unique not null, created_at, last_used_at, expires_at, revoked_at)`
  - Indexes: GIN on `fts`, GIN on `tags`, HNSW `embedding vector_cosine_ops`, btree `(scope_id, created_at desc) where deleted_at is null`, btree `deleted_at where deleted_at is not null`.
  - Role `agent_memory_member` (`nologin nobypassrls`), `grant agent_memory_member to postgres`.

- [ ] **Step 1:** Upgrade the CLI (`brew upgrade supabase`; check `supabase --version` ≥ 2.117), run `supabase init`,
  set `[functions.agent-memory] verify_jwt = false`, confirm `[api] schemas` does not list `agent_memory`.
- [ ] **Step 2:** Create `deno.json` with tasks: `check` (`deno fmt --check && deno lint && deno check supabase/functions/**/*.ts scripts/*.ts tests/**/*.ts`),
  `test:unit` (`deno test -A tests/unit`), `test:int` (`deno test -A tests/integration`), `test:e2e`
  (`deno test -A tests/e2e`), `test:db` (`supabase test db`). fmt `lineWidth: 120`, `singleQuote: true`.
- [ ] **Step 3: Write the failing test** `01_schema.test.sql` (pgTAP): `has_table` for all six tables;
  `has_extension('vector')`, `has_extension('pg_cron')`; `col_type_is('agent_memory','memories','embedding','extensions.vector(384)')`;
  `ok(not has_schema_privilege('anon','agent_memory','USAGE'))` and the same for `authenticated`;
  `ok(not (select rolbypassrls from pg_roles where rolname='agent_memory_member'))`;
  `throws_ok` inserting a memory with category `'nope'`; `throws_ok` creating scope `'Bad Name'`.
- [ ] **Step 4:** `supabase start && supabase test db` → FAIL (tables missing).
- [ ] **Step 5:** Write `20261107120000_schema.sql` (extensions `vector` in `extensions`, `pg_cron`; tables, indexes,
  role; `revoke all on schema agent_memory from public, anon, authenticated`).
- [ ] **Step 6:** `supabase db reset && supabase test db` → PASS.
- [ ] **Step 7:** Commit `feat: agent_memory schema and project scaffold`.

### Task 2: Member identity and RLS policies

**Files:**
- Create: `supabase/migrations/20261107120100_rls.sql`, `supabase/tests/database/02_rls.test.sql`

**Interfaces:**
- Consumes: Task 1 tables and role.
- Produces (all `stable`, `security definer`, `set search_path = ''`, executable by `agent_memory_member` only):
  - `agent_memory.current_member_id() returns uuid` — `nullif(current_setting('agent_memory.member_id', true), '')::uuid`
  - `agent_memory.can_read(p_scope uuid) returns boolean` — any grant for current member
  - `agent_memory.can_write(p_scope uuid) returns boolean` — `access = 'write'`
- Policies (RLS **enabled, not forced**, on every table — the admin scripts connect as the owning `postgres` role;
  members are never owners):
  - `memories`: select `can_read(scope_id) and deleted_at is null`; insert check `can_write(scope_id) and created_by = current_member_id()`;
    update using `can_write(scope_id) and deleted_at is null`, check `can_write(scope_id)`; **no delete policy**
    (deletes are soft, via Task 3 functions).
  - `scopes`: select `can_read(id)`. `scope_grants`: select `member_id = current_member_id()`. No write policies.
  - `members`, `access_tokens`, `memory_history`: no policies and no grants to `agent_memory_member`.
- Grants to `agent_memory_member`: `usage` on schema; `select, insert, update` on `memories`; `select` on `scopes`,
  `scope_grants`.

- [ ] **Step 1: Write the failing test** `02_rls.test.sql`. Fixture (as `postgres`): scopes `alpha`, `beta`;
  members `rw` (write on alpha), `ro` (read on alpha), `none` (no grants), `bw` (write on beta); one memory in each
  scope. Helper `select set_config('agent_memory.member_id', '<id>', true); set local role agent_memory_member;`
  per case, `reset role` between. Assertions:
  - `ro` sees 1 memory (alpha); `none` sees 0; `rw` sees 1; nobody sees beta's memory except `bw`.
  - `ro` insert into alpha → `throws_ok` 42501; `ro` update alpha memory → 0 rows (`is(…, 0)`).
  - `rw` insert into beta → 42501; `rw` update alpha memory's `scope_id` to beta → 42501 (`WITH CHECK`).
  - `bw` with write on beta and `rw` on alpha only: moving needs both — grant `rw` write on beta, move succeeds.
  - `rw` insert with `created_by` = another member → 42501.
  - Soft-deleted row (set `deleted_at` as postgres) invisible to `rw`.
  - `select count(*) from agent_memory.access_tokens` as member → `throws_ok` 42501; same for `members`,
    `memory_history`; insert into `scope_grants` → 42501.
  - With no member id set, `agent_memory_member` sees 0 memories.
  - `agent_memory_member` owns no table in `agent_memory` (`is(count(*) from pg_tables where schemaname='agent_memory' and tableowner='agent_memory_member', 0)`).
  - `anon`: `throws_ok` on `select from agent_memory.memories` (no schema usage).
- [ ] **Step 2:** `supabase test db` → FAIL.
- [ ] **Step 3:** Write `20261107120100_rls.sql`.
- [ ] **Step 4:** `supabase db reset && supabase test db` → PASS.
- [ ] **Step 5:** Commit `feat: member identity and scope RLS`.

### Task 3: Tokens, access tracking, soft delete, history, purge

**Files:**
- Create: `supabase/migrations/20261107120200_functions.sql`, `supabase/tests/database/03_functions.test.sql`

**Interfaces:**
- Produces:
  - `agent_memory.resolve_token(p_hash text) returns uuid` — security definer, executable by `postgres` only
    (revoke from public). Returns `member_id` when hash matches, `revoked_at is null`, `expires_at is null or > now()`;
    sets `last_used_at = now()` if older than 1 minute; else `null`.
  - `agent_memory.touch_accessed(p_ids uuid[]) returns void` — security definer, member-executable. Updates
    **only** `access_count = access_count + 1, last_accessed_at = now()` for ids where `can_read(scope_id)`,
    `deleted_at is null`, and `coalesce(last_accessed_at, updated_at) < now() - interval '1 hour'`.
  - `agent_memory.soft_delete(p_ids uuid[]) returns uuid[]` — security definer, member-executable; sets
    `deleted_at = now()` where `can_write(scope_id) and deleted_at is null`; returns the ids actually deleted.
  - `agent_memory.restore(p_id uuid) returns boolean` — postgres only; clears `deleted_at`.
  - `agent_memory.purge_tombstones() returns int` — hard-deletes `deleted_at < now() - interval '30 days'`.
  - pg_cron job `agent-memory-purge-tombstones`, `'17 3 * * *'`, `select agent_memory.purge_tombstones()`.
  - Trigger `memories_history` (after insert/update/delete, security definer) writes `memory_history` with
    `member_id = current_member_id()` (null for admin) and the **previous** content/category/tags/scope.
    Action: insert → `insert`; `deleted_at` null→set → `delete`; set→null → `restore`; `scope_id` changed → `move`;
    other content/category/tags change → `update`; hard delete → `purge`. **Updates touching only
    `access_count`/`last_accessed_at` write no history.**

- [ ] **Step 1: Write the failing test** `03_functions.test.sql`:
  - `resolve_token(sha256 of 'amm_x')` returns the member; revoked → null; expired → null; unknown → null.
  - As `ro`: `touch_accessed` on its readable memory → `access_count` 1; again immediately → still 1; on beta's memory
    → unchanged; content unchanged and **no** history row added.
  - As `ro`: `soft_delete` on alpha memory → returns `{}`; as `rw` → returns the id; row then invisible to `rw`;
    `restore` (as postgres) → visible again; history has `delete` then `restore` with `member_id` = `rw`, null.
  - As `rw`: update tags → history row `update` with previous tags; move → `move` with previous scope.
  - `purge_tombstones()` removes a row with `deleted_at = now() - interval '31 days'`, keeps one at 29 days.
  - `select count(*) from cron.job where jobname = 'agent-memory-purge-tombstones'` = 1.
  - As `agent_memory_member`, `resolve_token` and `restore` → `throws_ok` 42501.
- [ ] **Step 2:** `supabase test db` → FAIL.
- [ ] **Step 3:** Write `20261107120200_functions.sql`.
- [ ] **Step 4:** `supabase db reset && supabase test db` → PASS.
- [ ] **Step 5:** Commit `feat: tokens, access tracking, soft delete and history`.

### Task 4: Search in SQL

**Files:**
- Create: `supabase/migrations/20261107120300_search.sql`, `supabase/tests/database/04_search.test.sql`

**Interfaces:**
- Produces:
  - `agent_memory.member_name(p_id uuid) returns text` — security definer; display name (no member listing).
  - View `agent_memory.memory_view` (`security_invoker = true`): `id, scope_id, scope (name), content, category,
    tags, created_at, updated_at, created_by (name via member_name), updated_by (name), access_count,
    last_accessed_at` — live rows only via RLS. Granted `select` to `agent_memory_member`.
  - `agent_memory.search_memories(p_query text, p_embedding extensions.vector(384), p_mode text, p_scope_ids uuid[],
    p_category text, p_tags text[], p_after timestamptz, p_before timestamptz, p_limit int)
    returns table (<memory_view columns>, raw_score float8)` — `security invoker`, `stable`,
    `set hnsw.iterative_scan = relaxed_order`. Filters (scope ∈ `p_scope_ids`, category, tags overlap `&&`,
    created_at bounds) apply **inside** each arm before its limit. Arms fetch `p_limit * 3`.
    - `keyword`: `fts @@ websearch_to_tsquery('english', p_query)`, score `ts_rank_cd`.
    - `semantic`: order by `embedding <=> p_embedding`, score `1 / (1 + distance)` (original's formula).
    - `hybrid`: full outer join of both arms on id, score `Σ 1 / (60 + rank)`; returns up to `p_limit * 3` rows.
    `p_embedding` may be null only for `keyword`.
  - `agent_memory.related_memories(p_id uuid, p_scope_ids uuid[], p_limit int) returns table (<same>)` — nearest by
    the stored embedding of `p_id` (must itself be readable, else zero rows), excluding `p_id`, score `1/(1+distance)`.

- [ ] **Step 1: Write the failing test** `04_search.test.sql` with hand-built vectors (one-hot-ish 384-d arrays) as
  member `rw`:
  - keyword `'charge window'` ranks the memory containing both words first.
  - semantic returns the nearest vector first; hybrid includes a row found by only one arm.
  - Category, tags-overlap, after/before and `p_scope_ids` filters each exclude a matching-but-filtered row.
  - **Review Focus 2:** `hybrid with stop-word-only query still returns semantic hits` — query `'the'` returns rows;
    keyword with `'???'` returns 0 rows and no error.
  - **Review Focus 3:** `small scope gets a full page from the vector arm` — 1,000 rows in `beta` (generated as
    postgres), 15 in `alpha`; member with only `alpha` asks semantic `p_limit 10` → 10 rows.
  - Rows in `beta` never appear for an alpha-only member in any mode, even when `p_scope_ids` names beta's id.
  - `related_memories` on a beta id as an alpha-only member → 0 rows.
- [ ] **Step 2:** `supabase test db` → FAIL.
- [ ] **Step 3:** Write `20261107120300_search.sql`.
- [ ] **Step 4:** `supabase db reset && supabase test db` → PASS.
- [ ] **Step 5:** Commit `feat: hybrid search and related memories in SQL`.

### Task 5: Shared core — types, limits, decay, tokens

**Files:**
- Create: `supabase/functions/_shared/{types.ts,limits.ts,decay.ts,tokens.ts}`, `tests/unit/{decay.test.ts,tokens.test.ts}`

**Interfaces:**
- Produces:
  - `types.ts`: `MEMORY_CATEGORIES` (as original), `MemoryCategory`; `Memory { id, scope, content, category, tags,
    createdAt, updatedAt, createdBy, updatedBy }`; `SearchResult { memory: Memory; score: number }`;
    `ScopeInfo { scope: string; description: string | null; access: 'read' | 'write'; memoryCount: number }`;
    `StoreRequest { content; category; tags }`; `UpdateRequest { content?; category?; tags?; scope? }`;
    `SearchFilters { category?; tags?; after?; before?; limit?; scopes?: string[] }`; `SearchMode`;
    `MemoryStats` (original fields + `byScope: Record<string, number>`); `PruneOptions` (original + `scope: string`);
    `PruneResult` (original); `Embedder { embed(text: string): Promise<number[]>; embedMany(texts: string[]): Promise<number[][]> }`;
    `MemoryStore` (below, Task 6/7 implement it):
    ```ts
    listScopes(): Promise<ScopeInfo[]>
    store(scope: string, r: StoreRequest): Promise<Memory>
    storeBatch(scope: string, rs: StoreRequest[]): Promise<Memory[]>
    search(query: string, mode: SearchMode, f: SearchFilters, embedding?: number[] | null): Promise<SearchResult[]>
    findRelated(id: string, limit: number, scopes?: string[]): Promise<SearchResult[]>
    listRecent(limit: number, category?: MemoryCategory, scopes?: string[]): Promise<Memory[]>
    update(id: string, u: UpdateRequest): Promise<Memory>
    delete(id: string): Promise<void>
    stats(scopes?: string[]): Promise<MemoryStats>
    prune(o: PruneOptions): Promise<PruneResult>
    ```
    `search`'s optional `embedding` lets `recall` pass a precomputed vector (`null` = keyword-only).
  - `limits.ts`: `STORE_BATCH_MAX = 2`, `RECALL_EMBED_TOPICS_MAX = 5`, `DEFAULT_LIMIT = 10`,
    `OVER_FETCH_FACTOR = 3`, `RRF_K = 60` (documentation; SQL hard-codes 60), `ACCESS_TOUCH_INTERVAL_HOURS = 1`.
  - `decay.ts`: `parseDecayHalfLife(v: string | undefined): number`, `computeDecayFactor(updatedAt: string, halfLifeDays: number): number`,
    `importanceMultiplier(m: { accessCount: number; lastAccessedAt: string | null; updatedAt: string }): number`,
    `EVERGREEN_TAGS`, `isEvergreen(tags: string[]): boolean`,
    `applyDecay(rows: DecayInput[], limit: number, halfLifeDays: number): SearchResult[]` — multiplies `rawScore` by the
    decay factor (skip evergreen / disabled), sorts descending, slices to `limit`. `DecayInput = { memory: Memory; rawScore: number; accessCount: number; lastAccessedAt: string | null }`.
  - `tokens.ts`: `generateToken(): string` (`amm_` + base64url of 32 bytes from `crypto.getRandomValues`),
    `hashToken(token: string): Promise<string>` (hex SHA-256 via `crypto.subtle`), `looksLikeToken(s: string): boolean`
    (`/^amm_[A-Za-z0-9_-]{43}$/`).

- [ ] **Step 1: Write the failing tests.** Port `~/agent-memory-mcp/tests/temporal-decay.test.ts` to
  `tests/unit/decay.test.ts` (vitest → `Deno.test` + `@std/assert`; `importanceMultiplier` now takes the object form;
  every original case kept with its original expected value). Add `applyDecay` cases: evergreen row keeps raw score;
  an older higher-raw row is re-sorted below a fresh lower-raw row (raw 1.0 aged 90 days vs raw 0.5 fresh, half-life
  30 → fresh first); output length = `limit`. `tokens.test.ts`: `generateToken()` matches `looksLikeToken`; two calls
  differ; `hashToken('amm_x')` equals the known SHA-256 hex `'…'` (compute once with `printf amm_x | shasum -a 256`
  and paste); hash is 64 lowercase hex chars.
- [ ] **Step 2:** `deno task test:unit` → FAIL (modules missing).
- [ ] **Step 3:** Implement the four modules.
- [ ] **Step 4:** `deno task test:unit` → PASS; `deno task check` clean.
- [ ] **Step 5:** Commit `feat: shared types, decay maths and token helpers`.

### Task 6: DB access and PgMemoryStore — writes

**Files:**
- Create: `supabase/functions/_shared/db.ts`, `supabase/functions/_shared/pg-store.ts`,
  `tests/helpers/fake-embedder.ts`, `tests/helpers/fixtures.ts`, `tests/integration/pg-store-write.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  - `db.ts`: `type Sql = postgres.Sql`; `connect(url: string): Sql` (`postgres(url, { max: 3, prepare: false })`);
    `resolveMember(sql: Sql, token: string): Promise<string | null>` (rejects non-`looksLikeToken` without a query,
    else `select agent_memory.resolve_token(${await hashToken(token)})`);
    `withMember<T>(sql: Sql, memberId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T>` —
    `sql.begin`, then `set local role agent_memory_member`, then `select set_config('agent_memory.member_id', ${memberId}, true)`.
  - `pg-store.ts`: `class PgMemoryStore implements MemoryStore { constructor(sql: Sql, memberId: string, embedder: Embedder, halfLifeDays = parseDecayHalfLife(Deno.env.get('MEMORY_DECAY_HALF_LIFE'))) }`.
    This task implements `listScopes`, `store`, `storeBatch`, `update`, `delete`, `prune`.
  - `fake-embedder.ts`: `class FakeEmbedder implements Embedder` — deterministic: lowercase words hashed into 384
    buckets, L2-normalised; counts calls in `calls: number`.
  - `fixtures.ts`: `adminSql()` (local `postgresql://postgres:postgres@127.0.0.1:54322/postgres`),
    `makeWorld(sql)` → creates uniquely-suffixed scopes `alpha-<rand>`, `beta-<rand>` and members `rw`, `ro`, `none`,
    `bw` as in Task 2, returns their ids/names and a `cleanup()`.
- Behaviour pinned:
  - **Embed before writing**: compute every embedding before opening the transaction (a killed worker leaves nothing).
  - `store`: scope must be one the member can **write**; else `Scope '<name>' not found` if unreadable, or
    `No write access to scope '<name>'` if read-only. Returns the `Memory` read back from `memory_view`.
  - `storeBatch`: length > `STORE_BATCH_MAX` → throws
    `store_batch accepts at most 2 memories per call on this server; split the batch or call store for each memory.`
    before any embed. All-or-nothing in one transaction.
  - `update`: fields omitted stay untouched; embed only when `content` is given **and differs**; `scope` moves (needs
    write on both — pre-check gives `No write access to scope '<name>'`; RLS remains the enforcement). Not visible or
    non-uuid id → `Memory <id> not found`; visible but read-only → `No write access to scope '<scope>'`.
    Sets `updated_by`, `updated_at`.
  - `delete`: `soft_delete([id])`; empty result → same two errors as `update`.
  - `prune`: requires `scope` with write; candidates computed in TS exactly as the original
    (`~/agent-memory-mcp/src/memory-store.ts` `prune`: strength `0.5^(ageDays / (halfLife × importance))`,
    evergreen excluded, reasons text identical); `dryRun` default true; non-dry-run calls `soft_delete(ids)`.
  - `listScopes`: from `scope_grants` ⨝ `scopes` with live memory counts, sorted by name.
  - Map Postgres errors: `22P02` (bad uuid) → not found; `42501` → `No write access to scope '<name>'`. Never rethrow
    raw driver messages.

- [ ] **Step 1: Write the failing tests** `pg-store-write.test.ts` (`supabase start` already running):
  - `store` as `rw` into alpha returns `scope: alpha-…`, `createdBy: 'rw-…'`, 384-d embedding stored (check as admin).
  - `store` as `ro` → `No write access to scope 'alpha-…'`; into beta → `Scope 'beta-…' not found`.
  - `storeBatch` of 3 → the exact cap message and `embedder.calls === 0`; of 2 → both stored.
  - **Review Focus 1:** `update with only tags keeps content and embedding` — embedding before === after (admin
    read), content unchanged, `embedder.calls` unchanged; same for only `category`; only `scope` (rw given write on
    beta) moves it and keeps content.
  - `update` with same content → no re-embed; new content → one embed, `fts` finds the new words.
  - **Review Focus 4:** `non-uuid id reads as not found` — `update('not-a-uuid', {tags: []})` and `delete('x')` →
    `Memory not-a-uuid not found` / `Memory x not found`; `store('it''s-ünïcode', …)` → `Scope 'it''s-ünïcode' not found`.
  - Content with quotes, `%`, unicode and a 3,000-word body round-trips exactly.
  - `delete` as `ro` → `No write access…`; as `rw` → later reads miss it; as `none` → not found.
  - `prune` dry-run on a 200-day-old never-accessed memory lists it with reason `never accessed, 200 days old > 90`;
    evergreen-tagged old memory not listed; `dryRun: false` soft-deletes the candidates.
  - `listScopes` as `ro` → `[{ scope: 'alpha-…', access: 'read', memoryCount: n, description }]`.
- [ ] **Step 2:** `deno task test:int` → FAIL.
- [ ] **Step 3:** Implement `db.ts` and the write half of `pg-store.ts`.
- [ ] **Step 4:** `deno task test:int` → PASS.
- [ ] **Step 5:** Commit `feat: Postgres memory store — writes`.

### Task 7: PgMemoryStore — reads

**Files:**
- Modify: `supabase/functions/_shared/pg-store.ts`
- Create: `tests/integration/pg-store-read.test.ts`

**Interfaces:**
- Consumes: Task 4 SQL functions, Task 5 `applyDecay`, Task 6 class.
- Produces: `search`, `findRelated`, `listRecent`, `stats` on `PgMemoryStore`; private
  `resolveScopeIds(tx, names?: string[]): Promise<string[]>` — omitted or `[]` → all readable scope ids; any name not
  readable → throws `Scope '<name>' not found`.
- Behaviour pinned: `search` embeds the query unless `mode === 'keyword'` or an `embedding` arg is given (`null` forces
  keyword); calls `search_memories` with `limit × 3`, then `applyDecay(…, limit)`; then `touch_accessed(ids)` in the
  same transaction. `findRelated`: unknown/unreadable id → `Memory <id> not found`; uses `related_memories`, decays,
  touches. `listRecent`: `memory_view` ordered `created_at desc`. `stats`: original fields computed over readable
  (optionally named) scopes, plus `byScope`; `mostAccessed` top 5 with content truncated to the first 100 chars.

- [ ] **Step 1: Write the failing tests** `pg-store-read.test.ts`:
  - hybrid/keyword/semantic each find a stored memory by its words; filters (category, tags any-of, after/before,
    `scopes`) each exclude a non-matching memory.
  - Decay: two equally relevant memories, one with `updated_at` 90 days ago (set as admin) → fresh one first; the old
    one tagged `evergreen` → order by raw score.
  - `ro` can search alpha; `none` gets `[]`; naming beta as `rw` → `Scope 'beta-…' not found`.
  - Access tracking: search as `ro` bumps `access_count` to 1; a second search within the hour leaves it at 1;
    `updated_at` unchanged.
  - `findRelated` excludes the source memory, never returns beta rows for an alpha-only member, unreadable id →
    not found, no embed call (`embedder.calls` unchanged).
  - `stats` as `rw` counts only alpha, `byScope` = `{ 'alpha-…': n }`; as `none` → zeros.
  - Soft-deleted memories absent from search, findRelated, listRecent and stats.
- [ ] **Step 2:** `deno task test:int` → FAIL.
- [ ] **Step 3:** Implement the read methods.
- [ ] **Step 4:** `deno task test:int` → PASS.
- [ ] **Step 5:** Commit `feat: Postgres memory store — reads, decay and access tracking`.

### Task 8: MCP tools

**Files:**
- Create: `supabase/functions/_shared/tools.ts`, `tests/unit/tools.test.ts`

**Interfaces:**
- Consumes: `MemoryStore`, `Embedder`, limits.
- Produces: one handler factory per tool, as the original (`handleStore(store)`, …, plus `handleListScopes(store)`,
  and `handleRecall(store, embedder)`), and `registerTools(server: McpServer, store: MemoryStore, embedder: Embedder): void`
  using `server.registerTool(name, { description, inputSchema }, handler)` with zod v4.
- Schemas: copy names, descriptions and fields from `~/agent-memory-mcp/src/tools.ts`, then add:
  `list_scopes` `{}` — "List the memory scopes you can access, with your access level (read or write) and memory count.";
  `store`/`store_batch`: required `scope: z.string()`; `search`/`recall`/`find_related`/`list_recent`/`stats`:
  optional `scopes: z.array(z.string())` ("Scopes to search; default all you can read"); `update`: optional `scope`
  ("Move the memory to this scope (needs write on both)"); `prune`: required `scope`. `delete` description becomes
  "Delete a memory by ID (soft delete; an admin can restore it for 30 days)."
- `recall`: embeds the first `RECALL_EMBED_TOPICS_MAX` topics with `embedder.embedMany` (sequential), searches those
  hybrid with the precomputed vector, searches the rest keyword-only (`embedding: null`), returns
  `{ byTopic, recent, keywordOnlyTopics: string[] }` (`keywordOnlyTopics` omitted when empty).
- Error text keeps the original prefixes (`Failed to store memory: `, `Search failed: `, …) followed by the store's
  message.

- [ ] **Step 1: Write the failing tests** `tools.test.ts` with an in-memory mock `MemoryStore` and mock `Embedder`:
  - `handleStore` passes `scope` through and returns the memory JSON; a store error → `isError: true` and
    `Failed to store memory: …`.
  - `handleStoreBatch` with 3 memories → `isError`, text contains `at most 2`.
  - `handleRecall` with 7 topics → `embedMany` called once with the first 5; topics 6–7 searched with `embedding: null`;
    `keywordOnlyTopics` lists them; with 2 topics, no `keywordOnlyTopics` key.
  - **Review Focus 5:** `empty scopes array means all readable scopes` — `handleSearch({query, scopes: []})` calls
    `store.search` with `scopes: undefined`; same for `recall`, `list_recent`, `find_related`, `stats`.
  - `handleUpdate` with only `tags` calls `store.update(id, { tags })` — no `content`/`category`/`scope` keys present.
  - `registerTools` registers exactly 11 tools with the original 10 names plus `list_scopes`.
- [ ] **Step 2:** `deno task test:unit` → FAIL.
- [ ] **Step 3:** Implement `tools.ts`.
- [ ] **Step 4:** `deno task test:unit` → PASS.
- [ ] **Step 5:** Commit `feat: MCP tool handlers with scopes`.

### Task 9: Admin CLI

**Files:**
- Create: `scripts/lib/admin-db.ts`, `scripts/admin.ts`, `tests/integration/admin.test.ts`

**Interfaces:**
- Consumes: `tokens.ts`, schema.
- Produces: `scripts/lib/admin-db.ts` functions over a postgres-role connection (`AGENT_MEMORY_DB_URL`):
  `createScope(sql, name, description?)`, `listScopes(sql)`, `createMember(sql, name, { kind: 'human' | 'bot'; email?: string })`
  (links `auth_user_id` when `auth.users` has that email, else leaves null — read only, no writes to `auth`),
  `grant(sql, member, scope, access)` (upsert), `revoke(sql, member, scope)`, `listGrants(sql)`,
  `issueToken(sql, member, name, expires?: Date): Promise<string>` (returns the plaintext once, stores the hash),
  `listTokens(sql, member)` (never the hash), `revokeToken(sql, id)`, `restoreMemory(sql, id)`.
  Members and scopes are addressed by name. Unknown name → error naming it.
- CLI: `deno run -A scripts/admin.ts <command> …` with the commands in spec §7.5 (`--expires` as ISO date or `Nd`).
  `issue-token` prints the token and the line `Shown once — store it now; only its hash is kept.`

- [ ] **Step 1: Write the failing test** `admin.test.ts` against the local stack: create scope/member/grant; token
  resolves via `resolve_token(hash)`; `list-tokens` output contains no `amm_` and no hash; revoke → resolves to null;
  re-grant `read`→`write` upserts one row; `restoreMemory` brings back a soft-deleted memory; `create-member --human`
  with an email present in `auth.users` links it.
- [ ] **Step 2:** `deno task test:int` → FAIL.
- [ ] **Step 3:** Implement `admin-db.ts` and `admin.ts` (`jsr:@std/cli/parse-args`).
- [ ] **Step 4:** `deno task test:int` → PASS.
- [ ] **Step 5:** Commit `feat: admin CLI`.

### Task 10: Edge Function

**Files:**
- Create: `supabase/functions/agent-memory/index.ts`, `supabase/functions/_shared/embedder.ts`,
  `tests/e2e/function.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `embedder.ts`: `class GteSmallEmbedder implements Embedder` — module-level `new Supabase.ai.Session('gte-small')`
    (via `globalThis` to satisfy the type checker), `run(text, { mean_pool: true, normalize: true })`; `embedMany`
    sequential.
  - `index.ts`: module-level `sql = connect(Deno.env.get('SUPABASE_DB_URL')!)` and embedder (reused across requests
    on a worker). Per request: `Authorization: Bearer <token>` → `resolveMember`; missing/invalid → HTTP 401 JSON
    `{ "error": "invalid or missing token" }`. Then:
    - `POST …/agent-memory/embed` `{ text: string }` → `{ embedding: number[] }` (used by the importer; one embed).
    - Anything else → `createMcpHandler(() => { const s = new McpServer({ name: 'agent-memory-supabase', version }); registerTools(s, new PgMemoryStore(sql, memberId, embedder), embedder); return s; }).fetch(req)`.
  - Identity comes **only** from the token. No header, argument or path segment can name a member.

- [ ] **Step 1: Write the failing test** `tests/e2e/function.test.ts` (requires `supabase start` and
  `supabase functions serve agent-memory` in another shell; the test file's
  header says so). Setup issues tokens for `rw`/`ro`/`none` with Task 9's `scripts/lib/admin-db.ts` helpers. Use the MCP client from
  `npm:@modelcontextprotocol/client@^2` with Streamable HTTP and the bearer header:
  - `tools/list` returns 11 tools.
  - `store` → `search` → `update` (tags only) → `find_related` → `delete` round-trip as `rw`.
  - Spoof: `rw`'s token with an extra `X-Member-Id: <ro id>` header and a `member_id` tool argument still acts as `rw`
    (`createdBy` is `rw`).
  - No token / `amm_` garbage / revoked token → HTTP 401.
  - `ro` token: `store` → `isError` with `No write access`.
  - `/embed` returns a 384-length vector.
- [ ] **Step 2:** `deno task test:e2e` → FAIL.
- [ ] **Step 3:** Implement `embedder.ts` and `index.ts`.
- [ ] **Step 4:** `deno task test:e2e` → PASS. Also `deno task check`.
- [ ] **Step 5:** Commit `feat: agent-memory Edge Function`.

### Task 11: Backup and restore

**Files:**
- Create: `scripts/backup.ts`, `tests/integration/backup.test.ts`

**Interfaces:**
- Produces: `deno run -A scripts/backup.ts backup [--scope <name>] [--out <file>]` and
  `deno run -A scripts/backup.ts restore-backup <file>`. File format:
  `{ format: 'agent-memory-supabase-backup', version: 1, exportedAt, scopes: [{name, description, createdAt}],
  members: [{id, displayName, kind, email}], grants: [{scope, member, access, grantedAt, grantedBy}],
  memories: [{ id, content, category, tags, createdAt, updatedAt, scope, createdBy, updatedBy, accessCount,
  lastAccessedAt, deletedAt, embedding }] }` — the original hardcopy fields plus scope, tracking fields and the
  vector (so restoring needs no re-embedding). **Never** token hashes. Default `--out backup-<UTC timestamp>.json`.
- `restore-backup` refuses (exit 1, message `restore-backup needs an empty install`) unless `scopes`, `members` and
  `memories` are all empty; loads everything in one transaction with ids preserved; no history rows except one
  `insert` per memory with `member_id` null.

- [ ] **Step 1: Write the failing test** `backup.test.ts`: backup of a world with live + soft-deleted memories →
  file has both, `deletedAt` set on one, no `token_hash`/`amm_` anywhere in the JSON text; `--scope` limits memories
  and grants to that scope; after the backup, truncate `memories`, `memory_history`, `scope_grants`, `access_tokens`, `members`, `scopes`
  (as postgres, `cascade`), then restore → identical rows including embeddings; restore into a non-empty install refuses.
- [ ] **Step 2:** `deno task test:int` → FAIL.
- [ ] **Step 3:** Implement `backup.ts`.
- [ ] **Step 4:** `deno task test:int` → PASS.
- [ ] **Step 5:** Commit `feat: backup and restore-backup`.

### Task 12: LanceDB export and import

**Files:**
- Create: `scripts/lancedb-export/package.json`, `scripts/lancedb-export/export.mjs`, `scripts/import.ts`,
  `tests/integration/import.test.ts`, `tests/fixtures/export-sample.json`

**Interfaces:**
- `export.mjs` (Node ≥ 20, dependency `@lancedb/lancedb@^0.26.2`): `node export.mjs <MEMORY_DB_PATH> > memories.json`
  writes `[{ id, content, category, tags: string[], createdAt, updatedAt, accessCount, lastAccessedAt }]` from table
  `memories` (tags stored as JSON text in LanceDB — parse them; `accessCount` defaults 0). No vectors.
- `import.ts`: `deno run -A scripts/import.ts --file memories.json --scope <name> --as <member>
  [--include-tag t]… [--exclude-tag t]… [--ids ids.txt] [--write-ids out.txt] [--execute]`.
  - Selection = (no `--include-tag` **or** has any include tag) **and** has no exclude tag **and** (no `--ids` **or** id
    listed). Default is a dry run printing, per memory, `id | category | tags | first line (≤100 chars)`, then
    `selected N of M (excluded by tag: X, not in ids: Y)`. `--write-ids` writes the selected ids one per line so the
    maintainer can prune the list and pass it back with `--ids`.
  - `--execute`: per memory, sequentially: `POST <AGENT_MEMORY_URL>/embed` with `AGENT_MEMORY_TOKEN` (retry 546/503/
    network errors 5 times, backoff 1, 2, 4, 8, 16 s), then insert as postgres via `AGENT_MEMORY_DB_URL` preserving
    `id, created_at, updated_at, access_count, last_accessed_at, category, tags`, `created_by = updated_by = --as`;
    `on conflict (id) do nothing` → counted as `skipped (already present)`. Prints a final
    `imported A, skipped S, failed F` and exits non-zero if F > 0.

- [ ] **Step 1: Write the failing test** `import.test.ts` (selection logic is a pure exported function
  `selectMemories(all, opts)`; the execute path runs against the local stack with a stub `/embed` server on a random
  port that returns 546 twice then a vector): include/exclude/ids combinations from `export-sample.json`;
  dry run inserts nothing; execute preserves id/timestamps/access fields; a second execute skips everything; the
  546-twice stub still imports.
- [ ] **Step 2:** `deno task test:int` → FAIL.
- [ ] **Step 3:** Implement `export.mjs` and `import.ts`. Check `export.mjs` by hand against
  `~/agent-memory-db` (`node export.mjs ~/agent-memory-db | head -c 600`) — output stays local, never committed.
- [ ] **Step 4:** `deno task test:int` → PASS.
- [ ] **Step 5:** Commit `feat: LanceDB export and scoped import`.

### Task 13: CI, README, deploy and smoke test

**Files:**
- Create: `.github/workflows/ci.yml`, `scripts/smoke.ts`
- Modify: `README.md`

**Interfaces:**
- `ci.yml` on `pull_request` and `push` to `main`: `denoland/setup-deno@v2` (Deno 2.x), `supabase/setup-cli@v1`
  (≥ 2.117), `deno task check`, `deno task test:unit`, `supabase db start`, `supabase test db`,
  `deno task test:int`. E2E (needs the edge runtime and model download) stays a local/manual step.
- `smoke.ts`: `AGENT_MEMORY_URL=… AGENT_MEMORY_TOKEN=… deno run -A scripts/smoke.ts --scope <name>` runs every tool
  once through the real MCP endpoint (store into the scope with tag `smoke-test`, search, recall, find_related,
  list_recent, update, stats, prune dry-run, list_scopes, delete), then a burst of 3 concurrent `search` calls; prints
  one `PASS`/`FAIL` line per tool and exits non-zero on any failure. It deletes what it stored.
- README: install (link project, `supabase db push`, `supabase functions deploy agent-memory --use-api`), admin
  quick-start, the `claude mcp add --transport http predbat-memory https://<ref>.supabase.co/functions/v1/agent-memory
  --header "Authorization: Bearer amm_…"` line and `.mcp.json` equivalent, suggested CLAUDE.md wording (which scope
  to store into; `update` not duplicate; `list_scopes` first), the 546 note ("retry once; the platform recycled a
  busy worker"), the free-tier pause note, and the existing credits.

- [ ] **Step 1:** Write `ci.yml`; push the branch and confirm the workflow is green (`gh run watch`).
- [ ] **Step 2:** Deploy to the free project: `set -a; source .env; set +a; supabase link --project-ref
  $SUPABASE_PROJECT_REF -p $SUPABASE_DB_PASSWORD && supabase db push && supabase functions deploy agent-memory
  --project-ref $SUPABASE_PROJECT_REF --use-api`. Confirm in Settings → API that `agent_memory` is not an exposed
  schema.
- [ ] **Step 3:** With the admin CLI create scope `smoke`, a bot member `smoke-bot` with write on it, and a token;
  run `scripts/smoke.ts --scope smoke` → all `PASS`. Read the function logs (as in the spike) and record the CPU of a
  cold `tools/list` + `store` in the results doc if it exceeds 500 ms.
- [ ] **Step 4:** Update the README; commit `ci: lint, unit, RLS and integration tests` and
  `docs: install, connect and admin guide`.

---

## Rollout (after the tasks; each step needs a maintainer)

1. `admin.ts create-scope predbat-devs --description "PredBat open-source development memory"`.
2. Create the maintainers (`--human <email>`) and the open-source bot (`--bot`); `grant … predbat-devs write`; issue
   one token per member/machine and hand them over out of band.
3. Import: `node scripts/lancedb-export/export.mjs ~/agent-memory-db > memories.json`, dry run with
   `--include-tag repo:batpred --write-ids ids.txt`, **maintainer reviews and prunes `ids.txt`**, dry run again with
   `--ids ids.txt`, then `--execute`. `memories.json` and `ids.txt` are gitignored and deleted afterwards.
4. Switch the bot's MCP config; maintainers add `predbat-memory` alongside their local server.
5. Delete the smoke scope's memories and revoke the smoke token.
