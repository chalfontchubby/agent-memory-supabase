import { parseArgs } from 'jsr:@std/cli@1.0.9/parse-args';
import { connect } from '../supabase/functions/_shared/db.ts';
import {
  createMember,
  createScope,
  grant,
  issueToken,
  listGrants,
  listScopes,
  listTokens,
  parseExpires,
  restoreMemory,
  revoke,
  revokeToken,
} from './lib/admin-db.ts';

const USAGE = `Usage: deno run -A scripts/admin.ts <command> ...
  create-scope <name> [--description <text>]
  list-scopes
  create-member <name> --human <email> | --bot
  grant <member> <scope> read|write
  revoke <member> <scope>
  list-grants
  issue-token <member> <name> [--expires <ISO date | Nd>]
  list-tokens <member>
  revoke-token <id>
  restore <memory-id>
Requires AGENT_MEMORY_DB_URL (direct or session-pooler connection string).`;

function table<T extends object>(rows: T[], cols: (keyof T & string)[]): string {
  if (rows.length === 0) return '(none)';
  const cell = (v: unknown) => v == null ? '-' : v instanceof Date ? v.toISOString() : String(v);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(w[i])).join('  ').trimEnd();
  return [line(cols), line(w.map((n) => '-'.repeat(n))), ...rows.map((r) => line(cols.map((c) => cell(r[c]))))]
    .join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    string: ['description', 'human', 'expires'],
    boolean: ['bot'],
  });
  const [cmd, ...p] = args._.map(String);
  if (!cmd) {
    console.log(USAGE);
    return;
  }
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
      case 'create-member': {
        need(1, 'create-member <name> --human <email> | --bot');
        if (!!args.human === args.bot) throw new Error('Specify exactly one of --human <email> or --bot');
        const m = await createMember(
          sql,
          p[0],
          args.bot ? { kind: 'bot' } : { kind: 'human', email: args.human },
        );
        console.log(
          `Created ${m.kind} member '${m.name}'` +
            (m.kind === 'human' ? (m.authUserId ? ' (linked to auth user)' : ' (no matching auth user)') : ''),
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
      case 'restore':
        need(1, 'restore <memory-id>');
        await restoreMemory(sql, p[0]);
        console.log(`Restored memory ${p[0]}`);
        break;
      default:
        throw new Error(`Unknown command '${cmd}'\n${USAGE}`);
    }
  } finally {
    await sql.end();
  }
}

try {
  await main();
} catch (e) {
  console.error(`Error: ${(e as Error).message}`);
  Deno.exit(1);
}
