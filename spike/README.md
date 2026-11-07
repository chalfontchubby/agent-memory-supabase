# Embedding spike (throwaway)

Measures `gte-small` embedding and hybrid-search CPU cost in a free-tier Supabase Edge Function.
Results and the decisions they led to: [../docs/superpowers/specs/2026-11-07-embedding-spike-results.md](../docs/superpowers/specs/2026-11-07-embedding-spike-results.md).

Reproduce (credentials in the repo-root `.env`, never committed):

```sh
set -a; source ../.env; set +a
deno run -A run-sql.ts spike.sql                     # scratch schema + 3,000 filler memories
supabase functions deploy spike-embed --project-ref $SUPABASE_PROJECT_REF --use-api
export ANON_KEY=...                                  # project anon key
deno run -A bench.ts all; deno run -A stress.ts; deno run -A conc.ts
deno run -A logs.ts "SELECT ... FROM logs WHERE source = 'function_logs'" <iso-start>   # CPU per worker
deno run -A run-sql.ts drop.sql; supabase functions delete spike-embed --project-ref $SUPABASE_PROJECT_REF
```

`run1.log`–`run3.log` are the raw outputs behind the results doc.
