-- Remove Bloom filter columns from profiles table (deprecating migration 0005 approach)
-- SQLite doesn't support DROP COLUMN, so we recreate the table
CREATE TABLE profiles_temp (
    id TEXT PRIMARY KEY,
    owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    settings TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_active_at INTEGER
);

INSERT INTO profiles_temp SELECT id, owner_id, name, settings, created_at, updated_at, last_active_at FROM profiles;

DROP TABLE profiles;
ALTER TABLE profiles_temp RENAME TO profiles;

CREATE INDEX IF NOT EXISTS idx_profiles_owner ON profiles(owner_id);
