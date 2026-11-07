import { z } from 'npm:zod@4.6.7';
import type { McpServer } from 'npm:@modelcontextprotocol/server@2.4.0';
import type { PgAdminStore } from './admin-store.ts';
import { failure, success } from './tools.ts';

const ISSUE_NOTE = 'Shown once - give it to the member privately; it is not stored and cannot be shown again.';

/** Run an admin action; its StoreError text is returned as is, so admins see the exact rule. */
async function guard(fn: () => Promise<unknown>) {
  try {
    return success(await fn());
  } catch (e) {
    return failure(e);
  }
}

/** Registers the 12 admin tools. Register them for admins only. */
export function registerAdminTools(server: McpServer, admin: PgAdminStore): void {
  server.registerTool('admin_list_scopes', {
    description:
      'Admin: List every scope with its description, live and deleted memory counts, and how many members can read and write it.',
    inputSchema: z.object({}),
  }, () => guard(async () => ({ scopes: await admin.listScopes() })));

  server.registerTool('admin_create_scope', {
    description:
      'Admin: Create a scope. Names are lowercase letters, digits and hyphens, starting with a letter or digit (max 63).',
    inputSchema: z.object({
      name: z.string().describe('Scope name'),
      description: z.string().optional().describe('What the scope is for'),
    }),
  }, ({ name, description }) =>
    guard(async () => {
      await admin.createScope(name, description);
      return { created: name };
    }));

  server.registerTool('admin_delete_scope', {
    description: 'Admin: Delete an empty scope. Refused while it still holds memories.',
    inputSchema: z.object({ name: z.string().describe('Scope name') }),
  }, ({ name }) =>
    guard(async () => {
      await admin.deleteScope(name);
      return { deleted: name };
    }));

  server.registerTool('admin_list_members', {
    description: 'Admin: List every member with kind, email, admin and deactivated flags, and live token count.',
    inputSchema: z.object({}),
  }, () => guard(async () => ({ members: await admin.listMembers() })));

  server.registerTool('admin_create_member', {
    description:
      'Admin: Create a member (human or bot). Members start with no grants and no tokens; use admin_grant and admin_issue_token next. Admins can only be made from the shell.',
    inputSchema: z.object({
      name: z.string().describe('Member name'),
      kind: z.enum(['human', 'bot']).default('human').describe('human (default) or bot'),
      email: z.string().optional().describe('Email, to link a Supabase login (optional)'),
    }),
  }, ({ name, kind, email }) =>
    guard(async () => {
      await admin.createMember(name, kind ?? 'human', email);
      return { created: name, kind: kind ?? 'human' };
    }));

  server.registerTool('admin_deactivate_member', {
    description:
      'Admin: Deactivate a member. This revokes all tokens and grants, and is undone only from the shell. Their memories are kept.',
    inputSchema: z.object({ name: z.string().describe('Member name') }),
  }, ({ name }) =>
    guard(async () => {
      await admin.deactivateMember(name);
      return { deactivated: name };
    }));

  server.registerTool('admin_list_grants', {
    description: 'Admin: List scope grants, optionally filtered by scope and/or member.',
    inputSchema: z.object({
      scope: z.string().optional().describe('Only grants on this scope'),
      member: z.string().optional().describe('Only grants held by this member'),
    }),
  }, ({ scope, member }) => guard(async () => ({ grants: await admin.listGrants({ scope, member }) })));

  server.registerTool('admin_grant', {
    description: 'Admin: Grant a member read or write access to a scope, replacing any existing grant.',
    inputSchema: z.object({
      member: z.string().describe('Member name'),
      scope: z.string().describe('Scope name'),
      access: z.enum(['read', 'write']).describe('read or write'),
    }),
  }, ({ member, scope, access }) =>
    guard(async () => {
      await admin.grant(member, scope, access);
      return { member, scope, access };
    }));

  server.registerTool('admin_revoke', {
    description: "Admin: Remove a member's grant on a scope. Reports whether there was one to remove.",
    inputSchema: z.object({
      member: z.string().describe('Member name'),
      scope: z.string().describe('Scope name'),
    }),
  }, ({ member, scope }) =>
    guard(async () => {
      const revoked = await admin.revoke(member, scope);
      return { member, scope, revoked };
    }));

  server.registerTool('admin_issue_token', {
    description:
      'Admin: Issue an access token for a member. The token is shown once in the result and is not stored; it cannot be shown again, so pass it to the member privately.',
    inputSchema: z.object({
      member: z.string().describe('Member name'),
      name: z.string().describe('A label for the token, e.g. the device'),
    }),
  }, ({ member, name }) =>
    guard(async () => {
      const { id, token } = await admin.issueToken(member, name);
      return { member, name, id, token, note: ISSUE_NOTE };
    }));

  server.registerTool('admin_list_tokens', {
    description: "Admin: List a member's tokens (id, name, created, last used, revoked). Token values are never shown.",
    inputSchema: z.object({ member: z.string().describe('Member name') }),
  }, ({ member }) => guard(async () => ({ member, tokens: await admin.listTokens(member) })));

  server.registerTool('admin_revoke_token', {
    description: 'Admin: Revoke a token by id (from admin_list_tokens).',
    inputSchema: z.object({ id: z.string().describe('Token id') }),
  }, ({ id }) =>
    guard(async () => {
      await admin.revokeToken(id);
      return { revoked: id };
    }));
}
