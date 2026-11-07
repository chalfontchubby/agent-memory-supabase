# Final fix report: mcp-admin

No migrations touched; TypeScript and docs only.

## 1. Backup and restore keep admin state
- scripts/backup.ts: Backup member type gains optional `isAdmin` / `deactivatedAt`; export selects `is_admin` and
  `deactivated_at` (microsecond text via TS()); restore inserts `isAdmin ?? false` and `deactivatedAt ?? null`.
  Version stays 1, so old files load. The bot CHECK still applies. admin_log is not exported (README says so).
- Test: tests/integration/backup.test.ts: admin (`bk-root`) and deactivated (`bk-gone`, microsecond timestamp) members
  round-trip with identical rows; export JSON asserted; a version-1 file with the fields stripped restores as
  non-admin / active.
- `deno task test:int`: 68 passed, 0 failed.

## 2. Smoke accepts admin tokens
- scripts/smoke.ts (BASE_TOOLS, tools/list step): all 11 base names must be present; every other name must start with
  `admin_`; prints "saw base tools only" or "saw base + N admin tools". README Smoke section notes admin tools are not
  exercised.
- Local run with an admin token: "saw base + 12 admin tools (admin token)", ALL PASSED. (A first run hit a cold-embedder
  timeout in store_batch/find_related; the rerun with a warm function passed.)

## 3. README
(a) Tools: 11 plus 12 admin_ tools. (b) Quick start: setup makes you the first admin. (c) Install by hand: `set-admin <you> on`.
(d) Admins: `claude mcp add ... -s user` line and `configure-claude.ts` option. (e) Token privacy and no auto-allow of
`mcp__<server>__admin_*`. (f) Backup: admin flags/deactivation kept, admin log not. Also smoke note (item 2).

## 4. admin_create_member name validation
- supabase/functions/_shared/admin-tools.ts: `.min(1, MSG).regex(/^\S(.*\S)?$/, MSG)`, MSG = "Member names can't be
  blank or start or end with a space".
- Test: tests/unit/admin-tools.test.ts "admin_create_member rejects blank or padded names...": '', 'alice ', ' alice',
  '   ' rejected with the message; 'alice', 'a', 'alice smith' accepted.

## Commands
- `deno task check`: exit 0.
- `deno task test:unit`: 70 passed, 0 failed.
- `deno task test:int`: 68 passed, 0 failed.
- `supabase test db`: Files=7, Tests=260, Result: PASS.
- e2e: `supabase functions serve agent-memory` (log in scratchpad serve3.log), warm-up 401, `deno task test:e2e`: 1 passed.
  Note: two earlier serve starts failed to boot ("Unexpected eof" in admin-tools.ts) because the container saw a stale
  file size after the file was rewritten; restarting serve fixed it. Not a code problem.
- smoke.ts against local function with admin `smoke-final-admin` (local DB only): tokens smoke-final-tok and
  smoke-final-tok2 both revoked; member left in place (deactivation refused: last active admin in the local DB); scope `smoke-final-scope` left (holds soft-deleted rows).
  Serve stopped.
