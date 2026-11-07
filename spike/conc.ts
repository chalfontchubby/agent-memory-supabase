const ref = Deno.env.get("SUPABASE_PROJECT_REF")!, key = Deno.env.get("ANON_KEY")!;
const url = `https://${ref}.supabase.co/functions/v1/spike-embed`;
const medium = (await Deno.readTextFile("medium.txt")).trim();
async function call(body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return `${r.status}${j.worker ? "/s" + j.worker.served : ""}`;
}
for (const [label, n, body] of [
  ["concurrent 3 x medium store-embed", 3, { action: "embed", texts: [medium] }],
  ["concurrent 5 x medium store-embed", 5, { action: "embed", texts: [medium] }],
  ["concurrent 5 x search", 5, { action: "search", query: "inverter timeout debug", limit: 10 }],
  ["concurrent 10 x search", 10, { action: "search", query: "inverter timeout debug", limit: 10 }],
] as const) {
  await new Promise((r) => setTimeout(r, 15000)); // let workers drain between rounds
  const rs = await Promise.all(Array.from({ length: n }, () => call(body)));
  console.log(label.padEnd(36), rs.join(" "));
}
