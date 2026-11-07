CREATE TABLE IF NOT EXISTS profile_blooms (
  profile_id TEXT PRIMARY KEY,
  bloom_filter BLOB,
  updated_at INTEGER NOT NULL
);
