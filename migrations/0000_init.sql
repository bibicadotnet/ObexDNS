-- Profiles table
CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY, -- 6-char alphanumeric ID
    name TEXT NOT NULL,
    settings TEXT NOT NULL, -- JSON object: { upstream, ecs, log_retention, default_policy }
    owner_id TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    hashed_password TEXT NOT NULL,
    role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
    created_at INTEGER NOT NULL
);

-- Sessions table (Lucia v3 requirement)
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Custom Rules table
CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL,
    type TEXT CHECK(type IN ('ALLOW', 'BLOCK', 'REDIRECT')) NOT NULL,
    pattern TEXT NOT NULL, -- Domain or wildcard
    value TEXT, -- legacy redirect value (optional)
    record_type TEXT DEFAULT 'A',
    v_a TEXT,
    v_aaaa TEXT,
    v_txt TEXT,
    v_cname TEXT,
    priority INTEGER DEFAULT 0,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- External Blocklists subscriptions
CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL,
    url TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    last_synced_at INTEGER,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- Resolution Logs table
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL, -- Unix timestamp
    client_ip TEXT,
    geo_country TEXT, -- ISO 3166-1 alpha-2
    domain TEXT NOT NULL,
    record_type TEXT NOT NULL,
    action TEXT CHECK(action IN ('PASS', 'BLOCK', 'REDIRECT', 'FAIL')) NOT NULL,
    reason TEXT, -- Rule ID or List Name
    answer TEXT,
    dest_geoip TEXT,
    ecs TEXT,
    upstream TEXT,
    latency INTEGER,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_rules_profile ON rules(profile_id);
CREATE INDEX IF NOT EXISTS idx_lists_profile ON lists(profile_id);
CREATE INDEX IF NOT EXISTS idx_logs_profile_time ON logs(profile_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_domain ON logs(domain);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_owner ON profiles(owner_id);
