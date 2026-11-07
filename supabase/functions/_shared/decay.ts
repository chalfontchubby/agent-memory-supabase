import type { Memory, SearchResult } from './types.ts';

// Exponential decay based on memory age. Half-life (days) comes from env
// MEMORY_DECAY_HALF_LIFE, default 30; <= 0 or non-numeric disables.
// Memories tagged "evergreen" or "never-forget" are exempt.

export const EVERGREEN_TAGS: ReadonlySet<string> = new Set(['evergreen', 'never-forget']);
const MS_PER_DAY = 86_400_000;

export function parseDecayHalfLife(v: string | undefined): number {
  if (v == null) return 30;
  const parsed = Number(v);
  if (isNaN(parsed) || parsed <= 0) return 0;
  return parsed;
}

export function computeDecayFactor(updatedAt: string, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1;
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  const ageDays = Math.max(0, ageMs / MS_PER_DAY);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** Importance multiplier, 1.0 (never accessed, old) to 3.0 (heavily accessed, recent). */
export function importanceMultiplier(
  m: { accessCount: number; lastAccessedAt: string | null; updatedAt: string },
): number {
  const lastAccessedAt = m.lastAccessedAt ?? m.updatedAt;
  const accessBoost = 1 + Math.min(m.accessCount, 20) / 20;
  const daysSinceAccess = Math.max(0, (Date.now() - new Date(lastAccessedAt).getTime()) / MS_PER_DAY);
  const recencyBoost = daysSinceAccess < 7 ? 1.5 : daysSinceAccess < 30 ? 1.2 : 1.0;
  return accessBoost * recencyBoost;
}

export function isEvergreen(tags: string[]): boolean {
  return tags.some((t) => EVERGREEN_TAGS.has(t));
}

export interface DecayInput {
  memory: Memory;
  rawScore: number;
  accessCount: number;
  lastAccessedAt: string | null;
}

/** Apply importance-modulated decay, re-sort descending, trim to `limit`. */
export function applyDecay(rows: DecayInput[], limit: number, halfLifeDays: number): SearchResult[] {
  return rows
    .map((r): SearchResult => {
      let score = r.rawScore;
      if (halfLifeDays > 0 && !isEvergreen(r.memory.tags)) {
        const effective = halfLifeDays * importanceMultiplier({
          accessCount: r.accessCount,
          lastAccessedAt: r.lastAccessedAt,
          updatedAt: r.memory.updatedAt,
        });
        score *= computeDecayFactor(r.memory.updatedAt, effective);
      }
      return { memory: r.memory, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
