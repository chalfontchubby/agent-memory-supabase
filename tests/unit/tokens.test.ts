import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { generateToken, hashToken, looksLikeToken } from '../../supabase/functions/_shared/tokens.ts';

Deno.test('generateToken matches looksLikeToken', () => {
  assert(looksLikeToken(generateToken()));
});

Deno.test('two tokens differ', () => {
  assertNotEquals(generateToken(), generateToken());
});

Deno.test('looksLikeToken rejects malformed input', () => {
  assert(!looksLikeToken('amm_short'));
  assert(!looksLikeToken('x'.repeat(47)));
});

Deno.test('hashToken known value', async () => {
  assertEquals(await hashToken('amm_x'), '649bc2545bdb67084a8ee82d60fb01e1b67025f7b5cdec3755e1fa722c410eb1');
});

Deno.test('hash is 64 lowercase hex chars', async () => {
  assert(/^[0-9a-f]{64}$/.test(await hashToken(generateToken())));
});
