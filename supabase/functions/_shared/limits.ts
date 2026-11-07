/** Max memories per store_batch call (CPU budget ~1 s per request). */
export const STORE_BATCH_MAX = 2;
/** Max topics embedded per recall call. */
export const RECALL_EMBED_TOPICS_MAX = 5;
export const DEFAULT_LIMIT = 10;
/** Upper bound for every result limit (search, find_related, list_recent, recall). */
export const MAX_LIMIT = 100;
/** Longest memory content accepted by store, store_batch, update, /embed and import. */
export const MAX_CONTENT_CHARS = 20_000;
/** The store passes `limit * OVER_FETCH_FACTOR` to SQL and trims after decay. */
export const OVER_FETCH_FACTOR = 3;
/** Documentation only: the SQL search functions hard-code k = 60. */
export const RRF_K = 60;
export const ACCESS_TOUCH_INTERVAL_HOURS = 1;
/** Prune defaults, shared by prune and stats.belowPruneThreshold. */
export const PRUNE_MIN_STRENGTH_DEFAULT = 0.05;
export const PRUNE_MAX_DORMANT_DAYS_DEFAULT = 90;

/** A caller error whose message is safe to show the agent as-is. */
export class StoreError extends Error {}

/** Every result limit is an integer in 1..MAX_LIMIT. */
export function checkLimit(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new StoreError(`limit must be between 1 and ${MAX_LIMIT}`);
  }
}

/** Rejects content over MAX_CONTENT_CHARS; call before embedding. */
export function checkContent(content: string): void {
  if (content.length > MAX_CONTENT_CHARS) {
    throw new StoreError(`content too long (max ${MAX_CONTENT_CHARS} characters)`);
  }
}
