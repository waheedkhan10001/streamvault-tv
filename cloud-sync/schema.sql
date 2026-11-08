-- StreamVault TV Cloud Sync Schema (Cloudflare D1 SQLite)

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  password_hash TEXT,
  iptv_server_url TEXT,
  iptv_username TEXT,
  iptv_password TEXT,
  playlist_name TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS tv_codes (
  code TEXT PRIMARY KEY,
  device_id TEXT,
  account_id TEXT,
  status TEXT DEFAULT 'pending', -- 'pending', 'claimed', 'expired'
  created_at INTEGER,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS profiles (
  profile_id TEXT PRIMARY KEY,
  account_id TEXT,
  display_name TEXT,
  avatar_color TEXT,
  is_kids INTEGER DEFAULT 0,
  pin TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS user_sync_data (
  profile_id TEXT,
  data_type TEXT, -- 'progress', 'watchlist', 'ratings', 'searches'
  data_json TEXT,
  updated_at INTEGER,
  PRIMARY KEY (profile_id, data_type)
);
