import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import {
  applyDecay,
  computeDecayFactor,
  type DecayInput,
  EVERGREEN_TAGS,
  importanceMultiplier,
  isEvergreen,
  parseDecayHalfLife,
} from '../../supabase/functions/_shared/decay.ts';
import type { Memory } from '../../supabase/functions/_shared/types.ts';

const MS_PER_DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * MS_PER_DAY).toISOString();

// parseDecayHalfLife
Deno.test('parseDecayHalfLife returns 30 when undefined', () => {
  assertEquals(parseDecayHalfLife(undefined), 30);
});
Deno.test('parseDecayHalfLife parses a valid number string', () => {
  assertEquals(parseDecayHalfLife('60'), 60);
  assertEquals(parseDecayHalfLife('7'), 7);
  assertEquals(parseDecayHalfLife('365'), 365);
});
Deno.test('parseDecayHalfLife returns 0 for zero', () => {
  assertEquals(parseDecayHalfLife('0'), 0);
});
Deno.test('parseDecayHalfLife returns 0 for negative values', () => {
  assertEquals(parseDecayHalfLife('-10'), 0);
  assertEquals(parseDecayHalfLife('-1'), 0);
});
Deno.test('parseDecayHalfLife returns 0 for non-numeric strings', () => {
  assertEquals(parseDecayHalfLife('abc'), 0);
  assertEquals(parseDecayHalfLife(''), 0);
});
Deno.test('parseDecayHalfLife handles fractional values', () => {
  assertEquals(parseDecayHalfLife('0.5'), 0.5);
  assertEquals(parseDecayHalfLife('14.5'), 14.5);
});

// computeDecayFactor
Deno.test('computeDecayFactor 1.0 for a memory updated just now', () => {
  assertAlmostEquals(computeDecayFactor(new Date().toISOString(), 30), 1.0, 0.005);
});
Deno.test('computeDecayFactor ~0.5 at one half-life', () => {
  assertAlmostEquals(computeDecayFactor(ago(30), 30), 0.5, 0.005);
});
Deno.test('computeDecayFactor ~0.25 at two half-lives', () => {
  assertAlmostEquals(computeDecayFactor(ago(60), 30), 0.25, 0.005);
});
Deno.test('computeDecayFactor ~0.125 at three half-lives', () => {
  assertAlmostEquals(computeDecayFactor(ago(90), 30), 0.125, 0.005);
});
Deno.test('computeDecayFactor 1.0 when half-life is 0', () => {
  assertEquals(computeDecayFactor(ago(365), 0), 1);
});
Deno.test('computeDecayFactor 1.0 when half-life is negative', () => {
  assertEquals(computeDecayFactor(ago(365), -5), 1);
});
Deno.test('computeDecayFactor handles a short half-life (7 days)', () => {
  assertAlmostEquals(computeDecayFactor(ago(7), 7), 0.5, 0.005);
});
Deno.test('computeDecayFactor handles a long half-life (365 days)', () => {
  // 30/365 ≈ 0.082 half-lives → 2^(-0.082) ≈ 0.945
  assertAlmostEquals(computeDecayFactor(ago(30), 365), 0.945, 0.005);
});
Deno.test('computeDecayFactor never goes below 0', () => {
  assert(computeDecayFactor(ago(3650), 30) >= 0);
});
Deno.test('computeDecayFactor clamps future dates to 1.0', () => {
  assertAlmostEquals(computeDecayFactor(new Date(Date.now() + MS_PER_DAY).toISOString(), 30), 1.0, 0.000005);
});

// EVERGREEN_TAGS
Deno.test('EVERGREEN_TAGS includes evergreen and never-forget', () => {
  assert(EVERGREEN_TAGS.has('evergreen'));
  assert(EVERGREEN_TAGS.has('never-forget'));
});
Deno.test('EVERGREEN_TAGS does not include arbitrary tags', () => {
  assert(!EVERGREEN_TAGS.has('important'));
  assert(!EVERGREEN_TAGS.has('learning'));
});
Deno.test('isEvergreen checks tags', () => {
  assert(isEvergreen(['x', 'evergreen']));
  assert(!isEvergreen(['x']));
});

// importanceMultiplier
Deno.test('importanceMultiplier 1.0 for never-accessed, old last access', () => {
  const d = ago(60);
  assertEquals(importanceMultiplier({ accessCount: 0, lastAccessedAt: d, updatedAt: d }), 1.0);
});
Deno.test('importanceMultiplier 2.0 for max access count, old last access', () => {
  const d = ago(60);
  assertAlmostEquals(importanceMultiplier({ accessCount: 20, lastAccessedAt: d, updatedAt: d }), 2.0, 0.05);
});
Deno.test('importanceMultiplier 3.0 for max access count, very recent access', () => {
  assertAlmostEquals(
    importanceMultiplier({ accessCount: 20, lastAccessedAt: new Date().toISOString(), updatedAt: ago(60) }),
    3.0,
    0.05,
  );
});
Deno.test('importanceMultiplier caps access boost at 20 accesses', () => {
  const d = ago(60);
  assertEquals(
    importanceMultiplier({ accessCount: 20, lastAccessedAt: d, updatedAt: d }),
    importanceMultiplier({ accessCount: 100, lastAccessedAt: d, updatedAt: d }),
  );
});
Deno.test('importanceMultiplier 1.5x recency boost within 7 days', () => {
  const d = ago(3);
  assertAlmostEquals(importanceMultiplier({ accessCount: 0, lastAccessedAt: d, updatedAt: d }), 1.5, 0.05);
});
Deno.test('importanceMultiplier 1.2x recency boost within 30 days', () => {
  const d = ago(15);
  assertAlmostEquals(importanceMultiplier({ accessCount: 0, lastAccessedAt: d, updatedAt: d }), 1.2, 0.05);
});
Deno.test('importanceMultiplier no recency boost older than 30 days', () => {
  const d = ago(60);
  assertEquals(importanceMultiplier({ accessCount: 0, lastAccessedAt: d, updatedAt: d }), 1.0);
});
Deno.test('importanceMultiplier zero access count, lastAccessedAt falls back to updatedAt (recent)', () => {
  // accessBoost = 1.0, recencyBoost = 1.5
  assertAlmostEquals(
    importanceMultiplier({ accessCount: 0, lastAccessedAt: null, updatedAt: new Date().toISOString() }),
    1.5,
    0.05,
  );
});
Deno.test('importanceMultiplier null lastAccessedAt falls back to updatedAt (old)', () => {
  // accessBoost = 1 + 5/20 = 1.25, recencyBoost = 1.0
  assertAlmostEquals(importanceMultiplier({ accessCount: 5, lastAccessedAt: null, updatedAt: ago(60) }), 1.25, 0.005);
});
Deno.test('importanceMultiplier combines access and recency multiplicatively', () => {
  const d = ago(3);
  // 1.5 * 1.5
  assertAlmostEquals(importanceMultiplier({ accessCount: 10, lastAccessedAt: d, updatedAt: d }), 2.25, 0.05);
});

// applyDecay
function row(id: string, rawScore: number, updatedAt: string, tags: string[] = []): DecayInput {
  const memory: Memory = {
    id,
    scope: 's',
    content: id,
    category: 'other',
    tags,
    createdAt: updatedAt,
    updatedAt,
    createdBy: 'a',
    updatedBy: 'a',
  };
  return { memory, rawScore, accessCount: 0, lastAccessedAt: updatedAt };
}

Deno.test('applyDecay evergreen row keeps raw score', () => {
  const [r] = applyDecay([row('e', 0.8, ago(365), ['evergreen'])], 10, 30);
  assertEquals(r.score, 0.8);
});
Deno.test('applyDecay re-sorts: fresh lower-raw beats old higher-raw', () => {
  const out = applyDecay([row('old', 1.0, ago(90)), row('fresh', 0.5, new Date().toISOString())], 10, 30);
  assertEquals(out.map((r) => r.memory.id), ['fresh', 'old']);
});
Deno.test('applyDecay trims to limit', () => {
  const now = new Date().toISOString();
  const out = applyDecay([row('a', 0.3, now), row('b', 0.2, now), row('c', 0.1, now)], 2, 30);
  assertEquals(out.length, 2);
});
Deno.test('applyDecay disabled half-life keeps raw scores', () => {
  const [r] = applyDecay([row('x', 0.7, ago(365))], 10, 0);
  assertEquals(r.score, 0.7);
});
