import type { Sql } from '../../supabase/functions/_shared/db.ts';
import { generateToken, hashToken } from '../../supabase/functions/_shared/tokens.ts';

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

/** Run an adm_* call. Their P0001 errors are user-safe: rethrow the message alone, never driver detail. */
async function adm<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === 'P0001') throw new Error(err.message);
    throw e;
  }
}

export async function createScope(sql: Sql, name: string, description?: string): Promise<Scope> {
  await adm(() => sql`select agent_memory.adm_create_scope(${name}, ${description ?? null}, null, ${grantor()})`);
  const [r] = await sql`select id, name, description from agent_memory.scopes where name = ${name}`;
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
  await adm(() => sql`select agent_memory.adm_create_member(${name}, ${opts.kind}, ${email}, null, ${grantor()})`);
  const [r] = await sql`
    select id, display_name as name, kind, auth_user_id as "authUserId"
    from agent_memory.members where display_name = ${name}`;
  return r as Member;
}

export async function grant(sql: Sql, member: string, scope: string, access: 'read' | 'write'): Promise<void> {
  await adm(() => sql`select agent_memory.adm_grant(${member}, ${scope}, ${access}, null, ${grantor()})`);
}

export async function revoke(sql: Sql, member: string, scope: string): Promise<boolean> {
  const [r] = await adm(() => sql`select agent_memory.adm_revoke(${member}, ${scope}, null, ${grantor()}) as ok`);
  return r.ok as boolean;
}

export async function deleteScope(sql: Sql, name: string): Promise<void> {
  await adm(() => sql`select agent_memory.adm_delete_scope(${name}, null, ${grantor()})`);
}

export async function deactivateMember(sql: Sql, name: string): Promise<void> {
  await adm(() => sql`select agent_memory.adm_deactivate_member(${name}, null, ${grantor()})`);
}

export async function reactivateMember(sql: Sql, name: string): Promise<void> {
  await adm(() => sql`select agent_memory.adm_reactivate_member(${name}, null, ${grantor()})`);
}

export async function setAdmin(sql: Sql, name: string, on: boolean): Promise<void> {
  await adm(() => sql`select agent_memory.adm_set_admin(${name}, ${on}, null, ${grantor()})`);
}

export interface MemberRow {
  name: string;
  kind: 'human' | 'bot';
  email: string | null;
  is_admin: boolean;
  deactivated: boolean;
  live_tokens: number;
}

export async function listMembers(sql: Sql): Promise<MemberRow[]> {
  return await sql<MemberRow[]>`
    select m.display_name as name, m.kind, m.email, m.is_admin,
           (m.deactivated_at is not null) as deactivated,
           (select count(*)::int from agent_memory.access_tokens t
             where t.member_id = m.id and t.revoked_at is null
               and (t.expires_at is null or t.expires_at > now())) as live_tokens
    from agent_memory.members m order by m.display_name`;
}

export interface AdminLogRow {
  at: Date;
  actor: string;
  action: string;
  target: string;
  details: unknown;
}

/** Admin log, newest first. `actor` matches the member's display name or the recorded label. */
export async function adminLog(
  sql: Sql,
  f: { since?: Date; actor?: string; limit?: number } = {},
): Promise<AdminLogRow[]> {
  return await sql<AdminLogRow[]>`
    select l.at, coalesce(m.display_name, l.actor_label) as actor, l.action, l.target, l.details
    from agent_memory.admin_log l
    left join agent_memory.members m on m.id = l.actor_member_id
    where ${f.since === undefined ? sql`true` : sql`l.at >= ${f.since}`}
      and ${f.actor === undefined ? sql`true` : sql`coalesce(m.display_name, l.actor_label) = ${f.actor}`}
    order by l.at desc, l.id desc
    limit ${f.limit ?? 50}`;
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
  const token = generateToken();
  const hash = await hashToken(token);
  await adm(() =>
    sql`select agent_memory.adm_issue_token(${member}, ${name}, ${hash}, ${expires ?? null}, null, ${grantor()})`
  );
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
  if (!UUID.test(id)) throw new Error(`Token '${id}' not found or already revoked`);
  await adm(() => sql`select agent_memory.adm_revoke_token(${id}::uuid, null, ${grantor()})`);
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

export interface ThreadSummary {
  id: string;
  scope: string;
  title: string;
  deletedAt: Date | null;
}

/** A thread, live or soft-deleted, or null when there is none with that id (or the id is not a UUID). */
export async function threadSummary(sql: Sql, id: string): Promise<ThreadSummary | null> {
  if (!UUID.test(id)) return null;
  const [r] = await sql`
    select t.id, s.name as scope, t.title, t.deleted_at as "deletedAt"
    from agent_memory.threads t join agent_memory.scopes s on s.id = t.scope_id where t.id = ${id}::uuid`;
  return (r as ThreadSummary | undefined) ?? null;
}

/** Soft-delete a thread (recoverable for 30 days) and log it. */
export async function deleteThread(sql: Sql, id: string): Promise<void> {
  if (!UUID.test(id)) throw new Error(`Thread ${id} not found`);
  await adm(() => sql`select agent_memory.adm_delete_thread(${id}::uuid, null, ${grantor()})`);
}

export async function restoreThread(sql: Sql, id: string): Promise<void> {
  const ok = UUID.test(id) && (await sql`select agent_memory.restore_thread(${id}::uuid) as ok`)[0].ok;
  if (!ok) throw new Error(`Thread ${id} not found or not deleted`);
}

/** Hard-delete a thread now (live or soft-deleted); its posts, links and subscriptions go with it. Not reversible. */
export async function eraseThread(sql: Sql, id: string): Promise<void> {
  const ok = UUID.test(id) && (await sql`select agent_memory.erase_thread(${id}::uuid) as ok`)[0].ok;
  if (!ok) throw new Error(`Thread ${id} not found`);
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
