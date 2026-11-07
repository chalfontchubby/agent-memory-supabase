// Spike helper: run a SQL file against the project via the session pooler.
import postgres from "npm:postgres@3.4.5";
const ref = Deno.env.get("SUPABASE_PROJECT_REF")!;
const pw = Deno.env.get("SUPABASE_DB_PASSWORD")!;
const file = Deno.args[0];
for (const host of ["aws-0-eu-west-1.pooler.supabase.com", "aws-1-eu-west-1.pooler.supabase.com"]) {
  const sql = postgres({ host, port: 5432, database: "postgres", username: `postgres.${ref}`, password: pw,
    ssl: "require", max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    await sql`select 1`;
    console.log(`connected via ${host}`);
    if (file) await sql.unsafe(await Deno.readTextFile(file));
    const r = await sql`select count(*)::int as n from spike.memories`.catch((e) => [{ n: String(e.message) }]);
    console.log("spike.memories rows:", r[0].n);
    await sql.end();
    Deno.exit(0);
  } catch (e) {
    console.log(`${host}: ${(e as Error).message}`);
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}
Deno.exit(1);
