import { parseArgs } from 'jsr:@std/cli@1.0.9/parse-args';
import { connect } from '../supabase/functions/_shared/db.ts';
import type { Sql } from '../supabase/functions/_shared/db.ts';

/** One memory as written by scripts/lancedb-export/export.mjs. */
export interface ImportedMemory {
  id: string;
  content: string;
  category: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  accessCount?: number;
  lastAccessedAt?: string | null;
}

export const CATEGORIES = [
  'code-solution',
  'bug-fix',
  'architecture',
  'learning',
  'tool-usage',
  'debugging',
  'performance',
  'security',
  'observation',
  'personal',
  'relationship',
  'other',
];

export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

export interface SelectOptions {
  includeTags: string[];
  excludeTags: string[];
  /** When given, only these ids are selected (an empty list selects nothing). */
  ids?: string[];
}

export interface Selection {
  selected: ImportedMemory[];
  /** Dropped by the tag rules (no include tag matched, or an exclude tag matched). */
  excludedByTag: number;
  /** Passed the tag rules but is not in the ids list. */
  notInIds: number;
}

/** Selection = (no include tags or any include tag) and (no exclude tag) and (no ids list or id listed). */
export function selectMemories(all: ImportedMemory[], opts: SelectOptions): Selection {
  const wanted = opts.ids === undefined ? undefined : new Set(opts.ids);
  const selected: ImportedMemory[] = [];
  let excludedByTag = 0;
  let notInIds = 0;
  for (const m of all) {
    const tags = m.tags ?? [];
    const included = opts.includeTags.length === 0 || tags.some((t) => opts.includeTags.includes(t));
    const excluded = tags.some((t) => opts.excludeTags.includes(t));
    if (!included || excluded) {
      excludedByTag++;
    } else if (wanted && !wanted.has(m.id)) {
      notInIds++;
    } else {
      selected.push(m);
    }
  }
  return { selected, excludedByTag, notInIds };
}

export interface ImportOptions {
  scope: string;
  /** Display name of the member recorded as created_by and updated_by. */
  as: string;
  /** Function base URL; `/embed` is appended. */
  embedUrl: string;
  token: string;
  /** Injectable so tests need not wait out the backoff. */
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  failed: number;
  failures: { id: string; reason: string }[];
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class Retryable extends Error {}

/** POST <url>/embed. 546 (platform CPU limit), 503 and network errors are retried with backoff 1, 2, 4, 8, 16 s. */
export async function embedWithRetry(
  baseUrl: string,
  token: string,
  text: string,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<number[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/embed`;
  for (let attempt = 0;; attempt++) {
    try {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        });
      } catch (e) {
        throw new Retryable(`network error: ${(e as Error).message}`);
      }
      if (res.status === 546 || res.status === 503) {
        await res.body?.cancel();
        throw new Retryable(`HTTP ${res.status}`);
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`embed failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
      }
      const body = await res.json();
      if (!Array.isArray(body?.embedding) || body.embedding.length !== 384) {
        throw new Error('embed failed: response has no 384-dimension embedding');
      }
      return body.embedding;
    } catch (e) {
      if (!(e instanceof Retryable)) throw e;
      if (attempt >= RETRY_DELAYS_MS.length) throw new Error(`embed failed after retries: ${e.message}`);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

const validTime = (v: unknown): v is string => typeof v === 'string' && !isNaN(Date.parse(v));

function invalidReason(m: ImportedMemory): string | null {
  if (typeof m.content !== 'string' || m.content.trim() === '') return 'empty content';
  if (!CATEGORIES.includes(m.category)) return `invalid category '${m.category}'`;
  if (!/^[0-9a-f-]{36}$/i.test(String(m.id))) return 'invalid id';
  if (!Array.isArray(m.tags) || m.tags.some((t) => typeof t !== 'string')) return 'invalid tags';
  if (!validTime(m.createdAt) || !validTime(m.updatedAt)) return 'invalid timestamp';
  if (m.lastAccessedAt != null && !validTime(m.lastAccessedAt)) return 'invalid timestamp';
  return null;
}

/** Sequentially embed and insert each memory as postgres. Never throws for a bad memory; counts it as failed. */
export async function importMemories(
  sql: Sql,
  memories: ImportedMemory[],
  opts: ImportOptions,
): Promise<ImportResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const [scope] = await sql`select id from agent_memory.scopes where name = ${opts.scope}`;
  if (!scope) throw new Error(`Scope '${opts.scope}' not found`);
  const [member] = await sql`select id from agent_memory.members where display_name = ${opts.as}`;
  if (!member) throw new Error(`Member '${opts.as}' not found`);

  const result: ImportResult = { imported: 0, skipped: 0, failed: 0, failures: [] };
  const fail = (id: string, reason: string) => {
    result.failed++;
    result.failures.push({ id, reason });
    log(`failed ${id}: ${reason}`);
  };
  for (const m of memories) {
    const bad = invalidReason(m);
    if (bad) {
      fail(m.id, bad);
      continue;
    }
    try {
      const embedding = await embedWithRetry(opts.embedUrl, opts.token, m.content, opts.sleep);
      // Timestamps are bound as text and cast: postgres.js would truncate a JS Date to milliseconds.
      const rows = await sql`
        insert into agent_memory.memories
          (id, scope_id, content, category, tags, created_at, updated_at, created_by, updated_by,
           access_count, last_accessed_at, embedding)
        values (${m.id}, ${scope.id}, ${m.content}, ${m.category}, ${sql.array(m.tags, 1009)},
                (${m.createdAt}::text)::timestamptz, (${m.updatedAt}::text)::timestamptz,
                ${member.id}, ${member.id}, ${m.accessCount ?? 0}, (${m.lastAccessedAt ?? null}::text)::timestamptz,
                ${JSON.stringify(embedding)}::extensions.vector)
        on conflict (id) do nothing
        returning id`;
      if (rows.length === 0) {
        result.skipped++;
        log(`skipped ${m.id} (already present)`);
      } else {
        result.imported++;
        log(`imported ${m.id}`);
      }
    } catch (e) {
      fail(m.id, (e as Error).message);
    }
  }
  return result;
}

const USAGE = `Usage: deno run -A scripts/import.ts --file memories.json --scope <name> --as <member>
         [--include-tag t]... [--exclude-tag t]... [--ids ids.txt] [--write-ids out.txt] [--execute]
Dry run by default: lists what would be imported. --execute needs:
  AGENT_MEMORY_DB_URL   postgres connection string
  AGENT_MEMORY_URL      function base URL, e.g. https://<ref>.supabase.co/functions/v1/agent-memory
  AGENT_MEMORY_TOKEN    any valid member token (used only for /embed)`;

function firstLine(content: string): string {
  const line = content.split('\n')[0].trim();
  return line.length > 100 ? line.slice(0, 100) : line;
}

async function main() {
  const args = parseArgs(Deno.args, {
    string: ['file', 'scope', 'as', 'include-tag', 'exclude-tag', 'ids', 'write-ids'],
    collect: ['include-tag', 'exclude-tag'],
    boolean: ['execute', 'help'],
  });
  if (args.help || !args.file) {
    console.log(USAGE);
    if (!args.help) Deno.exit(1);
    return;
  }
  const all: ImportedMemory[] = JSON.parse(await Deno.readTextFile(args.file));
  if (!Array.isArray(all)) throw new Error(`${args.file} is not a JSON array of memories`);
  const ids = args.ids
    ? (await Deno.readTextFile(args.ids)).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : undefined;
  const sel = selectMemories(all, {
    includeTags: args['include-tag'] as string[],
    excludeTags: args['exclude-tag'] as string[],
    ids,
  });

  if (!args.execute) {
    for (const m of sel.selected) {
      console.log(`${m.id} | ${m.category} | ${(m.tags ?? []).join(',')} | ${firstLine(m.content ?? '')}`);
    }
    console.log(
      `selected ${sel.selected.length} of ${all.length} (excluded by tag: ${sel.excludedByTag}, not in ids: ${sel.notInIds})`,
    );
    if (args['write-ids']) {
      await Deno.writeTextFile(args['write-ids'], sel.selected.map((m) => m.id).join('\n') + '\n');
      console.log(`wrote ${sel.selected.length} ids to ${args['write-ids']}`);
    }
    console.log('Dry run: nothing imported. Re-run with --execute to import.');
    return;
  }

  const dbUrl = Deno.env.get('AGENT_MEMORY_DB_URL');
  const url = Deno.env.get('AGENT_MEMORY_URL');
  const token = Deno.env.get('AGENT_MEMORY_TOKEN');
  const missing = [['AGENT_MEMORY_DB_URL', dbUrl], ['AGENT_MEMORY_URL', url], ['AGENT_MEMORY_TOKEN', token]]
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`--execute requires these environment variables: ${missing.join(', ')}`);
  if (!args.scope || !args.as) throw new Error('--execute requires --scope <name> and --as <member>');

  if (args['write-ids']) {
    await Deno.writeTextFile(args['write-ids'], sel.selected.map((m) => m.id).join('\n') + '\n');
  }
  const sql = connect(dbUrl!);
  try {
    const r = await importMemories(sql, sel.selected, {
      scope: args.scope,
      as: args.as,
      embedUrl: url!,
      token: token!,
    });
    console.log(`imported ${r.imported}, skipped ${r.skipped}, failed ${r.failed}`);
    if (r.failed > 0) Deno.exit(1);
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    Deno.exit(1);
  }
}
