import type { Embedder } from '../../supabase/functions/_shared/types.ts';

const DIM = 384;

function bucket(word: string): number {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % DIM;
}

/** Deterministic: lowercase words hashed into 384 buckets, L2-normalised. */
export class FakeEmbedder implements Embedder {
  calls = 0;

  embed(text: string): Promise<number[]> {
    this.calls++;
    const v = new Array<number>(DIM).fill(0);
    for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) v[bucket(w)]++;
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return Promise.resolve(v.map((x) => x / norm));
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const t of texts) out.push(await this.embed(t));
    return out;
  }
}
