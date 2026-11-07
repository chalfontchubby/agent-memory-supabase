import 'jsr:@supabase/functions-js@2/edge-runtime.d.ts';
import { createMcpHandler, McpServer } from 'npm:@modelcontextprotocol/server@2.4.0';
import { type Caller, connect, resolveCaller } from '../_shared/db.ts';
import { PgAdminStore } from '../_shared/admin-store.ts';
import { registerAdminTools } from '../_shared/admin-tools.ts';
import { GteSmallEmbedder } from '../_shared/embedder.ts';
import { MAX_CONTENT_CHARS } from '../_shared/limits.ts';
import { PgMemoryStore } from '../_shared/pg-store.ts';
import { registerTools } from '../_shared/tools.ts';

const VERSION = '0.1.0';

// Module level: reused across requests on a warm worker.
const dbUrl = Deno.env.get('SUPABASE_DB_URL');
if (!dbUrl) throw new Error('SUPABASE_DB_URL is not set');
const sql = connect(dbUrl);
const embedder = new GteSmallEmbedder();

const EMBED_MAX_BYTES = 64 * 1024;
const tooLarge = () => Response.json({ error: 'text too large' }, { status: 413 });

const unauthorized = () => Response.json({ error: 'invalid or missing token' }, { status: 401 });

/** Identity comes only from the bearer token: nothing else in the request can name a member. */
async function authenticate(req: Request): Promise<Caller | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  return m ? await resolveCaller(sql, m[1]) : null;
}

async function handle(req: Request): Promise<Response> {
  let caller: Caller | null;
  try {
    caller = await authenticate(req);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('auth lookup failed', err.code, err.message);
    return Response.json({ error: 'service unavailable' }, { status: 503 });
  }
  if (!caller) return unauthorized();
  const { memberId, isAdmin } = caller;

  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  if (req.method === 'POST' && path.endsWith('/embed')) {
    const declared = req.headers.get('content-length');
    if (declared !== null && Number(declared) > EMBED_MAX_BYTES) return tooLarge();
    const raw = await req.text();
    if (raw.length > EMBED_MAX_BYTES) return tooLarge();
    let body: { text?: unknown } | null = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    if (typeof body?.text === 'string' && body.text.length > MAX_CONTENT_CHARS) return tooLarge();
    if (!body || typeof body.text !== 'string' || body.text === '') {
      return Response.json({ error: 'text is required' }, { status: 400 });
    }
    try {
      return Response.json({ embedding: await embedder.embed(body.text) });
    } catch {
      return Response.json({ error: 'Embedding failed' }, { status: 500 });
    }
  }

  // Stateless: a fresh server per request, bound to this member's store.
  const store = new PgMemoryStore(sql, memberId, embedder);
  const mcp = createMcpHandler(() => {
    const s = new McpServer({ name: 'agent-memory-supabase', version: VERSION });
    registerTools(s, store, embedder);
    if (isAdmin) registerAdminTools(s, new PgAdminStore(sql, memberId));
    return s;
  }, { onerror: (e) => console.error('mcp error', e) });
  return await mcp.fetch(req);
}

Deno.serve(handle);
