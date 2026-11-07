// Registers the hosted memory server with Claude Code.
//   deno run -A scripts/configure-claude.ts [--name shared-memory] [--url ..] [--token ..] [--scope user|project]
// url and token default to AGENT_MEMORY_URL / AGENT_MEMORY_TOKEN in the env file (--env-file, default .env).
import { parseArgs } from 'jsr:@std/cli@1.0.9/parse-args';
import { readEnvFile } from './lib/env-file.ts';
import { defaultRun, redact, type Runner } from './lib/run.ts';

export interface ConfigureOptions {
  name?: string;
  url: string;
  token: string;
  scope?: 'user' | 'project' | 'local';
  /** Required to register at project scope, which writes the token into a committed .mcp.json. */
  yes?: boolean;
  run?: Runner;
  log?: (line: string) => void;
}

/** Returns the exit code. Never prints the token. */
export async function configureClaude(o: ConfigureOptions): Promise<number> {
  const name = o.name ?? 'shared-memory';
  const scope = o.scope ?? 'user';
  const run = o.run ?? defaultRun;
  const log = o.log ?? ((l: string) => console.log(l));
  if (scope === 'project') {
    log(
      'Warning: project scope writes .mcp.json, which is normally committed, so the token would end up in git. ' +
        'Prefer --scope user.',
    );
    if (!o.yes) throw new Error('Refusing project scope without --yes');
  }
  const addArgs = [
    'mcp',
    'add',
    '--transport',
    'http',
    name,
    o.url,
    '--header',
    `Authorization: Bearer ${o.token}`,
    '-s',
    scope,
  ];
  try {
    // Ignore the result: the server may not be registered yet.
    await run('claude', ['mcp', 'remove', name, '-s', scope]);
    const r = await run('claude', addArgs);
    if (r.code !== 0) {
      log(`claude mcp add failed (exit ${r.code}): ${redact(r.stderr || r.stdout, [o.token]).trim()}`);
      return 1;
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    log('The claude command is not on PATH. Once it is installed, run:');
    log(
      `  claude mcp add --transport http ${name} ${o.url} --header "Authorization: Bearer $AGENT_MEMORY_TOKEN" -s ${scope}`,
    );
    return 1;
  }
  log(`Registered '${name}' with Claude Code (scope: ${scope}). Restart Claude Code to pick it up.`);
  return 0;
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ['name', 'url', 'token', 'scope', 'env-file'],
    boolean: ['yes'],
    default: { 'env-file': '.env' },
  });
  const env = await readEnvFile(args['env-file']);
  const url = args.url ?? env.get('AGENT_MEMORY_URL');
  const token = args.token ?? env.get('AGENT_MEMORY_TOKEN');
  const scope = args.scope ?? 'user';
  if (!url || !token) {
    console.error(
      'Need a URL and token: pass --url and --token, or set AGENT_MEMORY_URL and AGENT_MEMORY_TOKEN in .env.',
    );
    Deno.exit(2);
  }
  if (scope !== 'user' && scope !== 'project' && scope !== 'local') {
    console.error(`--scope must be user, project or local, got '${scope}'`);
    Deno.exit(2);
  }
  try {
    Deno.exit(await configureClaude({ name: args.name, url, token, scope, yes: args.yes }));
  } catch (e) {
    console.error((e as Error).message);
    Deno.exit(1);
  }
}
