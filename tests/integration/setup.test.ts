import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { connect } from '../../supabase/functions/_shared/db.ts';
import { hashToken } from '../../supabase/functions/_shared/tokens.ts';
import { setup, type SetupOptions } from '../../scripts/setup.ts';
import { readEnvFile } from '../../scripts/lib/env-file.ts';
import { defaultRun, type Runner } from '../../scripts/lib/run.ts';
import { adminSql, LOCAL_DB_URL } from '../helpers/fixtures.ts';

const sfx = () => crypto.randomUUID().slice(0, 8);
const PAT = 'sbp_' + 'x'.repeat(40);
const PASSWORD = 'p@ss/word#1';

async function withSetup(
  fn: (
    c: { dir: string; env: string; s: string; opts: () => SetupOptions; cmds: string[][]; lines: string[] },
  ) => Promise<void>,
  envText?: string,
) {
  const dir = await Deno.makeTempDir();
  await new Deno.Command('git', { args: ['init', '-q'], cwd: dir }).output();
  await Deno.writeTextFile(`${dir}/.gitignore`, '.env\n');
  const env = `${dir}/.env`;
  await Deno.writeTextFile(
    env,
    envText ??
      `# my notes\nSUPABASE_ACCESS_TOKEN=${PAT}\nSUPABASE_DB_PASSWORD=${PASSWORD}\nSUPABASE_PROJECT_REF=abcdefghijklmnop\n`,
  );
  const s = sfx();
  const cmds: string[][] = [];
  const lines: string[] = [];
  const run: Runner = (cmd, args, o) => {
    if (cmd === 'supabase') {
      cmds.push([cmd, ...args]);
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    }
    return defaultRun(cmd, args, o);
  };
  const fakeFetch = (_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify({ region: 'eu-west-1' }), { status: 200 }));
  const sql = adminSql();
  try {
    await fn({
      dir,
      env,
      s,
      cmds,
      lines,
      opts: () => ({
        envFile: env,
        scope: `team-${s}`,
        member: `bot-${s}`,
        bot: true,
        skipDeploy: true,
        run,
        fetch: fakeFetch as typeof fetch,
        connect: () => connect(LOCAL_DB_URL),
        log: (l) => lines.push(l),
      }),
    });
  } finally {
    await sql`delete from agent_memory.members where display_name like ${'%' + s}`;
    await sql`delete from agent_memory.scopes where name like ${'%' + s}`;
    await sql.end();
    await Deno.remove(dir, { recursive: true });
  }
}

const resolveId = async (token: string) => {
  const sql = adminSql();
  try {
    return (await sql`select agent_memory.resolve_token(${await hashToken(token)}) as id`)[0].id as string | null;
  } finally {
    await sql.end();
  }
};

Deno.test('first run creates scope, member, grant and token, and saves them to .env', async () => {
  await withSetup(async (c) => {
    assertEquals(await setup(c.opts()), 0);
    assertEquals(c.cmds[0], ['supabase', 'link', '--project-ref', 'abcdefghijklmnop', '--yes']);
    assertEquals(c.cmds[1], ['supabase', 'db', 'push', '--remote', '--yes']);
    assertEquals(c.cmds.length, 2); // deploy skipped
    const env = await readEnvFile(c.env);
    assertEquals(env.get('AGENT_MEMORY_URL'), 'https://abcdefghijklmnop.supabase.co/functions/v1/agent-memory');
    const token = env.get('AGENT_MEMORY_TOKEN')!;
    assert(/^amm_[A-Za-z0-9_-]{43}$/.test(token));
    assertEquals(
      env.get('AGENT_MEMORY_DB_URL'),
      'postgresql://postgres.abcdefghijklmnop:p%40ss%2Fword%231@aws-0-eu-west-1.pooler.supabase.com:5432/postgres',
    );
    assert(await resolveId(token));
    assertEquals((await Deno.stat(c.env)).mode! & 0o777, 0o600);
    assertStringIncludes(await Deno.readTextFile(c.env), '# my notes');
    const out = c.lines.join('\n');
    assertEquals(out.split(token).length - 1, 1, 'token printed exactly once');
    for (const secret of [PAT, PASSWORD, 'p%40ss']) assertEquals(out.includes(secret), false);
    const sql = adminSql();
    const [g] = await sql`
      select g.access from agent_memory.scope_grants g
      join agent_memory.scopes s on s.id = g.scope_id join agent_memory.members m on m.id = g.member_id
      where s.name = ${'team-' + c.s} and m.display_name = ${'bot-' + c.s}`;
    await sql.end();
    assertEquals(g.access, 'write');
  });
});

Deno.test('a second run creates nothing new and keeps the token; --new-token replaces it', async () => {
  await withSetup(async (c) => {
    assertEquals(await setup(c.opts()), 0);
    const first = (await readEnvFile(c.env)).get('AGENT_MEMORY_TOKEN')!;
    c.lines.length = 0;
    assertEquals(await setup(c.opts()), 0);
    assertEquals((await readEnvFile(c.env)).get('AGENT_MEMORY_TOKEN'), first);
    assertEquals(c.lines.join('\n').includes(first), false);
    const count = async () => {
      const sql = adminSql();
      const [r] = await sql`
        select count(*)::int as n from agent_memory.access_tokens t
        join agent_memory.members m on m.id = t.member_id where m.display_name = ${'bot-' + c.s}`;
      await sql.end();
      return r.n as number;
    };
    assertEquals(await count(), 1);
    assertEquals(await setup({ ...c.opts(), newToken: true }), 0);
    const second = (await readEnvFile(c.env)).get('AGENT_MEMORY_TOKEN')!;
    assert(second !== first);
    assertEquals(await count(), 2);
    assert(await resolveId(second));
    assertEquals((await Deno.readTextFile(c.env)).match(/^AGENT_MEMORY_TOKEN=/gm)?.length, 1);
  });
});

Deno.test('a token belonging to another member is not reused', async () => {
  await withSetup(async (c) => {
    assertEquals(await setup(c.opts()), 0);
    const first = (await readEnvFile(c.env)).get('AGENT_MEMORY_TOKEN')!;
    assertEquals(await setup({ ...c.opts(), member: `other-${c.s}`, bot: true }), 0);
    assert((await readEnvFile(c.env)).get('AGENT_MEMORY_TOKEN') !== first);
  });
});

Deno.test('a missing SUPABASE_DB_PASSWORD is named and nothing is created', async () => {
  await withSetup(async (c) => {
    assertEquals(await setup(c.opts()), 1);
    assertStringIncludes(c.lines.join('\n'), 'SUPABASE_DB_PASSWORD');
    assertEquals(c.cmds.length, 0);
    const sql = adminSql();
    const [r] = await sql`select count(*)::int as n from agent_memory.scopes where name = ${'team-' + c.s}`;
    await sql.end();
    assertEquals(r.n, 0);
  }, `SUPABASE_ACCESS_TOKEN=${PAT}\nSUPABASE_PROJECT_REF=abcdefghijklmnop\n`);
});

Deno.test('refuses to write when the env file is not git-ignored', async () => {
  await withSetup(async (c) => {
    await Deno.writeTextFile(`${c.dir}/.gitignore`, '');
    let msg = '';
    try {
      await setup(c.opts());
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, 'is not ignored by git');
    assertEquals(c.cmds.length, 0);
  });
});
