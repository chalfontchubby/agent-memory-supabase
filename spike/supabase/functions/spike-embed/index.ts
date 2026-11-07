// THROWAWAY spike (see docs/superpowers/specs §7.8): measure gte-small embedding and hybrid-search
// cost inside a free-tier Supabase Edge Function. Not production code.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.5";

const bootAt = performance.now();
let served = 0;
// deno-lint-ignore no-explicit-any
const session = new (globalThis as any).Supabase.ai.Session("gte-small");
let sql: ReturnType<typeof postgres> | null = null;

const t = () => performance.now();
const ms = (a: number) => Math.round((performance.now() - a) * 10) / 10;

async function embed(text: string): Promise<number[]> {
  return (await session.run(text, { mean_pool: true, normalize: true })) as number[];
}

function metrics() {
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  try {
    return er?.getRuntimeMetrics ? er.getRuntimeMetrics() : null;
  } catch (e) {
    return String(e);
  }
}

Deno.serve(async (req) => {
  served++;
  const worker = { served, msSinceBoot: Math.round(performance.now() - bootAt) };
  const body = await req.json().catch(() => ({}));
  const action = body.action ?? "embed";
  const start = t();
  try {
    if (action === "ping") {
      return Response.json({ worker, metrics: metrics() });
    }

    if (action === "embed") {
      const texts: string[] = body.texts ?? ["hello world"];
      const per: number[] = [];
      let vecs: number[][];
      if (body.parallel) {
        const a = t();
        vecs = await Promise.all(texts.map(embed));
        per.push(ms(a));
      } else {
        vecs = [];
        for (const x of texts) {
          const a = t();
          vecs.push(await embed(x));
          per.push(ms(a));
        }
      }
      return Response.json({
        worker, action, n: texts.length, parallel: !!body.parallel, dims: vecs[0]?.length,
        perEmbedMs: per, totalMs: ms(start), metrics: metrics(),
      });
    }

    if (action === "search" || action === "seed") {
      const a = t();
      if (!sql) sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
      const vec = await embed(body.text ?? body.query);
      const embedMs = ms(a);
      const b = t();
      const v = JSON.stringify(vec);
      if (action === "seed") {
        await sql`insert into spike.memories (content, embedding) values (${body.text}, ${v}::vector)`;
        return Response.json({ worker, action, embedMs, dbMs: ms(b), totalMs: ms(start) });
      }
      const rows = await sql`select id, left(content, 60) as content, score
        from spike.hybrid_search(${body.query}, ${v}::vector, ${body.limit ?? 10})`;
      return Response.json({
        worker, action, embedMs, dbMs: ms(b), totalMs: ms(start), hits: rows.length,
        top: rows.slice(0, 3), metrics: metrics(),
      });
    }

    return Response.json({ error: `unknown action ${action}` }, { status: 400 });
  } catch (e) {
    return Response.json({ worker, error: String(e), totalMs: ms(start) }, { status: 500 });
  }
});
