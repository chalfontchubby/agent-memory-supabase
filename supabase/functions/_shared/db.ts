import postgres from 'npm:postgres@3.4.5';
import { hashToken, looksLikeToken } from './tokens.ts';

export type Sql = postgres.Sql;

export function connect(url: string): Sql {
  return postgres(url, { max: 3, prepare: false });
}

export interface Caller {
  memberId: string;
  isAdmin: boolean;
}

/** Resolve a bearer token to its member and admin flag, or null. Malformed tokens never reach the database. */
export async function resolveCaller(sql: Sql, token: string): Promise<Caller | null> {
  if (!looksLikeToken(token)) return null;
  const hash = await hashToken(token);
  const rows = await sql<
    { member_id: string | null; is_admin: boolean | null }[]
  >`select member_id, is_admin from agent_memory.resolve_member(${hash})`;
  const r = rows[0];
  return r?.member_id ? { memberId: r.member_id, isAdmin: r.is_admin === true } : null;
}

/** Resolve a bearer token to a member id, or null. */
export async function resolveMember(sql: Sql, token: string): Promise<string | null> {
  return (await resolveCaller(sql, token))?.memberId ?? null;
}

/** Run `fn` in a transaction that acts as the member, so RLS applies. */
export function withMember<T>(
  sql: Sql,
  memberId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`set local role agent_memory_member`;
    await tx`select set_config('agent_memory.member_id', ${memberId}, true)`;
    return await fn(tx);
  }) as Promise<T>;
}
