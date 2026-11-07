import 'jsr:@supabase/functions-js@2/edge-runtime.d.ts';
import { createMcpHandler, McpServer } from 'npm:@modelcontextprotocol/server@2.4.0';
import { connect, resolveMember } from '../_shared/db.ts';
import { GteSmallEmbedder } from '../_shared/embedder.ts';
import { PgMemoryStore } from '../_shared/pg-store.ts';
import { registerTools } from '../_shared/tools.ts';

const VERSION = '0.1.0';

// Module level: reused across requests on a warm worker.
const sql = connect(Deno.env.get('SUPABASE_DB_URL')!);
const embedder = new GteSmallEmbedder();

const unauthorized = () => Response.json({ error: 'invalid or missing token' }, { status: 401 });

/** Identity comes only from the bearer token: nothing else in the request can name a member. */
async function authenticate(req: Request): Promise<string | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  return m ? await resolveMember(sql, m[1]) : null;
}

async function handle(req: Request): Promise<Response> {
  const memberId = await authenticate(req);
  if (!memberId) return unauthorized();

  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  if (req.method === 'POST' && path.endsWith('/embed')) {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.text !== 'string' || body.text === '') {
      return Response.json({ error: 'text is required' }, { status: 400 });
    }
    try {
      return Response.json({ embedding: await embedder.embed(body.text) });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  // Stateless: a fresh server per request, bound to this member's store.
  const store = new PgMemoryStore(sql, memberId, embedder);
  const mcp = createMcpHandler(() => {
    const s = new McpServer({ name: 'agent-memory-supabase', version: VERSION });
    registerTools(s, store, embedder);
    return s;
  });
  return await mcp.fetch(req);
}

Deno.serve(handle);
