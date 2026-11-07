// Spike: reliability of single-embed calls under sustained and concurrent load.
const ref = Deno.env.get("SUPABASE_PROJECT_REF")!, key = Deno.env.get("ANON_KEY")!;
const url = `https://${ref}.supabase.co/functions/v1/spike-embed`;
const medium = (await Deno.readTextFile("medium.txt")).trim();
const long = `${medium} ${medium} ${medium}`;
async function call(body: unknown) {
  const a = performance.now();
  const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ms: Math.round(performance.now() - a), served: j.worker?.served, code: j.code };
}
function summary(label: string, rs: { status: number; ms: number; served?: number }[]) {
  const ok = rs.filter((r) => r.status === 200).length;
  const ms = rs.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`${label.padEnd(34)} ok=${ok}/${rs.length} statuses=${[...new Set(rs.map((r) => r.status))]} p50=${ms[ms.length >> 1]}ms max=${ms.at(-1)}ms maxServedPerWorker=${Math.max(...rs.map((r) => r.served ?? 0))}`);
}
const seq = async (n: number, body: unknown) => { const rs = []; for (let i = 0; i < n; i++) rs.push(await call(body)); return rs; };
summary("sequential 30 x medium embed", await seq(30, { action: "embed", texts: [medium] }));
summary("sequential 20 x long embed", await seq(20, { action: "embed", texts: [long] }));
summary("concurrent 10 x medium embed", await Promise.all(Array.from({ length: 10 }, () => call({ action: "embed", texts: [medium] }))));
summary("concurrent 20 x long embed", await Promise.all(Array.from({ length: 20 }, () => call({ action: "embed", texts: [long] }))));
summary("sequential 20 x search", await seq(20, { action: "search", query: "battery charge window regression", limit: 10 }));
summary("sequential 10 x store (seed)", await seq(10, { action: "seed", text: medium }));
summary("sequential 20 x seq medium x4", await seq(20, { action: "embed", texts: Array(4).fill(medium) }));
summary("sequential 20 x seq short x5 (recall)", await seq(20, { action: "embed", texts: Array(5).fill("octopus tariff export rate") }));
