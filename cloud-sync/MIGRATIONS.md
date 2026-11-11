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
