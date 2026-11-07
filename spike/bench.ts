// Spike benchmark driver: calls spike-embed with a range of loads and prints a compact line per call.
const ref = Deno.env.get("SUPABASE_PROJECT_REF")!;
const key = Deno.env.get("ANON_KEY")!;
const url = `https://${ref}.supabase.co/functions/v1/spike-embed`;

const short = "Supabase edge function embedding test";
const medium = (await Deno.readTextFile("medium.txt")).trim(); // ~400 tokens, a real-sized memory
const long = medium + " " + medium + " " + medium; // >512 tokens, will be truncated

async function call(label: string, body: unknown) {
  const a = performance.now();
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const wall = Math.round(performance.now() - a);
  const text = await r.text();
  let j: Record<string, unknown> = {};
  try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 200) }; }
  const { metrics: _m, top: _t, ...rest } = j as Record<string, unknown>;
  console.log(`${label.padEnd(28)} http=${r.status} roundtrip=${wall}ms ${JSON.stringify(rest)}`);
  return j;
}

const plan = Deno.args[0] ?? "all";
if (plan === "cold" || plan === "all") {
  await call("ping (cold?)", { action: "ping" });
  await call("embed short #1 (model load)", { action: "embed", texts: [short] });
  for (let i = 2; i <= 4; i++) await call(`embed short #${i}`, { action: "embed", texts: [short] });
}
if (plan === "single" || plan === "all") {
  for (let i = 1; i <= 3; i++) await call(`embed medium #${i}`, { action: "embed", texts: [medium] });
  for (let i = 1; i <= 3; i++) await call(`embed long #${i}`, { action: "embed", texts: [long] });
}
if (plan === "multi" || plan === "all") {
  for (const n of [2, 4, 8, 16, 24, 32]) {
    await call(`seq medium x${n}`, { action: "embed", texts: Array(n).fill(medium) });
  }
  for (const n of [4, 8]) {
    await call(`parallel medium x${n}`, { action: "embed", texts: Array(n).fill(medium), parallel: true });
  }
  for (const n of [4, 8]) {
    await call(`seq short x${n}`, { action: "embed", texts: Array(n).fill(short) });
  }
}
if (plan === "search" || plan === "all") {
  for (const q of ["battery charge window regression", "octopus tariff export rate", "how do I debug the inverter timeout",
    "battery charge window regression", "solar forecast"]) {
    await call(`search "${q.slice(0, 18)}"`, { action: "search", query: q, limit: 10 });
  }
}
