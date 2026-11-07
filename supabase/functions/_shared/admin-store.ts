import type postgres from 'npm:postgres@3.4.5';
import { type Sql, withMember } from './db.ts';
import { StoreError } from './limits.ts';
import { generateToken, hashToken } from './tokens.ts';

type Tx = postgres.TransactionSql;
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

export interface AdminScope {
  name: string;
  description: string | null;
  memories: number;
  deleted: number;
  readers: number;
  writers: number;
}
export interface AdminMember {
  name: string;
  kind: 'human' | 'bot';
  email: string | null;
  isAdmin: boolean;
  deactivated: boolean;
  liveTokens: number;
}
export interface AdminGrant {
  scope: string;
  member: string;
  access: 'read' | 'write';
  grantedAt: string;
  grantedBy: string | null;
}
export interface AdminToken {
  id: string;
  name: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/**
 * Admin operations, called as the member. Every call goes through the database's admin_* functions, which check
 * the caller is an active admin and apply every rule; this class adds none of its own.
 */
export class PgAdminStore {
  constructor(private readonly sql: Sql, private readonly memberId: string) {}

  /** Postgres rule texts are user-safe and pass through verbatim; anything else is logged and hidden. */
  private async run<T>(fn: (tx: Tx) => Promise<T>, onPgError?: (code: string) => StoreError | undefined): Promise<T> {
    try {
      return await withMember(this.sql, this.memberId, fn);
    } catch (e) {
      if (e instanceof StoreError) throw e;
      const err = e as { code?: string; message?: string };
      if (err.code === 'P0001') throw new StoreError(err.message ?? 'Database error');
      if (err.code === '42501') throw new StoreError('Admin only');
      const mapped = err.code ? onPgError?.(err.code) : undefined;
      if (mapped) throw mapped;
      console.error('database error', err.code, err.message);
      throw new StoreError('Database error');
    }
  }

  listScopes(): Promise<AdminScope[]> {
    return this.run(async (tx) => {
      const rows = await tx<Row[]>`select * from agent_memory.admin_list_scopes()`;
      return rows.map((r) => ({
        name: r.name,
        description: r.description,
        memories: r.memories,
        deleted: r.deleted,
        readers: r.readers,
        writers: r.writers,
      }));
    });
  }

  createScope(name: string, description?: string): Promise<{ id: string }> {
    return this.run(async (tx) => {
      const [r] = await tx<Row[]>`select agent_memory.admin_create_scope(${name}, ${description ?? null}) as id`;
      return { id: r.id };
    });
  }

  deleteScope(name: string): Promise<void> {
    return this.run(async (tx) => {
      await tx`select agent_memory.admin_delete_scope(${name})`;
    });
  }

  listMembers(): Promise<AdminMember[]> {
    return this.run(async (tx) => {
      const rows = await tx<Row[]>`select * from agent_memory.admin_list_members()`;
      return rows.map((r) => ({
        name: r.name,
        kind: r.kind,
        email: r.email,
        isAdmin: r.is_admin,
        deactivated: r.deactivated,
        liveTokens: r.live_tokens,
      }));
    });
  }

  createMember(name: string, kind: 'human' | 'bot', email?: string): Promise<{ id: string }> {
    return this.run(async (tx) => {
      const [r] = await tx<Row[]>`select agent_memory.admin_create_member(${name}, ${kind}, ${email ?? null}) as id`;
      return { id: r.id };
    });
  }

  deactivateMember(name: string): Promise<void> {
    return this.run(async (tx) => {
      await tx`select agent_memory.admin_deactivate_member(${name})`;
    });
  }

  listGrants(f: { scope?: string; member?: string } = {}): Promise<AdminGrant[]> {
    return this.run(async (tx) => {
      const rows = await tx<Row[]>`
        select * from agent_memory.admin_list_grants(${f.scope ?? null}, ${f.member ?? null})`;
      return rows.map((r) => ({
        scope: r.scope,
        member: r.member,
        access: r.access,
        grantedAt: iso(r.granted_at) as string,
        grantedBy: r.granted_by,
      }));
    });
  }

  grant(member: string, scope: string, access: 'read' | 'write'): Promise<void> {
    return this.run(async (tx) => {
      await tx`select agent_memory.admin_grant(${member}, ${scope}, ${access})`;
    });
  }

  /** True if a grant was removed, false if there was none. */
  revoke(member: string, scope: string): Promise<boolean> {
    return this.run(async (tx) => {
      const [r] = await tx<Row[]>`select agent_memory.admin_revoke(${member}, ${scope}) as ok`;
      return r.ok as boolean;
    });
  }

  /** Issues a token. The plaintext is returned once to the caller and never stored or logged; only its hash is. */
  async issueToken(member: string, name: string): Promise<{ id: string; token: string }> {
    const token = generateToken();
    const hash = await hashToken(token);
    const id = await this.run(async (tx) => {
      const [r] = await tx<Row[]>`select agent_memory.admin_issue_token(${member}, ${name}, ${hash}) as id`;
      return r.id as string;
    });
    return { id, token };
  }

  listTokens(member: string): Promise<AdminToken[]> {
    return this.run(async (tx) => {
      const rows = await tx<Row[]>`select * from agent_memory.admin_list_tokens(${member})`;
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: iso(r.created_at) as string,
        lastUsedAt: iso(r.last_used_at),
        revokedAt: iso(r.revoked_at),
      }));
    });
  }

  revokeToken(id: string): Promise<void> {
    return this.run(async (tx) => {
      await tx`select agent_memory.admin_revoke_token(${id})`;
    }, (code) => (code === '22P02' ? new StoreError(`Token ${id} not found`) : undefined));
  }
}
