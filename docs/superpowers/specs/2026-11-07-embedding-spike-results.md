# Embedding spike — results

Date: 2026-11-07
Answers: design §7.8 ("measure CPU per single embed, per multi-embed and per hybrid search").
Code: [`spike/`](../../../spike/) (throwaway; the function and the scratch schema were removed from the project afterwards).

## Verdict

**A single embed fits the free tier comfortably. Work proceeds; no maintainer decision is needed.**
Multi-embed calls must stay small, because the CPU limit is counted **per worker** rather than per request, so the
safe budget for one request is about **1 s of CPU**, not the documented 2 s.

## Setup

- Free-plan project, eu-west-1, Nano compute. Edge Function using the built-in `Supabase.ai.Session('gte-small')`
  with `mean_pool` and `normalize`; Postgres reached over `SUPABASE_DB_URL` with `postgres.js`.
- Scratch table of 3,000 memories (realistic length) with an HNSW cosine index and a GIN full-text index; hybrid
  search = `ts_rank_cd` + cosine, RRF k = 60, over-fetch 4×.
- Timing inside the function with `performance.now()`. **CPU time read from the platform's own worker shutdown
  logs** (`cpu_time_used`), via the Management API logs endpoint (`GET /v1/projects/{ref}/analytics/endpoints/logs`,
  ClickHouse SQL, `WHERE source = 'function_logs'`, fields in `log_attributes[...]`). The older `logs.all`
  endpoint now returns 410.

## Measurements

Sequential embeds use CPU roughly equal to wall time (one worker: 1,288 ms of embed wall time → 1,304 ms
`cpu_time_used`), so the wall times below are good CPU estimates.

| Operation | Per call | Notes |
|---|---|---|
| Embed short text (~10 tokens, a search query) | **~92 ms** | Fixed overhead dominates. |
| Embed typical memory (~260 words, ~330 tokens) | **~305 ms** | |
| Embed at the 512-token cap (longer input is truncated) | **~455 ms** | Up to ~780 ms on a worker's first call. |
| Hybrid search, warm DB connection | ~92 ms embed + **~25 ms** DB | DB time is I/O, not CPU. |
| Hybrid search, new DB connection | ~92 ms embed + **~230–260 ms** DB | Connection set-up; mostly I/O. |
| Worker boot | 20–33 ms | No separate model-load spike was visible. |
| Memory per worker | ~11 MB | Well under the 256 MB limit. |

Multi-embed in one request (typical-length memories):

| Request | Result |
|---|---|
| 2 sequential | OK, 620 ms |
| 4 sequential | OK on a fresh worker (1,223 ms); **6 of 20 failed** under sustained back-to-back load |
| 8+ sequential | Always killed (`546 WORKER_RESOURCE_LIMIT`, worker logged "CPU Time exceeded" at ~2.1–2.4 s) |
| 4 in parallel (`Promise.all`) | OK, 408 ms wall |
| 8 in parallel | Killed after ~560 ms wall: parallel inference uses several threads, so it saves wall time but **no CPU** |
| 5 short query embeds (a 5-topic `recall`) | 20 of 20 OK, ~460 ms |
| 8 short query embeds | OK, 737 ms |

## How the limit actually behaves

- **CPU accumulates per worker.** A worker serves several requests in turn and concurrently (up to 5–8 in these
  tests), and `cpu_time_used` is its running total. At ~2 s the worker is killed and **every request in flight on it
  fails** with 546.
- **Workers are retired early** once idle past roughly 1–1.6 s of CPU ("EarlyDrop"), and a fresh one takes the
  next request. That is harmless, but it means a request can land on a worker that already has about 1 s used.
- Consequence: under bursts of heavy work, even cheap single-embed requests can fail. 10 concurrent typical-length
  embeds straight after sustained load → 5 failed; 20 concurrent 512-token embeds → 12 failed. With workers drained
  (15 s idle), 5 concurrent typical-length embeds and 10 concurrent searches all succeeded. Sustained *sequential*
  single-embed traffic (30 typical, 20 max-length, 20 searches, 10 stores) never failed.

## Decisions this gives the build

1. **Budget about 1 s of CPU per request** at most, not 2 s.
2. **`store_batch` cap: 2 memories** (worst case 2 × 455 ms ≈ 0.9 s). Over the cap, return the "split the batch"
   error that §7.8 describes.
3. **`recall` topic cap: 5 topics** embedded (~460 ms); later topics fall back to keyword-only, as §7.8 says.
4. **Keep embedding input at or under 512 tokens** and keep one embed per call for `store`, `update` and `search`.
   Search costs about 120 ms of CPU, so it is the cheapest tool.
5. **Embed before writing.** A killed worker must leave nothing half-done: compute the embedding first, then do the
   insert/update and history row in one transaction.
6. **The importer runs one memory per call, sequentially, and retries 546/503 with backoff** (it re-uses the stored
   `id`, so a retry is idempotent).
7. **Reuse the DB connection** across requests on a worker (module-level client); a new connection adds ~250 ms
   wall time to the first call.
8. **Agents' parallel tool calls are the remaining risk** (anti-goal "less reliable than the local store"). At the
   expected load (a few maintainers and one bot) bursts large enough to fail are unlikely, but the plan should
   include: a clear error message on 546 that tells the agent to retry, and the smoke test should include a small
   concurrent burst. If failures appear in practice, the fallback is the Supabase "automatic embeddings" pattern
   (write first, embed asynchronously from a queue with retries), which takes embedding off the request path.
