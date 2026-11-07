import { assertEquals, assertRejects } from '@std/assert';
import { configureClaude } from '../../scripts/configure-claude.ts';
import type { RunResult } from '../../scripts/lib/run.ts';

const URL_ = 'https://example.supabase.co/functions/v1/agent-memory';
const TOKEN = 'amm_' + 'A'.repeat(43);

function stub(results: Partial<RunResult>[] = []) {
  const calls: { cmd: string; args: string[] }[] = [];
  const run = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const r = results[calls.length - 1] ?? {};
    return Promise.resolve({ code: 0, stdout: '', stderr: '', ...r });
  };
  return { calls, run };
}

Deno.test('default call removes then adds at user scope with the exact header', async () => {
  const s = stub([{ code: 1, stderr: 'No MCP server found' }]);
  const out: string[] = [];
  const code = await configureClaude({ url: URL_, token: TOKEN, run: s.run, log: (l) => out.push(l) });
  assertEquals(code, 0);
  assertEquals(s.calls[0], { cmd: 'claude', args: ['mcp', 'remove', 'shared-memory', '-s', 'user'] });
  assertEquals(s.calls[1], {
    cmd: 'claude',
    args: [
      'mcp',
      'add',
      '--transport',
      'http',
      'shared-memory',
      URL_,
      '--header',
      `Authorization: Bearer ${TOKEN}`,
      '-s',
      'user',
    ],
  });
  assertEquals(out.some((l) => l.includes(TOKEN)), false);
});

Deno.test('project scope without yes throws and runs nothing', async () => {
  const s = stub();
  await assertRejects(
    () => configureClaude({ url: URL_, token: TOKEN, scope: 'project', run: s.run, log: () => {} }),
    Error,
    '--yes',
  );
  assertEquals(s.calls.length, 0);
});

Deno.test('a failing add never echoes the token', async () => {
  const s = stub([{}, { code: 2, stderr: `bad header Authorization: Bearer ${TOKEN}` }]);
  const out: string[] = [];
  assertEquals(await configureClaude({ url: URL_, token: TOKEN, run: s.run, log: (l) => out.push(l) }), 1);
  assertEquals(out.join('\n').includes(TOKEN), false);
});

Deno.test('claude not on PATH prints the command with a placeholder and exits 1', async () => {
  const out: string[] = [];
  const run = () => Promise.reject(new Deno.errors.NotFound('claude'));
  assertEquals(await configureClaude({ url: URL_, token: TOKEN, run, log: (l) => out.push(l) }), 1);
  const text = out.join('\n');
  assertEquals(text.includes(TOKEN), false);
  assertEquals(text.includes('Bearer $AGENT_MEMORY_TOKEN'), true);
});
