import type postgres from 'npm:postgres@3.4.5';
import { type Sql, withMember } from './db.ts';
import { importanceMultiplier, isEvergreen, parseDecayHalfLife } from './decay.ts';
import { STORE_BATCH_MAX } from './limits.ts';
import type {
  Embedder,
  Memory,
  MemoryCategory,
  MemoryStats,
  MemoryStore,
  PruneOptions,
  PruneResult,
  ScopeInfo,
  SearchFilters,
  SearchMode,
  SearchResult,
  StoreRequest,
  UpdateRequest,
} from './types.ts';

type Tx = postgres.TransactionSql;
const MS_PER_DAY = 86_400_000;

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

class StoreError extends Error {}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

export function rowToMemory(r: Row): Memory {
  return {
    id: r.id,
    scope: r.scope,
    content: r.content,
    category: r.category as MemoryCategory,
    tags: r.tags,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    createdBy: r.created_by,
    updatedBy: r.updated_by,
  };
}

const vec = (e: number[]): string => JSON.stringify(e);
const notFoundMemory = (id: string) => new StoreError(`Memory ${id} not found`);
const noWrite = (scope: string) => new StoreError(`No write access to scope '${scope}'`);

export class PgMemoryStore implements MemoryStore {
  constructor(
    private readonly sql: Sql,
    private readonly memberId: string,
    private readonly embedder: Embedder,
    private readonly halfLifeDays: number = parseDecayHalfLife(Deno.env.get('MEMORY_DECAY_HALF_LIFE')),
  ) {}

  /** Run as the member; Postgres errors become friendly messages, never raw driver text. */
  private async run<T>(fn: (tx: Tx) => Promise<T>, onPgError?: (code: string) => Error | undefined): Promise<T> {
    try {
      return await withMember(this.sql, this.memberId, fn);
    } catch (e) {
      if (e instanceof StoreError) throw e;
      const code = (e as { code?: string }).code;
      const mapped = code ? onPgError?.(code) : undefined;
      if (mapped) throw mapped;
      throw new Error('Database error');
    }
  }

  private async scopeAccess(tx: Tx, name: string): Promise<{ id: string; access: 'read' | 'write' } | null> {
    const rows = await tx<Row[]>`
      select s.id, g.access from agent_memory.scopes s
      join agent_memory.scope_grants g on g.scope_id = s.id and g.member_id = ${this.memberId}::uuid
      where s.name = ${name}`;
    return rows[0] ? { id: rows[0].id, access: rows[0].access } : null;
  }

  private async writableScope(tx: Tx, name: string): Promise<string> {
    const s = await this.scopeAccess(tx, name);
    if (!s) throw new StoreError(`Scope '${name}' not found`);
    if (s.access !== 'write') throw noWrite(name);
    return s.id;
  }

  async listScopes(): Promise<ScopeInfo[]> {
    return await this.run(async (tx) => {
      const rows = await tx<Row[]>`
        select s.name, s.description, g.access,
          (select count(*)::int from agent_memory.memories m where m.scope_id = s.id) as n
        from agent_memory.scope_grants g
        join agent_memory.scopes s on s.id = g.scope_id
        where g.member_id = ${this.memberId}::uuid
        order by s.name`;
      return rows.map((r) => ({
        scope: r.name,
        description: r.description,
        access: r.access,
        memoryCount: r.n,
      }));
    });
  }

  async store(scope: string, r: StoreRequest): Promise<Memory> {
    return (await this.storeBatch(scope, [r]))[0];
  }

  async storeBatch(scope: string, rs: StoreRequest[]): Promise<Memory[]> {
    if (rs.length > STORE_BATCH_MAX) {
      throw new Error(
        `store_batch accepts at most ${STORE_BATCH_MAX} memories per call on this server; ` +
          `split the batch or call store for each memory.`,
      );
    }
    // Embed (sequentially) before opening the transaction.
    const embeddings: number[][] = [];
    for (const r of rs) embeddings.push(await this.embedder.embed(r.content));
    return await this.run(async (tx) => {
      const scopeId = await this.writableScope(tx, scope);
      const ids: string[] = [];
      for (let i = 0; i < rs.length; i++) {
        const r = rs[i];
        const ins = await tx<Row[]>`
          insert into agent_memory.memories (scope_id, content, category, tags, created_by, updated_by, embedding)
          values (${scopeId}::uuid, ${r.content}, ${r.category}, ${tx.array(r.tags)}::text[],
            ${this.memberId}::uuid, ${this.memberId}::uuid, ${vec(embeddings[i])}::extensions.vector)
          returning id`;
        ids.push(ins[0].id);
      }
      const rows = await tx<Row[]>`select * from agent_memory.memory_view where id = any(${ids}::uuid[])`;
      const byId = new Map(rows.map((x) => [x.id, x]));
      return ids.map((id) => rowToMemory(byId.get(id)!));
    }, (code) => code === '42501' ? noWrite(scope) : undefined);
  }

  /** Visible memory (via RLS), with its write access resolved; throws the two standard errors. */
  private async visibleWritable(tx: Tx, id: string): Promise<Row> {
    let rows: Row[];
    try {
      rows = await tx.savepoint((s) => s<Row[]>`select * from agent_memory.memory_view where id = ${id}::uuid`);
    } catch (e) {
      if ((e as { code?: string }).code === '22P02') throw notFoundMemory(id);
      throw e;
    }
    const row = rows[0];
    if (!row) throw notFoundMemory(id);
    const s = await this.scopeAccess(tx, row.scope);
    if (s?.access !== 'write') throw noWrite(row.scope);
    return row;
  }

  async update(id: string, u: UpdateRequest): Promise<Memory> {
    // Read current state first so we know whether to embed (outside the write transaction).
    const current = await this.run((tx) => this.visibleWritable(tx, id));
    let embedding: string | null = null;
    if (u.content !== undefined && u.content !== current.content) {
      embedding = vec(await this.embedder.embed(u.content));
    }
    return await this.run(async (tx) => {
      await this.visibleWritable(tx, id);
      const targetScope = u.scope !== undefined ? await this.writableScope(tx, u.scope) : null;
      const upd = await tx<Row[]>`
        update agent_memory.memories set
          content = coalesce(${u.content ?? null}::text, content),
          category = coalesce(${u.category ?? null}::text, category),
          tags = coalesce(${u.tags ? tx.array(u.tags) : null}::text[], tags),
          scope_id = coalesce(${targetScope}::uuid, scope_id),
          embedding = coalesce(${embedding}::extensions.vector, embedding),
          updated_by = ${this.memberId}::uuid,
          updated_at = now()
        where id = ${id}::uuid and deleted_at is null
        returning id`;
      if (upd.length === 0) throw notFoundMemory(id);
      const rows = await tx<Row[]>`select * from agent_memory.memory_view where id = ${id}::uuid`;
      return rowToMemory(rows[0]);
    }, (code) => code === '22P02' ? notFoundMemory(id) : code === '42501' ? noWrite(current.scope) : undefined);
  }

  async delete(id: string): Promise<void> {
    await this.run(async (tx) => {
      await this.visibleWritable(tx, id);
      const res = await tx<{ ids: string[] }[]>`select agent_memory.soft_delete(array[${id}]::uuid[]) as ids`;
      if (res[0].ids.length === 0) throw notFoundMemory(id);
    }, (code) => code === '22P02' ? notFoundMemory(id) : undefined);
  }

  async prune(o: PruneOptions): Promise<PruneResult> {
    const { dryRun = true, minStrength = 0.05, maxDormantDays = 90 } = o;
    return await this.run(async (tx) => {
      const scopeId = await this.writableScope(tx, o.scope);
      const rows = await tx<Row[]>`
        select id, content, tags, updated_at, access_count, last_accessed_at
        from agent_memory.memories where scope_id = ${scopeId}::uuid`;
      const candidates: PruneResult['candidates'] = [];
      for (const row of rows) {
        if (isEvergreen(row.tags)) continue;
        const updatedAt = iso(row.updated_at);
        const effectiveHalfLife = this.halfLifeDays * importanceMultiplier({
          accessCount: row.access_count,
          lastAccessedAt: row.last_accessed_at ? iso(row.last_accessed_at) : null,
          updatedAt,
        });
        const ageDays = Math.max(0, (Date.now() - new Date(updatedAt).getTime()) / MS_PER_DAY);
        const strength = effectiveHalfLife > 0 ? Math.pow(0.5, ageDays / effectiveHalfLife) : 0;
        let reason = '';
        if (strength < minStrength) reason = `strength ${strength.toFixed(4)} < ${minStrength}`;
        else if (row.access_count === 0 && ageDays > maxDormantDays) {
          reason = `never accessed, ${Math.floor(ageDays)} days old > ${maxDormantDays}`;
        }
        if (reason) candidates.push({ id: row.id, content: row.content.slice(0, 120), strength, reason });
      }
      let pruned = 0;
      if (!dryRun && candidates.length > 0) {
        const ids = candidates.map((c) => c.id);
        const res = await tx<{ ids: string[] }[]>`select agent_memory.soft_delete(${ids}::uuid[]) as ids`;
        pruned = res[0].ids.length;
      }
      return { pruned, inspected: rows.length, dryRun, candidates };
    });
  }

  // ── Read half: Task 7 ──────────────────────────────────────────

  search(_q: string, _m: SearchMode, _f: SearchFilters, _e?: number[] | null): Promise<SearchResult[]> {
    throw new Error('not implemented');
  }
  findRelated(_id: string, _limit: number, _scopes?: string[]): Promise<SearchResult[]> {
    throw new Error('not implemented');
  }
  listRecent(_limit: number, _c?: MemoryCategory, _scopes?: string[]): Promise<Memory[]> {
    throw new Error('not implemented');
  }
  stats(_scopes?: string[]): Promise<MemoryStats> {
    throw new Error('not implemented');
  }
}
