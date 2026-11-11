-- Round 2, step 2 of 3: Master PIN hash on the account.
-- NOT safe to run twice (SQLite errors if the column already exists).
-- Check first:  npx wrangler d1 execute streamvault-db --remote --command "PRAGMA table_info(accounts);"
-- If a row named pin_hash is already listed, skip this file.
ALTER TABLE accounts ADD COLUMN pin_hash TEXT;
