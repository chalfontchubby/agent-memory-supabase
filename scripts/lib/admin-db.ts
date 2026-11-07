import type { Sql } from '../../supabase/functions/_shared/db.ts';
import { generateToken, hashToken } from '../../supabase/functions/_shared/tokens.ts';

const SCOPE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface Scope {
  id: string;
  name: string;
  description: string | null;
}
export interface Member {
  id: string;
  name: string;
  kind: 'human' | 'bot';
  authUserId: string | null;
}
export interface GrantRow {
  scope: string;
  member: string;
  access: 'read' | 'write';
  grantedBy: string | null;
  grantedAt: Date;
}
export interface TokenRow {
  id: string;
  name: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/** Who to record in scope_grants.granted_by: the OS user, else 'admin'. */
export function grantor(): string {
  return Deno.env.get('USER') || 'admin';
}

async function scopeId(sql: Sql, name: string): Promise<string> {
  const [r] = await sql`select id from agent_memory.scopes where name = ${name}`;
  if (!r) throw new Error(`Scope '${name}' not found`);
  return r.id;
}

async function memberId(sql: Sql, name: string): Promise<string> {
  const [r] = await sql`select id from agent_memory.members where display_name = ${name}`;
  if (!r) throw new Error(`Member '${name}' not found`);
  return r.id;
}

export async function createScope(sql: Sql, name: string, description?: string): Promise<Scope> {
  if (!SCOPE_NAME.test(name)) {
    throw new Error(
      `Invalid scope name '${name}': use 1-63 characters, lowercase letters, digits and hyphens, starting with a letter or digit.`,
    );
  }
  const [dup] = await sql`select 1 from agent_memory.scopes where name = ${name}`;
  if (dup) throw new Error(`Scope '${name}' already exists`);
  const [r] = await sql`
    insert into agent_memory.scopes (name, description) values (${name}, ${description ?? null})
    returning id, name, description`;
  return r as Scope;
}

export async function listScopes(sql: Sql): Promise<Scope[]> {
  return await sql<Scope[]>`select id, name, description from agent_memory.scopes order by name`;
}

export async function createMember(
  sql: Sql,
  name: string,
  opts: { kind: 'human' | 'bot'; email?: string },
): Promise<Member> {
  // Email is optional: it is only used to link the member to a Supabase login (auth.users).
  const email = opts.email?.trim() || null;
  const [dup] = await sql`select 1 from agent_memory.members where display_name = ${name}`;
  if (dup) throw new Error(`Member '${name}' already exists`);
  let authUserId: string | null = null;
  if (email) {
    // Read-only lookup; nothing is ever written to auth.
    const [u] = await sql`select id from auth.users where lower(email) = lower(${email})`;
    authUserId = u?.id ?? null;
  }
  const [r] = await sql`
    insert into agent_memory.members (display_name, kind, email, auth_user_id)
    values (${name}, ${opts.kind}, ${email}, ${authUserId})
    returning id, display_name as name, kind, auth_user_id as "authUserId"`;
  return r as Member;
}

export async function grant(sql: Sql, member: string, scope: string, access: 'read' | 'write'): Promise<void> {
  if (access !== 'read' && access !== 'write') throw new Error(`Access must be read or write, got '${access}'`);
  const m = await memberId(sql, member);
  const s = await scopeId(sql, scope);
  await sql`
    insert into agent_memory.scope_grants (scope_id, member_id, access, granted_by)
    values (${s}, ${m}, ${access}, ${grantor()})
    on conflict (scope_id, member_id)
    do update set access = excluded.access, granted_by = excluded.granted_by, granted_at = now()`;
}

export async function revoke(sql: Sql, member: string, scope: string): Promise<boolean> {
  const m = await memberId(sql, member);
  const s = await scopeId(sql, scope);
  const r = await sql`delete from agent_memory.scope_grants where scope_id = ${s} and member_id = ${m}`;
  return r.count > 0;
}

export async function listGrants(sql: Sql): Promise<GrantRow[]> {
  return await sql<GrantRow[]>`
    select s.name as scope, m.display_name as member, g.access,
           g.granted_by as "grantedBy", g.granted_at as "grantedAt"
    from agent_memory.scope_grants g
    join agent_memory.scopes s on s.id = g.scope_id
    join agent_memory.members m on m.id = g.member_id
    order by s.name, m.display_name`;
}

/** Parse an ISO date or `Nd` (days from now). */
export function parseExpires(input: string, now: Date = new Date()): Date {
  const days = /^(\d+)d$/.exec(input);
  if (days) return new Date(now.getTime() + Number(days[1]) * 86_400_000);
  const d = new Date(input);
  if (/^\d{4}-\d{2}-\d{2}/.test(input) && !isNaN(d.getTime())) return d;
  throw new Error(`Invalid --expires '${input}': use an ISO date (2027-01-31) or a number of days (30d)`);
}

/** Returns the plaintext token. It is not recoverable afterwards: only the hash is stored. */
export async function issueToken(sql: Sql, member: string, name: string, expires?: Date): Promise<string> {
  const m = await memberId(sql, member);
  const token = generateToken();
  await sql`
    insert into agent_memory.access_tokens (member_id, name, token_hash, expires_at)
    values (${m}, ${name}, ${await hashToken(token)}, ${expires ?? null})`;
  return token;
}

export async function listTokens(sql: Sql, member: string): Promise<TokenRow[]> {
  const m = await memberId(sql, member);
  return await sql<TokenRow[]>`
    select id, name, created_at as "createdAt", last_used_at as "lastUsedAt",
           expires_at as "expiresAt", revoked_at as "revokedAt"
    from agent_memory.access_tokens where member_id = ${m} order by created_at`;
}

export async function revokeToken(sql: Sql, id: string): Promise<void> {
  const r = await sql`
    update agent_memory.access_tokens set revoked_at = now()
    where id::text = ${id} and revoked_at is null`;
  if (r.count === 0) throw new Error(`Token '${id}' not found or already revoked`);
}

export async function restoreMemory(sql: Sql, id: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`Memory ${id} not found or not deleted`);
  const [r] = await sql`select agent_memory.restore(${id}::uuid) as ok`;
  if (!r.ok) throw new Error(`Memory ${id} not found or not deleted`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** First line of the content, trimmed, at most `max` characters. */
export function firstLine(content: string, max = 80): string {
  const line = content.split('\n')[0].trim();
  return line.length > max ? line.slice(0, max) : line;
}

export interface MemorySummary {
  id: string;
  scope: string;
  deletedAt: Date | null;
  firstLine: string;
}

/** A memory, live or soft-deleted, or null when there is none with that id. */
export async function memorySummary(sql: Sql, id: string): Promise<MemorySummary | null> {
  if (!UUID.test(id)) return null;
  const [r] = await sql`
    select m.id, s.name as scope, m.deleted_at as "deletedAt", m.content
    from agent_memory.memories m join agent_memory.scopes s on s.id = m.scope_id
    where m.id = ${id}::uuid`;
  return r ? { id: r.id, scope: r.scope, deletedAt: r.deletedAt, firstLine: firstLine(r.content) } : null;
}

/** Hard-delete a memory now (live or soft-deleted) and scrub its history. Not reversible. */
export async function eraseMemory(sql: Sql, id: string): Promise<void> {
  const ok = UUID.test(id) && (await sql`select agent_memory.erase(${id}::uuid) as ok`)[0].ok;
  if (!ok) throw new Error(`Memory ${id} not found`);
}

export interface DeletedFilter {
  scope?: string;
  /** Member display name, or 'admin' for deletions made without a member. */
  by?: string;
  /** ISO date: deleted at or after. */
  since?: string;
}

export interface DeletedRow {
  id: string;
  scope: string;
  deletedAt: Date;
  deletedBy: string;
  firstLine: string;
}

/** Soft-deleted memories, newest deletion first, with who deleted each (from its latest 'delete' history row). */
export async function listDeleted(sql: Sql, f: DeletedFilter = {}): Promise<DeletedRow[]> {
  if (f.scope !== undefined) await scopeId(sql, f.scope);
  if (f.since !== undefined && (!/^\d{4}-\d{2}-\d{2}/.test(f.since) || isNaN(Date.parse(f.since)))) {
    throw new Error(`Invalid --since '${f.since}': use an ISO date or timestamp (2026-11-07 or 2026-11-07T12:00:00Z)`);
  }
  // 'admin' means "no member": unless a member is actually called admin.
  let byMember: string | null | undefined;
  if (f.by !== undefined) {
    const [r] = await sql`select id from agent_memory.members where display_name = ${f.by}`;
    if (r) byMember = r.id;
    else if (f.by === 'admin') byMember = null;
    else throw new Error(`Member '${f.by}' not found`);
  }
  const rows = await sql`
    select m.id, s.name as scope, m.deleted_at as "deletedAt", m.content,
      case when h.member_id is null then 'admin' else coalesce(mb.display_name, h.member_id::text) end as "deletedBy"
    from agent_memory.memories m
    join agent_memory.scopes s on s.id = m.scope_id
    left join lateral (
      select hh.member_id from agent_memory.memory_history hh
      where hh.memory_id = m.id and hh.action = 'delete' order by hh.id desc limit 1
    ) h on true
    left join agent_memory.members mb on mb.id = h.member_id
    where m.deleted_at is not null
      and ${f.scope === undefined ? sql`true` : sql`s.name = ${f.scope}`}
      and ${f.since === undefined ? sql`true` : sql`m.deleted_at >= ${f.since}::timestamptz`}
      and ${
    byMember === undefined ? sql`true` : byMember === null ? sql`h.member_id is null` : sql`h.member_id = ${byMember}`
  }
    order by m.deleted_at desc, m.id`;
  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    deletedAt: r.deletedAt,
    deletedBy: r.deletedBy,
    firstLine: firstLine(r.content),
  }));
}

/** Restore several soft-deleted memories in one transaction. Ids that are unknown or not deleted are returned in `missing`. */
export async function restoreMemories(sql: Sql, ids: string[]): Promise<{ restored: string[]; missing: string[] }> {
  const restored: string[] = [];
  const missing: string[] = [];
  await sql.begin(async (tx) => {
    for (const id of [...new Set(ids)]) {
      const ok = UUID.test(id) && (await tx`select agent_memory.restore(${id}::uuid) as ok`)[0].ok;
      (ok ? restored : missing).push(id);
    }
  });
  return { restored, missing };
}
