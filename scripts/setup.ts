// One-command setup: migrate and deploy to a Supabase project, create a team (scope) and user (member),
// issue a token and save it to .env.
//   deno run -A scripts/setup.ts [--env-file .env] [--scope default] [--member <name>] [--email <addr>] [--bot]
//     [--new-token] [--skip-deploy] [--configure-claude [--name shared-memory]]
// Reads SUPABASE_ACCESS_TOKEN, SUPABASE_DB_PASSWORD and SUPABASE_PROJECT_REF from the env file.
import { fromFileUrl } from 'jsr:@std/path@1.0.8';
import { parseArgs } from 'jsr:@std/cli@1.0.9/parse-args';
import { connect, type Sql } from '../supabase/functions/_shared/db.ts';
import { hashToken } from '../supabase/functions/_shared/tokens.ts';
import { configureClaude } from './configure-claude.ts';
import { createMember, createScope, grant, issueToken, listScopes } from './lib/admin-db.ts';
import { assertGitIgnored, readEnvFile, upsertEnvVars } from './lib/env-file.ts';
import { defaultRun, redact, type Runner } from './lib/run.ts';

const REQUIRED: [string, string][] = [
  ['SUPABASE_ACCESS_TOKEN', 'dashboard > Account > Access Tokens (starts with sbp_)'],
  ['SUPABASE_DB_PASSWORD', 'the database password you set when creating the project (Settings > Database)'],
  ['SUPABASE_PROJECT_REF', 'the project reference in the dashboard URL or Settings > General'],
];
const POOLER_PREFIXES = ['aws-0', 'aws-1'];

export interface SetupOptions {
  envFile?: string;
  scope?: string;
  member?: string;
  email?: string;
  bot?: boolean;
  newToken?: boolean;
  skipDeploy?: boolean;
  configureClaude?: boolean;
  name?: string;
  /** Runs supabase, git and claude. */
  run?: Runner;
  fetch?: typeof fetch;
  /** Opens the database. Receives the session-pooler URL. */
  connect?: (url: string) => Sql;
  log?: (line: string) => void;
}

/** Returns the process exit code. Prints the new token once, and no other secret. */
export async function setup(o: SetupOptions): Promise<number> {
  const envFile = o.envFile ?? '.env';
  const scope = o.scope ?? 'default';
  const kind = o.bot ? 'bot' : 'human';
  const run = o.run ?? defaultRun;
  const doFetch = o.fetch ?? fetch;
  const open = o.connect ?? connect;
  const log = o.log ?? ((l: string) => console.log(l));

  const env = await readEnvFile(envFile);
  const missing = REQUIRED.filter(([k]) => !env.get(k));
  if (missing.length > 0) {
    log(`Missing from ${envFile}:\n` + missing.map(([k, where]) => `  ${k}: ${where}`).join('\n'));
    return 1;
  }
  const pat = env.get('SUPABASE_ACCESS_TOKEN')!;
  const password = env.get('SUPABASE_DB_PASSWORD')!;
  const ref = env.get('SUPABASE_PROJECT_REF')!;
  if (!/^[a-z0-9]+$/.test(ref)) {
    log('SUPABASE_PROJECT_REF should contain only lowercase letters and digits.');
    return 1;
  }
  const secrets = [pat, password, encodeURIComponent(password)];
  const member = o.member ?? Deno.env.get('USER') ?? 'admin';

  await assertGitIgnored(envFile, run);

  // 1. Region from the Management API, then the session-pooler URL.
  const res = await doFetch(`https://api.supabase.com/v1/projects/${ref}`, {
    headers: { Authorization: `Bearer ${pat}` },
  });
  if (!res.ok) {
    await res.body?.cancel();
    log(
      `Could not read the project from the Supabase API (HTTP ${res.status}). Check SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF.`,
    );
    return 1;
  }
  const region = (await res.json()).region;
  if (typeof region !== 'string' || !/^[a-z0-9-]+$/.test(region)) {
    log('The Supabase API response had no usable region.');
    return 1;
  }
  let sql: Sql | undefined;
  let dbUrl = '';
  for (const prefix of POOLER_PREFIXES) {
    const url = `postgresql://postgres.${ref}:${
      encodeURIComponent(password)
    }@${prefix}-${region}.pooler.supabase.com:5432/postgres`;
    const candidate = open(url);
    try {
      await candidate`select 1`;
      sql = candidate;
      dbUrl = url;
      log(`[1/7] Database reachable through the ${prefix}-${region} session pooler`);
      break;
    } catch {
      await candidate.end().catch(() => {});
    }
  }
  if (!sql) {
    log(
      `Could not connect to the database in region ${region}. Check SUPABASE_DB_PASSWORD and that the project is not paused.`,
    );
    return 1;
  }

  try {
    await upsertEnvVars(envFile, { AGENT_MEMORY_DB_URL: dbUrl });

    // 2-4. link, migrate, deploy.
    const cwd = fromFileUrl(new URL('..', import.meta.url));
    const sbEnv = { ...Deno.env.toObject(), SUPABASE_ACCESS_TOKEN: pat, SUPABASE_DB_PASSWORD: password };
    const sb = async (step: string, args: string[]) => {
      const r = await run('supabase', args, { cwd, env: sbEnv });
      if (r.code !== 0) {
        const detail = redact((r.stderr || r.stdout).trim(), secrets).split('\n').slice(-8).join('\n');
        throw new Error(`${step} failed (exit ${r.code}):\n${detail}`);
      }
    };
    await sb('supabase link', ['link', '--project-ref', ref, '--yes']);
    log('[2/7] Linked the project');
    await sb('supabase db push', ['db', 'push', '--remote', '--yes']);
    log('[3/7] Migrations applied');
    if (o.skipDeploy) {
      log('[4/7] Deploy skipped (--skip-deploy)');
    } else {
      await sb('supabase functions deploy', ['functions', 'deploy', 'agent-memory', '--use-api', '--yes']);
      log('[4/7] Function deployed');
    }

    // 5. scope, member, grant.
    let step = 'exists';
    if (!(await listScopes(sql)).some((s) => s.name === scope)) {
      await createScope(sql, scope, scope === 'default' ? 'Default team memory' : undefined);
      step = 'created';
    }
    log(`[5/7] Scope '${scope}' ${step}`);
    const [existing] = await sql`select id from agent_memory.members where display_name = ${member}`;
    if (!existing) {
      // Email is optional and only links a Supabase login, so it is stored only when given.
      await createMember(sql, member, { kind, email: kind === 'human' ? o.email : undefined });
    }
    await grant(sql, member, scope, 'write');
    log(`[6/7] Member '${member}' (${existing ? 'existing' : kind}) can write to '${scope}'`);

    // 6. token: reuse the one in the env file when it is still live for this member.
    const [m] = await sql`select id from agent_memory.members where display_name = ${member}`;
    const current = env.get('AGENT_MEMORY_TOKEN');
    let token = current;
    let issued = false;
    if (o.newToken || !current || (await resolveId(sql, current)) !== m.id) {
      if (current) {
        const [old] = await sql`
          select id from agent_memory.access_tokens where token_hash = ${await hashToken(current)}`;
        if (old && await resolveId(sql, current)) {
          log(
            `The previous token in ${envFile} is still live (id ${old.id}); revoke it if unused: ` +
              `deno run -A scripts/admin.ts revoke-token ${old.id}`,
          );
        }
      }
      token = await issueToken(sql, member, `setup ${new Date().toISOString()}`);
      secrets.push(token);
      issued = true;
    }
    const url = `https://${ref}.supabase.co/functions/v1/agent-memory`;
    await upsertEnvVars(envFile, { AGENT_MEMORY_URL: url, AGENT_MEMORY_TOKEN: token! });
    log(`[7/7] ${issued ? 'Issued a new token' : 'Kept the live token'} and saved it to ${envFile}`);
    log(`URL:   ${url}`);
    if (issued) log(`Token: ${token} (shown once; also saved in ${envFile})`);
    else log(`Token: unchanged, see AGENT_MEMORY_TOKEN in ${envFile}`);

    if (o.configureClaude) {
      return await configureClaude({ name: o.name, url, token: token!, run, log });
    }
    return 0;
  } catch (e) {
    log(redact((e as Error).message, secrets));
    return 1;
  } finally {
    await sql.end();
  }
}

async function resolveId(sql: Sql, token: string): Promise<string | null> {
  const [r] = await sql`select agent_memory.resolve_token(${await hashToken(token)}) as id`;
  return r?.id ?? null;
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ['env-file', 'scope', 'member', 'email', 'name'],
    boolean: ['bot', 'new-token', 'skip-deploy', 'configure-claude'],
    default: { 'env-file': '.env' },
  });
  try {
    Deno.exit(
      await setup({
        envFile: args['env-file'],
        scope: args.scope,
        member: args.member,
        email: args.email,
        bot: args.bot,
        newToken: args['new-token'],
        skipDeploy: args['skip-deploy'],
        configureClaude: args['configure-claude'],
        name: args.name,
      }),
    );
  } catch (e) {
    console.error((e as Error).message);
    Deno.exit(1);
  }
}
