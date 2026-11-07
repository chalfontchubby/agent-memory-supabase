# agent-memory-supabase

Shared, hosted memory for AI agents, built on [Supabase](https://supabase.com/). An MCP server, run as a Supabase
Edge Function, gives agents persistent memory they can store into and search, from any machine or cloud session.

Memories live in **scopes** (named memory pools, such as `predbat-devs`). An admin grants each member read-only or
read-write access per scope, and Postgres row-level security enforces it. Several developers and their bots can
share one memory, and no one can read a scope they weren't granted.

## Tools

The server exposes eleven tools: `list_scopes`, `store`, `store_batch`, `search`, `recall`, `find_related`,
`list_recent`, `update`, `delete`, `stats` and `prune`. They match the original server, plus a `scope` argument on the
write tools. Search is hybrid (BM25 full-text plus `gte-small` vector similarity, fused with RRF) with temporal decay.
Delete and prune are soft; rows are purged after 30 days.

## Install

You need a Supabase project (the free tier works), **Supabase CLI 3.x** (the commands below use its flags; CI pins
3.0.0) and [Deno](https://deno.com/) 2.x.

```sh
supabase link --project-ref <project-ref>
supabase db push --remote
supabase functions deploy agent-memory --use-api
```

`db push` applies the migrations in `supabase/migrations/`, which create everything: the `agent_memory` schema, row
level security, the search functions and the daily clean-up job. In CLI 3, `db push` targets the local stack unless
you pass `--remote` (the linked project, or `--remote=<project-ref>`). `functions deploy` targets the linked project
(or `--remote=<project-ref>`), and `--use-api` means no Docker is needed to deploy.

The schema `agent_memory` must **not** be listed under Settings, API, Exposed schemas. Access goes only through the
Edge Function; `anon` and `authenticated` have no privileges on it.

### Temporal decay

Search scores decay with age, as in the original. The half-life in days is the function secret
`MEMORY_DECAY_HALF_LIFE` (default `30`):

```sh
supabase secrets set MEMORY_DECAY_HALF_LIFE=45
```

A value of `0` or less (or one that is not a number) disables decay. Then `prune` (and `stats.belowPruneThreshold`)
uses only the dormant rule: a memory that was never accessed and is older than `maxDormantDays` (default 90). The
original server instead treated every memory as a candidate when decay was off. Memories tagged `evergreen` or
`never-forget` are never pruned.

## Admin quick-start

The admin scripts connect to the database directly. Set `AGENT_MEMORY_DB_URL` to the session pooler connection string
(Connect in the dashboard, port 5432) and keep it out of version control. Percent-encode any special characters in the
password (for example `@` as `%40`, `/` as `%2F`, `#` as `%23`), or the URL will not parse.

```sh
export AGENT_MEMORY_DB_URL='postgresql://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres'

deno run -A scripts/admin.ts create-scope my-team --description "Team memory"
deno run -A scripts/admin.ts create-member alice --human alice@example.com
deno run -A scripts/admin.ts create-member ci-bot --bot
deno run -A scripts/admin.ts grant alice my-team write
deno run -A scripts/admin.ts grant ci-bot my-team read
deno run -A scripts/admin.ts issue-token alice laptop --expires 90d   # shown once
```

Other commands: `list-scopes`, `list-grants`, `list-tokens <member>`, `revoke <member> <scope>` and
`revoke-token <id>`. Tokens look like `amm_…` and only their SHA-256 hash is stored.

### Undo, and erasing for good

`delete` and `prune` are soft: a deleted memory stays restorable for 30 days, then the daily job purges it. A purge
removes the content from the memory's history as well, so only the fact that it existed remains.

```sh
# What has been deleted, by whom, and when (all filters optional)
deno run -A scripts/admin.ts list-deleted --scope my-team --by ci-bot --since 2026-11-01

# Restore by id (one or several)
deno run -A scripts/admin.ts restore <memory-id> <memory-id>

# Undo a bad bulk prune: without --yes this lists what it would restore and exits 1
deno run -A scripts/admin.ts restore --scope my-team --by ci-bot --since 2026-11-01
deno run -A scripts/admin.ts restore --scope my-team --by ci-bot --since 2026-11-01 --yes

# Erase a memory now (live or deleted), with its history content. Not reversible.
deno run -A scripts/admin.ts erase <memory-id>         # shows id, scope and first line, exits 1
deno run -A scripts/admin.ts erase <memory-id> --yes
```

`--by admin` matches deletions made directly in the database rather than by a member.

### Backup and restore

```sh
deno run -A scripts/backup.ts backup                       # the whole install: scopes, members, grants, memories
deno run -A scripts/backup.ts backup --scope my-team --out backup-my-team.json   # one scope
deno run -A scripts/backup.ts restore-backup backup-<timestamp>.json
```

`backup` exports the whole install by default; `--scope` limits it to one scope (and the members it references). The
file holds memory content: treat it as private. `restore-backup` loads only into an **empty** install (fresh
migrations, no scopes, members or memories) and keeps ids. Access tokens are never exported, so after a restore,
issue new tokens with `issue-token`.

### Import from a local agent-memory-mcp store

`scripts/import.ts` loads memories exported from a local LanceDB store, re-embedding each one through the function's
`/embed` endpoint. It is a dry run until you pass `--execute`.

```sh
# 1. Export the LanceDB store to JSON (Node 20+). The output is private: memories*.json is gitignored.
(cd scripts/lancedb-export && npm ci) && node scripts/lancedb-export/export.mjs <MEMORY_DB_PATH> > memories.json

# 2. Dry run: choose by tag, review the list, and write the selected ids to a file
deno run -A scripts/import.ts --file memories.json --include-tag repo:batpred --exclude-tag personal \
  --write-ids ids.txt

# 3. Edit ids.txt: delete any line you do not want shared (# starts a comment). Re-run the dry run with it
deno run -A scripts/import.ts --file memories.json --include-tag repo:batpred --exclude-tag personal --ids ids.txt

# 4. Import for real
export AGENT_MEMORY_DB_URL='postgresql://…'                                     # as for the admin CLI
export AGENT_MEMORY_URL=https://<project-ref>.supabase.co/functions/v1/agent-memory
export AGENT_MEMORY_TOKEN=amm_…                                                 # any valid token, used for /embed
deno run -A scripts/import.ts --file memories.json --include-tag repo:batpred --exclude-tag personal --ids ids.txt \
  --scope my-team --as alice --execute
```

A tag filter alone can let private memories through, so review the ids before `--execute`. Re-running is safe:
memories already present are skipped. Content over 20,000 characters is reported as failed and not imported.

`scripts/smoke.ts` is described under [Smoke test](#smoke-test).

## Connect an agent

```sh
claude mcp add --transport http predbat-memory \
  https://<project-ref>.supabase.co/functions/v1/agent-memory \
  --header "Authorization: Bearer amm_…"
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "predbat-memory": {
      "type": "http",
      "url": "https://<project-ref>.supabase.co/functions/v1/agent-memory",
      "headers": { "Authorization": "Bearer ${AGENT_MEMORY_TOKEN}" }
    }
  }
}
```

Keep the token in an environment variable, not in a committed file.

### Suggested CLAUDE.md wording

```markdown
## Shared memory
- Call `list_scopes` first to see which scopes you can use and whether each is read or write.
- Store durable findings into the team scope (`my-team`), not a personal one. Include why, not just what.
- Before storing, `search` for an existing memory on the topic. If there is one, `update` it; do not store a duplicate.
- Never store secrets, tokens or credentials.
```

## Smoke test

```sh
AGENT_MEMORY_URL=https://<project-ref>.supabase.co/functions/v1/agent-memory \
AGENT_MEMORY_TOKEN=amm_… \
  deno run -A scripts/smoke.ts --scope <scope-with-write-access>
```

It runs every tool once through the real endpoint, then three concurrent searches, prints `PASS` or `FAIL` per tool and
exits non-zero on any failure. It deletes what it stored.

## Development

```sh
supabase start                # local stack
deno task check               # fmt, lint, type-check
deno task test:unit
supabase test db              # pgTAP: schema, RLS, functions, search
deno task test:int            # against the local database
supabase functions serve agent-memory & deno task test:e2e   # needs the model download
```

CI (`.github/workflows/ci.yml`) runs everything except the end-to-end test.

## Known limits

- **Error 546 ("retry once").** Embedding runs inside the Edge Function, which has a CPU budget per worker. If a worker
  is busy and the platform recycles it, a request can fail with `546`/`WORKER_RESOURCE_LIMIT`. Retry once; the retry
  lands on a fresh worker. To stay inside the budget, `store_batch` accepts at most 2 memories and `recall` embeds at
  most 5 topics per call. Details are in the [spike results](docs/superpowers/specs/2026-11-07-embedding-spike-results.md).
- **Size limits.** A memory's content is at most 20,000 characters (`store`, `store_batch`, `update`, import), and
  every result `limit` (`search`, `find_related`, `list_recent`, `recall`) is between 1 and 100.
- **Free-tier pausing.** Free Supabase projects are paused after a period of inactivity. Unpause from the dashboard;
  the first request after that is slow.

## Credits

This project builds on the design and code of
[agent-memory-mcp](https://github.com/adamrdrew/agent-memory-mcp) by Adam Drew, via the
[chalfontchubby fork](https://github.com/chalfontchubby/agent-memory-mcp), which fixes upstream bugs that made the
memory forget records. It keeps their tool set, hybrid BM25 + vector search and temporal decay, and moves the store
from a local LanceDB folder to Supabase (Postgres, pgvector, full-text search) with scoped, shared access.

## License

GPL-3.0-or-later, as the original. See [LICENSE](LICENSE).
