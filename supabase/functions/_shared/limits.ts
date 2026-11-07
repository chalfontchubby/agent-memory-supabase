/** Max memories per store_batch call (CPU budget ~1 s per request). */
export const STORE_BATCH_MAX = 2;
/** Max topics embedded per recall call. */
export const RECALL_EMBED_TOPICS_MAX = 5;
export const DEFAULT_LIMIT = 10;
/** The store passes `limit * OVER_FETCH_FACTOR` to SQL and trims after decay. */
export const OVER_FETCH_FACTOR = 3;
/** Documentation only: the SQL search functions hard-code k = 60. */
export const RRF_K = 60;
export const ACCESS_TOUCH_INTERVAL_HOURS = 1;
