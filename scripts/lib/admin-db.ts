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
  if (opts.kind === 'human' && !opts.email) throw new Error('A human member requires an email (--human <email>)');
  const [dup] = await sql`select 1 from agent_memory.members where display_name = ${name}`;
  if (dup) throw new Error(`Member '${name}' already exists`);
  let authUserId: string | null = null;
  if (opts.email) {
    // Read-only lookup; nothing is ever written to auth.
    const [u] = await sql`select id from auth.users where lower(email) = lower(${opts.email})`;
    authUserId = u?.id ?? null;
  }
  const [r] = await sql`
    insert into agent_memory.members (display_name, kind, email, auth_user_id)
    values (${name}, ${opts.kind}, ${opts.email ?? null}, ${authUserId})
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
