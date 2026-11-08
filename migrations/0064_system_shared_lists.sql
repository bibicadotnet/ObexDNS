-- Migration 0064: Add System Shared Lists and Two-Tier Filter Architecture

CREATE TABLE IF NOT EXISTS system_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE NOT NULL,
    name TEXT,
    etag TEXT,
    last_modified TEXT,
    last_synced_at INTEGER,
    sync_error TEXT,
    rule_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS system_list_blooms (
    system_list_id INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    bloom_filter_chunk BLOB NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (system_list_id, chunk_index),
    FOREIGN KEY (system_list_id) REFERENCES system_lists(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS system_list_adguard_rules (
    system_list_id INTEGER PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (system_list_id) REFERENCES system_lists(id) ON DELETE CASCADE
);

-- Seed default system lists
INSERT OR IGNORE INTO system_lists (url, name) VALUES
    ('https://lists.bibica.net/blocklists.txt', 'Bibica Blocklists'),
    ('https://lists.bibica.net/whitelist.txt', 'Bibica Whitelist'),
    ('https://lists.bibica.net/rewrites.txt', 'Bibica Rewrites');

-- Cleanup redundant per-profile list_blooms for URLs that are now system lists
DELETE FROM list_blooms WHERE list_id IN (
    SELECT id FROM lists WHERE url IN (
        'https://lists.bibica.net/blocklists.txt',
        'https://lists.bibica.net/whitelist.txt',
        'https://lists.bibica.net/rewrites.txt'
    )
);

DELETE FROM list_adguard_rules WHERE list_id IN (
    SELECT id FROM lists WHERE url IN (
        'https://lists.bibica.net/blocklists.txt',
        'https://lists.bibica.net/whitelist.txt',
        'https://lists.bibica.net/rewrites.txt'
    )
);

