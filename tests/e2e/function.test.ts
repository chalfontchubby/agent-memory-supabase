// End-to-end test of the deployed-shape Edge Function over real MCP.
// Requires, in other shells:  `supabase start`  and  `supabase functions serve agent-memory`.
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { Client, StreamableHTTPClientTransport } from 'npm:@modelcontextprotocol/client@2.4.0';
import { adminSql, makeWorld, type World } from '../helpers/fixtures.ts';
import { generateToken, hashToken } from '../../supabase/functions/_shared/tokens.ts';

const URL_ = Deno.env.get('FUNCTION_URL') ?? 'http://127.0.0.1:54321/functions/v1/agent-memory';

async function connect(token: string, extra: Record<string, string> = {}) {
  const client = new Client({ name: 'e2e', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, ...extra } },
  });
  await client.connect(transport);
  return client;
}

// deno-lint-ignore no-explicit-any
const parse = (r: any) => JSON.parse(r.content[0].text);
// deno-lint-ignore no-explicit-any
const text = (r: any): string => r.content[0].text;

async function post(headers: Record<string, string>, path = '', body: unknown = {}) {
  const res = await fetch(URL_ + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  const out = await res.text();
  return { status: res.status, body: out };
}

Deno.test('edge function end-to-end over MCP', async () => {
  const sql = adminSql();
  let w: World | undefined;
  const issue = async (memberId: string) => {
    const t = generateToken();
    const [r] = await sql`
      insert into agent_memory.access_tokens (member_id, name, token_hash)
      values (${memberId}, 'e2e', ${await hashToken(t)}) returning id`;
    return { token: t, id: r.id as string };
  };
  const clients: Client[] = [];
  const open = async (token: string, extra?: Record<string, string>) => {
    const c = await connect(token, extra);
    clients.push(c);
    return c;
  };
  try {
    const world = await makeWorld(sql);
    w = world;
    const rw = await issue(world.rw.id);
    const ro = await issue(world.ro.id);
    const none = await issue(world.none.id);

    await t('tools/list returns 11 tools', async () => {
      const c = await open(rw.token);
      assertEquals((await c.listTools()).tools.length, 11);
    });

    await t('store, search, update, find_related, delete as rw', async () => {
      const c = await open(rw.token);
      const stored = parse(
        await c.callTool({
          name: 'store',
          arguments: {
            scope: world.alpha.name,
            content: 'the quokka prefers eucalyptus',
            category: 'learning',
            tags: ['e2e'],
          },
        }),
      );
      assertEquals(stored.scope, world.alpha.name);
      assertEquals(stored.createdBy, world.rw.name);

      const other = parse(
        await c.callTool({
          name: 'store',
          arguments: {
            scope: world.alpha.name,
            content: 'quokkas eat eucalyptus leaves',
            category: 'learning',
            tags: [],
          },
        }),
      );

      const found = parse(await c.callTool({ name: 'search', arguments: { query: 'quokka eucalyptus' } }));
      assert(
        found.results.some((r: { memory: { id: string } }) => r.memory.id === stored.id),
        'search finds the stored memory',
      );

      const updated = parse(await c.callTool({ name: 'update', arguments: { id: stored.id, tags: ['e2e', 'x'] } }));
      assertEquals(updated.tags, ['e2e', 'x']);

      const related = parse(await c.callTool({ name: 'find_related', arguments: { memory_id: stored.id } }));
      assert(
        related.results.some((r: { memory: { id: string } }) => r.memory.id === other.id),
        'find_related finds the sibling',
      );

      await c.callTool({ name: 'delete', arguments: { id: stored.id } });
      const gone = await c.callTool({ name: 'update', arguments: { id: stored.id, tags: [] } });
      assertEquals(gone.isError, true);
    });

    await t('spoofing a member id changes nothing', async () => {
      const c = await open(rw.token, { 'X-Member-Id': world.ro.id });
      const m = parse(
        await c.callTool({
          name: 'store',
          arguments: {
            scope: world.alpha.name,
            content: 'spoof attempt',
            category: 'other',
            tags: [],
            member_id: world.ro.id,
          },
        }),
      );
      assertEquals(m.createdBy, world.rw.name);
    });

    await t('bad tokens get 401', async () => {
      const revoked = await issue(world.rw.id);
      await sql`update agent_memory.access_tokens set revoked_at = now() where id = ${revoked.id}`;
      const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
      const cases: Record<string, string>[] = [
        {},
        { authorization: 'Bearer amm_garbage' },
        { authorization: 'Bearer nope' },
        { authorization: `Bearer ${revoked.token}` },
      ];
      for (const headers of cases) {
        const r = await post(headers, '', body);
        assertEquals(r.status, 401);
        assertEquals(JSON.parse(r.body), { error: 'invalid or missing token' });
      }
    });

    await t('read-only token cannot store', async () => {
      const c = await open(ro.token);
      const r = await c.callTool({
        name: 'store',
        arguments: { scope: world.alpha.name, content: 'nope', category: 'other', tags: [] },
      });
      assertEquals(r.isError, true);
      assertStringIncludes(text(r), 'No write access');
    });

    await t('token with no grants sees no scopes', async () => {
      const c = await open(none.token);
      assertEquals(parse(await c.callTool({ name: 'list_scopes', arguments: {} })), { count: 0, scopes: [] });
    });

    await t('/embed rejects oversize and malformed bodies', async () => {
      const auth = { authorization: `Bearer ${rw.token}` };
      const big = await post(auth, '/embed', { text: 'x'.repeat(20_001) });
      assertEquals(big.status, 413);
      assertEquals(JSON.parse(big.body), { error: 'text too large' });
      assertEquals((await post(auth, '/embed', { text: 'x'.repeat(70_000) })).status, 413);
      const res = await fetch(URL_ + '/embed', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: '{not json',
      });
      assertEquals(res.status, 400);
      await res.body?.cancel();
      assertEquals((await post(auth, '/embed', { text: 5 })).status, 400);
    });

    await t('/embed returns a 384-length vector, and needs a token', async () => {
      const r = await post({ authorization: `Bearer ${rw.token}` }, '/embed', { text: 'hello world' });
      assertEquals(r.status, 200);
      assertEquals(JSON.parse(r.body).embedding.length, 384);
      assertEquals((await post({}, '/embed', { text: 'hi' })).status, 401);
    });
  } finally {
    try {
      for (const c of clients) await c.close().catch(() => {});
      await w?.cleanup();
    } finally {
      await sql.end();
    }
  }
});

async function t(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    throw new Error(`${name}: ${e instanceof Error ? e.message : e}`, { cause: e });
  }
}
