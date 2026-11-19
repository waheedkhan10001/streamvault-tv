-- Migration 0005: Scope profile_data PRIMARY KEY to (account_id, profile_id, data_type, item_key).
-- Prevents cross-account profile_data overwrite collisions while preserving existing data.
-- Idempotent and safe on both minimal test databases and production D1 instances.

CREATE TABLE IF NOT EXISTS profile_data (
  profile_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  data_type TEXT NOT NULL,
  item_key TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, profile_id, data_type, item_key),
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS profile_data_v2 (
  profile_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  data_type TEXT NOT NULL,
  item_key TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, profile_id, data_type, item_key),
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO profile_data_v2 (profile_id, account_id, data_type, item_key, data_json, updated_at)
SELECT profile_id, account_id, data_type, item_key, data_json, updated_at FROM profile_data;

DROP TABLE profile_data;
ALTER TABLE profile_data_v2 RENAME TO profile_data;
CREATE INDEX IF NOT EXISTS idx_profile_data_acc ON profile_data(account_id, updated_at);
