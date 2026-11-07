import { parseArgs } from 'jsr:@std/cli@1.0.9/parse-args';
import { connect } from '../supabase/functions/_shared/db.ts';
import {
  adminLog,
  createMember,
  createScope,
  deactivateMember,
  type DeletedFilter,
  type DeletedRow,
  deleteScope,
  deleteThread,
  eraseMemory,
  eraseThread,
  grant,
  issueToken,
  listDeleted,
  listGrants,
  listMembers,
  listScopes,
  listTokens,
  memorySummary,
  parseExpires,
  reactivateMember,
  restoreMemories,
  restoreThread,
  revoke,
  revokeToken,
  setAdmin,
  threadSummary,
} from './lib/admin-db.ts';

const USAGE = `Usage: deno run -A scripts/admin.ts <command> ...
  create-scope <name> [--description <text>]
  list-scopes
  delete-scope <name>                (refused while any memory, live or deleted, remains)
  create-member <name> [--email <address>] | --bot   (email optional; links a Supabase login)
  list-members
  deactivate <member>                (revokes tokens and grants, drops admin)
  reactivate <member>                (not admin again until set-admin)
  set-admin <member> on|off
  admin-log [--since <ISO date | Nd>] [--actor <name>] [--limit N]   (default limit 50)
  grant <member> <scope> read|write
  revoke <member> <scope>
  list-grants
  issue-token <member> <name> [--expires <ISO date | Nd>]
  list-tokens <member>
  revoke-token <id>
  list-deleted [--scope <s>] [--by <member|admin>] [--since <ISO date>]
  restore <memory-id>...
  restore [--scope <s>] [--by <member|admin>] [--since <ISO date>] --yes
  erase <memory-id> --yes            (hard delete now, with its history content; not reversible)
  delete-thread <thread-id>          (soft delete; recoverable for 30 days)
  restore-thread <thread-id>
  erase-thread <thread-id> --yes     (hard delete now, with its posts; not reversible)
Without --yes, filtered restore and erase only show what they would do, and exit 1.
Requires AGENT_MEMORY_DB_URL (direct or session-pooler connection string).`;

function table<T extends object>(rows: T[], cols: (keyof T & string)[]): string {
  if (rows.length === 0) return '(none)';
  const cell = (v: unknown) => v == null ? '-' : v instanceof Date ? v.toISOString() : String(v);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(w[i])).join('  ').trimEnd();
  return [line(cols), line(w.map((n) => '-'.repeat(n))), ...rows.map((r) => line(cols.map((c) => cell(r[c]))))]
    .join('\n');
}

const DELETED_COLS: (keyof DeletedRow & string)[] = ['id', 'scope', 'deletedAt', 'deletedBy', 'firstLine'];

/** Returns the process exit code. */
async function main(): Promise<number> {
  const args = parseArgs(Deno.args, {
    string: ['description', 'human', 'email', 'expires', 'scope', 'by', 'since', 'actor', 'limit'],
    boolean: ['bot', 'yes'],
  });
  const [cmd, ...p] = args._.map(String);
  if (!cmd) {
    console.log(USAGE);
    return 0;
  }
  const filter: DeletedFilter = { scope: args.scope, by: args.by, since: args.since };
  const hasFilter = args.scope !== undefined || args.by !== undefined || args.since !== undefined;
  const need = (n: number, usage: string) => {
    if (p.length !== n) throw new Error(`Usage: ${usage}`);
  };
  const url = Deno.env.get('AGENT_MEMORY_DB_URL');
  if (!url) {
    throw new Error('AGENT_MEMORY_DB_URL is not set. Export the database connection string and retry.');
  }
  const sql = connect(url);
  try {
    switch (cmd) {
      case 'create-scope': {
        need(1, 'create-scope <name> [--description <text>]');
        const s = await createScope(sql, p[0], args.description);
        console.log(`Created scope '${s.name}'`);
        break;
      }
      case 'list-scopes':
        console.log(table(await listScopes(sql), ['name', 'description']));
        break;
      case 'delete-scope':
        need(1, 'delete-scope <name>');
        await deleteScope(sql, p[0]);
        console.log(`Deleted scope '${p[0]}'`);
        break;
      case 'list-members':
        need(0, 'list-members');
        console.log(table(await listMembers(sql), ['name', 'kind', 'email', 'is_admin', 'deactivated', 'live_tokens']));
        break;
      case 'deactivate':
        need(1, 'deactivate <member>');
        await deactivateMember(sql, p[0]);
        console.log(`Deactivated '${p[0]}': tokens revoked, grants removed, admin dropped`);
        break;
      case 'reactivate':
        need(1, 'reactivate <member>');
        await reactivateMember(sql, p[0]);
        console.log(`Reactivated '${p[0]}' (no grants or tokens restored; run set-admin to make them an admin)`);
        break;
      case 'set-admin': {
        const usage = 'set-admin <member> on|off';
        need(2, usage);
        if (p[1] !== 'on' && p[1] !== 'off') throw new Error(`Usage: ${usage}`);
        await setAdmin(sql, p[0], p[1] === 'on');
        console.log(`'${p[0]}' is ${p[1] === 'on' ? 'now' : 'no longer'} an admin`);
        break;
      }
      case 'admin-log': {
        need(0, 'admin-log [--since <ISO date | Nd>] [--actor <name>] [--limit N]');
        let limit = 50;
        if (args.limit !== undefined) {
          if (!/^\d+$/.test(args.limit) || Number(args.limit) < 1) {
            throw new Error(`Invalid --limit '${args.limit}': use a positive whole number`);
          }
          limit = Number(args.limit);
        }
        let since: Date | undefined;
        if (args.since !== undefined) {
          const days = /^(\d+)d$/.exec(args.since);
          const d = new Date(args.since);
          if (days) since = new Date(Date.now() - Number(days[1]) * 86_400_000);
          else if (/^\d{4}-\d{2}-\d{2}/.test(args.since) && !isNaN(d.getTime())) since = d;
          else throw new Error(`Invalid --since '${args.since}': use an ISO date or a number of days (7d)`);
        }
        const rows = await adminLog(sql, { since, actor: args.actor, limit });
        console.log(table(rows.map((r) => ({ ...r, details: JSON.stringify(r.details) })), [
          'at',
          'actor',
          'action',
          'target',
          'details',
        ]));
        break;
      }
      case 'create-member': {
        need(1, 'create-member <name> [--email <address>] | --bot');
        // --human <email> is the older spelling of --email and still works.
        const email = args.email || args.human || undefined;
        if (args.bot && email) throw new Error('A bot member has no email: give --bot or --email, not both');
        const m = await createMember(sql, p[0], args.bot ? { kind: 'bot' } : { kind: 'human', email });
        console.log(
          `Created ${m.kind} member '${m.name}'` +
            (m.kind === 'human'
              ? (m.authUserId ? ' (linked to auth user)' : email ? ' (no matching auth user)' : ' (no email)')
              : ''),
        );
        break;
      }
      case 'grant': {
        need(3, 'grant <member> <scope> read|write');
        await grant(sql, p[0], p[1], p[2] as 'read' | 'write');
        console.log(`Granted ${p[2]} on '${p[1]}' to '${p[0]}'`);
        break;
      }
      case 'revoke': {
        need(2, 'revoke <member> <scope>');
        console.log(
          (await revoke(sql, p[0], p[1])) ? `Revoked '${p[0]}' from '${p[1]}'` : `'${p[0]}' had no grant on '${p[1]}'`,
        );
        break;
      }
      case 'list-grants':
        console.log(table(await listGrants(sql), ['scope', 'member', 'access', 'grantedBy', 'grantedAt']));
        break;
      case 'issue-token': {
        need(2, 'issue-token <member> <name> [--expires <ISO date | Nd>]');
        const token = await issueToken(sql, p[0], p[1], args.expires ? parseExpires(args.expires) : undefined);
        console.log(token);
        console.log('Shown once — store it now; only its hash is kept.');
        break;
      }
      case 'list-tokens':
        need(1, 'list-tokens <member>');
        console.log(
          table(await listTokens(sql, p[0]), ['id', 'name', 'createdAt', 'lastUsedAt', 'expiresAt', 'revokedAt']),
        );
        break;
      case 'revoke-token':
        need(1, 'revoke-token <id>');
        await revokeToken(sql, p[0]);
        console.log(`Revoked token ${p[0]}`);
        break;
      case 'list-deleted':
        need(0, 'list-deleted [--scope <s>] [--by <member|admin>] [--since <ISO date>]');
        console.log(table(await listDeleted(sql, filter), DELETED_COLS));
        break;
      case 'restore': {
        const usage = 'restore <memory-id>... | restore [--scope <s>] [--by <member|admin>] [--since <ISO date>] --yes';
        if (p.length > 0 && hasFilter) throw new Error(`Give memory ids or filters, not both. Usage: ${usage}`);
        let ids = p;
        if (p.length === 0) {
          if (!hasFilter) throw new Error(`Usage: ${usage}`);
          const rows = await listDeleted(sql, filter);
          if (!args.yes) {
            console.log(table(rows, DELETED_COLS));
            console.log(`Would restore ${rows.length} memories. Re-run with --yes to restore them.`);
            return 1;
          }
          ids = rows.map((r) => r.id);
        }
        const { restored, missing } = await restoreMemories(sql, ids);
        console.log(`Restored ${restored.length} ${restored.length === 1 ? 'memory' : 'memories'}`);
        if (missing.length > 0) {
          console.error(`Not found or not deleted: ${missing.join(', ')}`);
          return 1;
        }
        break;
      }
      case 'erase': {
        need(1, 'erase <memory-id> --yes');
        const m = await memorySummary(sql, p[0]);
        if (!m) throw new Error(`Memory ${p[0]} not found`);
        if (!args.yes) {
          console.log(`Would erase memory ${m.id}${m.deletedAt ? ' (soft-deleted)' : ''}`);
          console.log(`  scope: ${m.scope}`);
          console.log(`  first line: ${m.firstLine}`);
          console.log('This cannot be undone. Re-run with --yes to erase it.');
          return 1;
        }
        await eraseMemory(sql, m.id);
        console.log(`Erased memory ${m.id}`);
        break;
      }
      case 'delete-thread':
        need(1, 'delete-thread <thread-id>');
        await deleteThread(sql, p[0]);
        console.log(`Deleted thread ${p[0]} (restore-thread brings it back for 30 days)`);
        break;
      case 'restore-thread':
        need(1, 'restore-thread <thread-id>');
        await restoreThread(sql, p[0]);
        console.log(`Restored thread ${p[0]}`);
        break;
      case 'erase-thread': {
        need(1, 'erase-thread <thread-id> --yes');
        const t = await threadSummary(sql, p[0]);
        if (!t) throw new Error(`Thread ${p[0]} not found`);
        if (!args.yes) {
          console.log(`Would erase thread ${t.id}${t.deletedAt ? ' (soft-deleted)' : ''}`);
          console.log(`  scope: ${t.scope}`);
          console.log(`  title: ${t.title}`);
          console.log('This cannot be undone. Re-run with --yes to erase it.');
          return 1;
        }
        await eraseThread(sql, t.id);
        console.log(`Erased thread ${t.id}`);
        break;
      }
      default:
        throw new Error(`Unknown command '${cmd}'\n${USAGE}`);
    }
  } finally {
    await sql.end();
  }
  return 0;
}

let code: number;
try {
  code = await main();
} catch (e) {
  console.error(`Error: ${(e as Error).message}`);
  code = 1;
}
if (code !== 0) Deno.exit(code);
