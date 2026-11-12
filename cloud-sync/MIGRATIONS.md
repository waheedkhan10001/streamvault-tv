# D1 migrations (Round 2)

The deployed D1 database (`streamvault-db`) was created from an older `schema.sql`.
Editing `schema.sql` does NOT change an existing database, so these three steps bring
it up to date. Until they are run, the Worker cannot rate-limit and cannot store the
Master PIN. **Run them BEFORE deploying the new Worker.**

Run from the `cloud-sync/` folder (needs `npx wrangler login` once):

1. Look at what the live database already has:

       npx wrangler d1 execute streamvault-db --remote --command "PRAGMA table_info(accounts);"

   Note whether `pin_hash` and `pin_salt` appear in the list.

2. Apply the migrations:

       npx wrangler d1 migrations apply streamvault-db --remote

   Wrangler runs each file once, in order, and remembers which ones ran.
   If step 1 showed `pin_hash` (or `pin_salt`) already exists, stop and ask first;
   that file must be skipped, not forced.

3. Confirm:

       npx wrangler d1 execute streamvault-db --remote --command "PRAGMA table_info(accounts);"
       npx wrangler d1 execute streamvault-db --remote --command "SELECT name FROM sqlite_master WHERE name = 'rate_limits';"

   `pin_hash`, `pin_salt` and `rate_limits` must all be present.

Fresh databases do not need this: `schema.sql` already contains everything.

# Round 7 — saving the free daily write allowance (migration 0004 + Worker deploy)

Order matters: **back up, migrate, then deploy.** Run from the `cloud-sync/` folder.

1. Back up the database (a safety copy file on your computer):

       npx wrangler d1 export streamvault-db --remote --output=streamvault-backup.sql

2. Apply the migration (only drops three extra indexes; no data is touched):

       npx wrangler d1 migrations apply streamvault-db --remote

3. Deploy the Worker:

       npx wrangler deploy

4. Check it: this must list `idx_catalog_acc_upd` and must NOT list `idx_catalog_acc_dedup`, `idx_catalog_removed` or `idx_tmdb_cache_expires`:

       npx wrangler d1 execute streamvault-db --remote --command "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('catalog_items','tmdb_cache');"

If anything looks wrong after step 3, the backup file from step 1 restores the data, and the previous Worker can be re-deployed from the previous commit.
