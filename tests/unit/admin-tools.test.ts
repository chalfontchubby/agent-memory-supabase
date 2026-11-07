import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { McpServer } from 'npm:@modelcontextprotocol/server@2.4.0';
import { registerAdminTools } from '../../supabase/functions/_shared/admin-tools.ts';
import type { PgAdminStore } from '../../supabase/functions/_shared/admin-store.ts';
import { StoreError } from '../../supabase/functions/_shared/limits.ts';

const NAMES = [
  'admin_create_member',
  'admin_create_scope',
  'admin_deactivate_member',
  'admin_delete_scope',
  'admin_delete_thread',
  'admin_grant',
  'admin_issue_token',
  'admin_list_grants',
  'admin_list_members',
  'admin_list_scopes',
  'admin_list_tokens',
  'admin_revoke',
  'admin_revoke_token',
];

// deno-lint-ignore no-explicit-any
type Calls = Record<string, any[][]>;
type Reg = Record<string, {
  description?: string;
  inputSchema?: unknown;
  // deno-lint-ignore no-explicit-any
  handler: (args: any, ctx?: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
}>;

function setup(fail?: Error) {
  const calls: Calls = {};
  const rec = (n: string, ...a: unknown[]) => {
    (calls[n] ??= []).push(a);
    return fail ? Promise.reject(fail) : Promise.resolve();
  };
  const store = {
    listScopes: () => rec('listScopes').then(() => [{ name: 's' }]),
    createScope: (...a: unknown[]) => rec('createScope', ...a).then(() => ({ id: 'x' })),
    deleteScope: (...a: unknown[]) => rec('deleteScope', ...a),
    deleteThread: (...a: unknown[]) => rec('deleteThread', ...a),
    listMembers: () => rec('listMembers').then(() => []),
    createMember: (...a: unknown[]) => rec('createMember', ...a).then(() => ({ id: 'x' })),
    deactivateMember: (...a: unknown[]) => rec('deactivateMember', ...a),
    listGrants: (...a: unknown[]) => rec('listGrants', ...a).then(() => []),
    grant: (...a: unknown[]) => rec('grant', ...a),
    revoke: (...a: unknown[]) => rec('revoke', ...a).then(() => true),
    issueToken: (...a: unknown[]) => rec('issueToken', ...a).then(() => ({ id: 'tid', token: 'amm_secret' })),
    listTokens: (...a: unknown[]) => rec('listTokens', ...a).then(() => []),
    revokeToken: (...a: unknown[]) => rec('revokeToken', ...a),
  } as unknown as PgAdminStore;
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerAdminTools(server, store);
  const reg = (server as unknown as { _registeredTools: Reg })._registeredTools;
  return { reg, calls };
}

Deno.test('registerAdminTools registers exactly the 13 admin tools, each described as Admin:', () => {
  const { reg } = setup();
  assertEquals(Object.keys(reg).sort(), NAMES);
  for (const n of NAMES) assert(reg[n].description?.startsWith('Admin:'), `${n} description`);
});

Deno.test('admin_issue_token description says shown once and not stored', () => {
  const d = setup().reg.admin_issue_token.description ?? '';
  assertStringIncludes(d, 'shown once');
  assertStringIncludes(d, 'not stored');
});

Deno.test('admin_deactivate_member description names the consequences', () => {
  const d = setup().reg.admin_deactivate_member.description ?? '';
  assertStringIncludes(d, 'revokes all tokens and grants');
  assertStringIncludes(d, 'shell');
});

Deno.test('admin_issue_token result carries the note and the token', async () => {
  const { reg, calls } = setup();
  const r = await reg.admin_issue_token.handler({ member: 'm', name: 'laptop' }, {});
  assertEquals(calls.issueToken, [['m', 'laptop']]);
  assertEquals(JSON.parse(r.content[0].text), {
    member: 'm',
    name: 'laptop',
    id: 'tid',
    token: 'amm_secret',
    note: 'Shown once - give it to the member privately; it is not stored and cannot be shown again.',
  });
});

Deno.test('create_member kind defaults to human', async () => {
  const { reg, calls } = setup();
  await reg.admin_create_member.handler({ name: 'n' }, {});
  assertEquals(calls.createMember, [['n', 'human', undefined]]);
});

Deno.test('list_grants passes optional filters', async () => {
  const { reg, calls } = setup();
  await reg.admin_list_grants.handler({ scope: 's' }, {});
  assertEquals(calls.listGrants, [[{ scope: 's', member: undefined }]]);
});

Deno.test('a store error becomes isError with the message verbatim, and never echoes a token', async () => {
  const { reg } = setup(new StoreError("Member 'x' is an admin; manage admins from the shell"));
  for (
    const [n, args] of Object.entries<Record<string, unknown>>({
      admin_list_scopes: {},
      admin_create_scope: { name: 'a' },
      admin_delete_scope: { name: 'a' },
      admin_list_members: {},
      admin_create_member: { name: 'a' },
      admin_deactivate_member: { name: 'a' },
      admin_list_grants: {},
      admin_grant: { member: 'm', scope: 's', access: 'read' },
      admin_revoke: { member: 'm', scope: 's' },
      admin_issue_token: { member: 'm', name: 't' },
      admin_list_tokens: { member: 'm' },
      admin_revoke_token: { id: 'i' },
    })
  ) {
    const r = await reg[n].handler(args, {});
    assertEquals(r.isError, true, n);
    assertEquals(r.content[0].text, "Member 'x' is an admin; manage admins from the shell", n);
  }
});

Deno.test('admin_create_member rejects blank or padded names and accepts a clean one', () => {
  const { reg } = setup();
  const schema = reg.admin_create_member.inputSchema as unknown as {
    safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } };
  };
  const msg = "Member names can't be blank or start or end with a space";
  for (const bad of ['', 'alice ', ' alice', '   ']) {
    const r = schema.safeParse({ name: bad });
    assertEquals(r.success, false, JSON.stringify(bad));
    assert(r.error!.issues.some((i) => i.message === msg), JSON.stringify(bad));
  }
  for (const good of ['alice', 'a', 'alice smith']) {
    assertEquals(schema.safeParse({ name: good }).success, true, good);
  }
});

Deno.test('admin_delete_thread is registered and calls deleteThread', async () => {
  const { reg, calls } = setup();
  const id = '11111111-1111-4111-8111-111111111111';
  const r = await reg.admin_delete_thread.handler({ thread_id: id }, {});
  assertEquals(calls.deleteThread, [[id]]);
  assertEquals(JSON.parse(r.content[0].text), { deleted: id });
  const bad = await reg.admin_delete_thread.handler({ thread_id: 'x' }, {});
  assertEquals(bad.isError, true);
  assertEquals(bad.content[0].text, 'Thread x not found');
  assertEquals(calls.deleteThread.length, 1);
});
