-- Round 7: every index costs one extra "row written" on each upload and the daily free allowance is 100,000.
-- idx_catalog_acc_dedup: item_id already is account_id + ':' + dedup_key, so the primary key does this job.
-- idx_catalog_removed: only the (never called) purge uses it.
-- idx_tmdb_cache_expires: nothing reads the cache by expiry.
DROP INDEX IF EXISTS idx_catalog_acc_dedup;
DROP INDEX IF EXISTS idx_catalog_removed;
DROP INDEX IF EXISTS idx_tmdb_cache_expires;
