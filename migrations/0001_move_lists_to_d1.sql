-- Migration to move external list data from KV to D1
CREATE TABLE IF NOT EXISTS list_entries (
    profile_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    PRIMARY KEY (profile_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_list_entries_profile ON list_entries(profile_id);

-- We also need a way to store the Bloom Filter and sync metadata in D1
ALTER TABLE profiles ADD COLUMN list_bloom BLOB;
ALTER TABLE profiles ADD COLUMN list_updated_at INTEGER;
