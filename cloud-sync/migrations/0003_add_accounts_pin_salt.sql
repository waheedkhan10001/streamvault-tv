-- Round 2, step 3 of 3: salt that belongs to pin_hash, so a PIN created on one TV
-- also verifies on a second TV.
-- NOT safe to run twice. Skip if PRAGMA table_info(accounts) already lists pin_salt.
ALTER TABLE accounts ADD COLUMN pin_salt TEXT;
