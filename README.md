# agent-memory-supabase

Shared, hosted memory for AI agents, built on [Supabase](https://supabase.com/). An MCP server, run as a Supabase
Edge Function, gives agents persistent memory they can store into and search, from any machine or cloud session.

Memories live in **scopes** (named memory pools, such as `predbat-devs`). An admin grants each member read-only or
read-write access per scope, and Postgres row-level security enforces it. Several developers and their bots can
share one memory, and no one can read a scope they weren't granted.

> **Status:** design stage. See [the design](docs/superpowers/specs/2026-11-07-supabase-agent-memory-design.md).

## Credits

This project builds on the design and code of
[agent-memory-mcp](https://github.com/adamrdrew/agent-memory-mcp) by Adam Drew, via the
[chalfontchubby fork](https://github.com/chalfontchubby/agent-memory-mcp), which fixes upstream bugs that made the
memory forget records. It keeps their tool set, hybrid BM25 + vector search and temporal decay, and moves the store
from a local LanceDB folder to Supabase (Postgres, pgvector, full-text search) with scoped, shared access.

## License

GPL-3.0-or-later, as the original. See [LICENSE](LICENSE).
