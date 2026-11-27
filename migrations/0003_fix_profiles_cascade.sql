-- Fix profiles foreign key to support ON DELETE CASCADE
-- 1. Create a temporary table with the correct constraint
CREATE TABLE profiles_new (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    settings TEXT NOT NULL,
    owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_active_at INTEGER
);

-- 2. Copy data from old table
INSERT INTO profiles_new SELECT id, name, settings, owner_id, created_at, updated_at, last_active_at FROM profiles;

-- 3. Drop old table and rename new one
DROP TABLE profiles;
ALTER TABLE profiles_new RENAME TO profiles;

-- 4. Re-create indexes for the new table
CREATE INDEX IF NOT EXISTS idx_profiles_owner ON profiles(owner_id);
