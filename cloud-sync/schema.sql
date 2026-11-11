-- ====================================================================
-- StreamVault TV Cloud Sync Schema (Cloudflare D1 SQLite)
-- Fully Standalone Accounts, Playlists, Profiles & Catalog Cache
-- ====================================================================

-- 1. Accounts (Owners of sign-in, playlists, enriched catalog)
CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  pin_hash TEXT,
  is_verified INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 2. Sessions (Random 32-byte tokens stored hashed, revocable on sign-out)
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);

-- 3. Email Verification Codes (Single-use, 10-minute expiry, attempt-limited)
CREATE TABLE IF NOT EXISTS email_codes (
  code_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  purpose TEXT DEFAULT 'verify_email',
  attempts INTEGER DEFAULT 0,
  is_used INTEGER DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_codes_lookup ON email_codes(email, code, is_used);

-- 4. IPTV Playlists (Content sources; many per account, replaceable anytime)
CREATE TABLE IF NOT EXISTS playlists (
  playlist_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  server_url TEXT NOT NULL,
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL, -- Encrypted at rest via AES-256-GCM Worker secret
  is_enabled INTEGER DEFAULT 1,
  status TEXT DEFAULT 'ready', -- 'ready', 'syncing', 'error'
  last_sync_at INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  removed_at INTEGER DEFAULT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_playlists_acc ON playlists(account_id);

-- 5. Catalog Items (Enriched catalog synced to cloud as backup / cross-device copy)
CREATE TABLE IF NOT EXISTS catalog_items (
  item_id TEXT PRIMARY KEY, -- account_id + ':' + dedup_key
  account_id TEXT NOT NULL,
  playlist_id TEXT,
  dedup_key TEXT NOT NULL,
  media_type TEXT NOT NULL, -- 'MOVIE' or 'SERIES'
  title TEXT NOT NULL,
  clean_title TEXT NOT NULL,
  year INTEGER,
  tmdb_id INTEGER,
  overview TEXT,
  poster_path TEXT,
  backdrop_path TEXT,
  rating REAL DEFAULT 0,
  runtime_mins INTEGER DEFAULT 0,
  genres_json TEXT,
  versions_json TEXT,
  episodes_json TEXT,
  is_adult INTEGER DEFAULT 0,
  is_removed INTEGER DEFAULT 0,
  removed_at INTEGER DEFAULT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_catalog_acc_upd ON catalog_items(account_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_catalog_acc_dedup ON catalog_items(account_id, dedup_key);
CREATE INDEX IF NOT EXISTS idx_catalog_removed ON catalog_items(is_removed, removed_at);

-- 6. Shared TMDB Cache (Shared across all accounts so subsequent enrichments hit cache)
CREATE TABLE IF NOT EXISTS tmdb_cache (
  cache_key TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  tmdb_id INTEGER,
  query TEXT,
  year INTEGER,
  response_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tmdb_cache_expires ON tmdb_cache(expires_at);

-- 7. User Profiles (Personal settings, preferences; primary profile can't be deleted)
CREATE TABLE IF NOT EXISTS profiles (
  profile_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_color TEXT DEFAULT '#8B5CF6',
  theme TEXT DEFAULT 'StreamVault Purple',
  is_kids INTEGER DEFAULT 0,
  is_primary INTEGER DEFAULT 0,
  pin_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_profiles_acc ON profiles(account_id);

-- 8. Profile Personal Data (Continue watching, ratings, watchlist, search history)
-- Keyed by TMDB id / universal dedup key so IPTV credential swaps never lose data!
CREATE TABLE IF NOT EXISTS profile_data (
  profile_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  data_type TEXT NOT NULL, -- 'progress', 'watchlist', 'ratings', 'searches', 'settings'
  item_key TEXT NOT NULL,  -- Universal dedupKey or 'list'
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, data_type, item_key),
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_profile_data_acc ON profile_data(account_id, updated_at);

-- 9. Pairing Codes (Crypto-random, single use, one-time exchange token)
CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  device_id TEXT,
  account_id TEXT,
  exchange_token TEXT,
  status TEXT DEFAULT 'pending', -- 'pending', 'claimed', 'exchanged', 'expired'
  attempts INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pairing_codes_status ON pairing_codes(code, status);

-- 10. Rate Limits (Key, count, reset_at)
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON rate_limits(reset_at);
