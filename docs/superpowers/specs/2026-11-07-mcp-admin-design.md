# Admin through the MCP — design

Date: 2026-11-07
Status: draft for approval (builder check done)
Builds on: [the hosted memory design](2026-11-07-supabase-agent-memory-design.md)

## 1. Intent

Today every admin task (creating scopes, members, grants and tokens) needs `scripts/admin.ts`. That means a machine with
Deno, the repo, and the database URL with its password. The maintainer wants admins to manage the memory from **any
Claude session**, such as a cloud session or another maintainer's laptop, using only their own MCP token. A shell is
needed once, to create the database. After that, onboarding a new maintainer (create member, grant, issue token) is
something an admin can ask Claude to do.

## 2. Decisions (the maintainer's)

- **Members can be admins.** An admin flag on the member, nothing finer: an admin manages the whole install.
- **The first admin comes from setup.** Creating the database is the one shell step. Its setup creates the first member and
  makes it an admin. For an install that already exists, one shell command makes a member admin.
- **Admins get admin tools through the MCP:**
  - create and delete scopes;
  - create and delete members;
  - grant and revoke access;
  - **issue tokens**, which are shown once in the tool's reply, plus listing and revoking tokens.
- **No token expiry by default** for now.
- **Making someone an admin is not possible through the MCP** for now. Promoting or demoting admins stays a shell step.
- **Admin tools never act on another admin.** Through the MCP an admin cannot:
  - deactivate another admin;
  - issue, list or revoke another admin's tokens;
  - grant or revoke another admin's access.

  Anything involving another admin is a shell step. An admin may act on themselves where it is safe: issue a token for
  a new machine, list and revoke their own tokens, grant themselves a scope. They may act on any non-admin member.
  This keeps one leaked admin token from shutting out the other admins or acting in their name.

## 3. Decisions made in the conversation (proposed by Claude, accepted)

- **Admin tools are only visible to admins.** A non-admin token, including the bot's, never sees them in `tools/list`.
  The server also enforces admin rights in the database, so hiding the tools is not the only guard.
- **"Delete member" means deactivate.** The member's tokens are revoked and their grants removed. The member row stays,
  so memories keep showing who wrote them. A deactivated member's tokens never authenticate again.
- **Deleting a scope that still holds memories is refused.** Live or soft-deleted, the memories must be gone first, by
  moving, deleting or erasing them. Its grants go with the scope.
- **An admin cannot deactivate themselves or remove their own admin rights through the MCP.** With the rule above, no
  MCP call can reduce the number of active admins. The last-admin protection therefore only applies to the shell
  `set-admin … off`, which refuses to demote the last active admin.
- **Every admin action is recorded:** who did it, when, what, and on which target. Token values are never recorded.

## 3a. Builder's calls (made by Claude while writing this up; the maintainer can overrule)

- **A bot can never be an admin.** This is a database rule: a check that only `human` members have the admin flag.
  `set-admin` refuses bots, and `setup.ts` makes its member admin only when it is a human. A `--bot` setup leaves the
  install without an admin until `set-admin` is run on a human member.
- **What `admin_log` records:** every call to the new admin functions, from the MCP or the shell, plus `set-admin`.
  `restore` and `erase` are not added, because `memory_history` already records them with the member who did it. The
  log is read from the shell with `admin.ts admin-log [--since …] [--actor …]`. There is no MCP tool for it.
- **Deactivation can be undone, from the shell only.** `admin.ts reactivate <member>` clears the deactivation. It
  restores no grants or tokens: those are granted and issued afresh. Display names stay unique, so a deactivated
  member's name is not reused.
- **An admin cannot revoke their own last live token through the MCP**, so they can't cut themselves off by accident.
  The shell can still do it.
- **Granting to, or issuing a token for, a deactivated member is refused.**

## 4. Goals

1. An admin can onboard a new member end to end through Claude, with no shell: create member, grant scopes, issue token.
2. An admin can offboard a member (deactivate) and tidy scopes through Claude.
3. A non-admin, including the bot, can do none of this, and cannot tell the admin tools exist. This must be proven by tests
   against real Postgres, as the original RLS tests are.
4. Nothing that works today changes for non-admins. The existing 11 tools and their behaviour are unchanged.

## 5. Non-goals

- Promoting or demoting admins through the MCP.
- Per-scope admins, or any role between member and admin.
- A web UI.
- Admin access to memory content beyond what grants give. An admin can grant themselves a scope, and that grant is the
  normal, recorded way to gain access.
- Restore, erase and backup through the MCP. They stay in the admin script.

## 6. Anti-goals (a failure even if it "works")

- **A non-admin performing any admin action**, through any path: a tool, a crafted request, or calling the database
  functions directly as the member role.
- **Privilege escalation through the MCP**, e.g. an admin tool that can set the admin flag, or a crafted argument that
  does.
- **Losing authorship.** Deleting a member must never delete or orphan their memories' `created_by`/`updated_by`.
- **Locking the install out.** No sequence of MCP admin calls may leave it with zero active admins.
- **Token hashes or other members' tokens readable through the MCP.** Listing tokens shows id, name and dates, never
  values or hashes.
- **The bot gaining admin.** Any bot member: the database refuses the admin flag on bots.
- **One admin acting on or as another admin through the MCP.** No deactivating them, no tokens issued in their name, no
  changing their grants.

## 7. Constraints

- **All schema changes are new migration files.** The existing migrations are already applied to the hosted project.
  Applying all migrations to an empty database must still build the complete working database.
- **Admin checks are enforced in Postgres**, in SECURITY DEFINER functions that check the calling member's admin flag,
  in the same style as `soft_delete`/`touch_accessed`. They must not rest on the Edge Function's tool registration alone.
- **The admin script keeps working** for everything it does today. It also gains the shell-only "make admin" step.
- **The CPU budget** (~1 s per request) applies. Admin calls do no embedding, so this is easy.
- Tool results follow the existing shape (`{ content: [{ type: 'text', text: JSON }] }`, `isError` on failure). Error
  messages for non-admins never reveal that admin tools exist.

## 8. Shape

### 8.1 Data

- `members.is_admin boolean not null default false` and `members.deactivated_at timestamptz` (null = active).
- A deactivated member's tokens fail `resolve_token`, even if a token row was somehow left unrevoked.
- `admin_log` table: id, `at`, actor member id, action (e.g. `create_scope`, `grant`, `issue_token`), target, and small
  JSON details. Never token values. Not readable by the member role.

### 8.2 The first admin

- **`setup.ts`** marks the human member it creates as admin, and also an existing human member it reuses. Re-running
  setup is how an install gets its first admin.
- **`admin.ts set-admin <member> on|off`** is the shell-only promote/demote. It refuses bots, and refuses to demote the
  last active admin.
- **`admin.ts reactivate <member>`** and **`admin.ts admin-log`** are shell-only too (see §3a).
- **The existing install:** run `set-admin treforsouthwell on` once.

### 8.3 MCP tools (admins only)

Names are prefixed `admin_` so they group together and are easy to deny wholesale in a client config:

| Tool | Does |
|------|------|
| `admin_list_scopes` | every scope, with description, memory counts, and member counts by access |
| `admin_create_scope` | name (same naming rule as today), optional description |
| `admin_delete_scope` | refused while the scope has any memory, live or soft-deleted; removes its grants |
| `admin_list_members` | display name, kind (human/bot), email if any, admin flag, active/deactivated, number of live tokens |
| `admin_create_member` | name, kind (human/bot), optional email (links a Supabase login as today) |
| `admin_deactivate_member` | revokes all tokens and removes all grants; refused for yourself and for the last active admin |
| `admin_list_grants` | optionally filtered by scope or member |
| `admin_grant` | member, scope, read/write (upsert, as today) |
| `admin_revoke` | member, scope |
| `admin_issue_token` | member, token name; returns the token **once**, with a note that it will not be shown again; no expiry |
| `admin_list_tokens` | for a member: id, name, created, last used, revoked; never values or hashes |
| `admin_revoke_token` | token id |

Member and scope arguments are by name, as in the admin script.

Every tool that names a member refuses when that member is an admin other than the caller, with a plain "is an
admin; manage admins from the shell" error. Every tool that names the caller refuses where §3 says so: deactivating
yourself, and revoking your last live token.

### 8.4 Where the logic lives

- The database exposes one SECURITY DEFINER function per action, executable by the member role. Each first checks that
  the calling member (`current_member_id()`) is an active admin, raises a fixed error otherwise, does the work, and
  writes `admin_log`.
- The admin script and the MCP tools both call these functions, so the rules exist once. For the admin script, the
  actor is recorded as the OS user, as `granted_by` is today. The builder decides how to share them.
- The Edge Function looks up the member's admin flag when it resolves the token, and registers the admin tools only
  for admins.

## 9. Testing

- **pgTAP, as each member kind** (admin, non-admin, bot, deactivated):
  - every admin function refuses non-admins;
  - nothing can set `is_admin` except the shell step, and never on a bot;
  - every admin function refuses to act on another admin;
  - last-admin, self-deactivation and last-own-token protections hold;
  - a deactivated member's token stops resolving;
  - deleting a non-empty scope is refused;
  - `admin_log` is written and not readable by members;
  - no token hash is readable.
- **Integration:** each admin tool against the local stack.
- **End to end over real MCP:** an admin token lists the admin tools and can onboard a member end to end, and the
  issued token works. A non-admin token's `tools/list` has no `admin_` tools, and calling one by name fails like an
  unknown tool.
- **Hosted:** after deploy, onboard and then deactivate a throwaway member through the MCP, and confirm the bot's token
  still sees no admin tools.

## 10. Left to the builder

- Exact column, function and table names, and the migration layout.
- How the admin script and the MCP share the database functions.
- The exact wording of tool descriptions and errors, within §7.
- Whether `admin_list_scopes` replaces anything in the admin script's output, if that keeps the two consistent.
