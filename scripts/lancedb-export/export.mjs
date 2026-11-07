#!/usr/bin/env node
// Export an agent-memory-mcp LanceDB store (table `memories`) as JSON on stdout.
//
//   node export.mjs <MEMORY_DB_PATH> > memories.json
//
// Output: [{ id, content, category, tags, createdAt, updatedAt, accessCount, lastAccessedAt }]
// Vectors are omitted; the importer re-computes embeddings. Treat the output as private: it is the
// full content of your memories (memories*.json is gitignored).
//
// Supported Node: >= 20 (LTS), with the prebuilt @lancedb/lancedb 0.26.x native binary for your platform.
import { connect } from '@lancedb/lancedb';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node export.mjs <MEMORY_DB_PATH> > memories.json');
  process.exit(1);
}

const db = await connect(path);
if (!(await db.tableNames()).includes('memories')) {
  console.error(`No 'memories' table in ${path}`);
  process.exit(1);
}
const rows = await (await db.openTable('memories')).query().toArray();

const out = rows.map((r) => {
  let tags = [];
  try {
    const parsed = JSON.parse(r.tags ?? '[]');
    if (Array.isArray(parsed)) tags = parsed.map(String);
  } catch {
    // Unparseable tags: export none rather than abort the whole store.
  }
  return {
    id: r.id,
    content: r.content,
    category: r.category,
    tags,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    accessCount: Number(r.access_count ?? 0),
    lastAccessedAt: r.last_accessed_at ?? null,
  };
});

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
