-- Add pin_hash to users
ALTER TABLE users ADD COLUMN pin_hash TEXT;

-- Add is_paused to sessions
ALTER TABLE sessions ADD COLUMN is_paused INTEGER DEFAULT 0;

-- Recreate user_activity_log to support pin_verify_success and pin_verify_fail check constraints
CREATE TABLE IF NOT EXISTS user_activity_log_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN (
        'signup', 'login_success', 'login_fail', 'logout',
        'password_change_success', 'password_change_fail',
        'totp_verify_success', 'totp_verify_fail',
        'totp_setup', 'totp_removed',
        'recovery_key_used', 'session_revoked',
        'pin_verify_success', 'pin_verify_fail'
    )),
    ip_address TEXT,
    user_agent TEXT,
    timestamp INTEGER NOT NULL,
    extra TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Copy data
INSERT INTO user_activity_log_new (id, user_id, action, ip_address, user_agent, timestamp, extra)
SELECT id, user_id, action, ip_address, user_agent, timestamp, extra FROM user_activity_log;

-- Drop old table
DROP TABLE user_activity_log;

-- Rename new table
ALTER TABLE user_activity_log_new RENAME TO user_activity_log;

-- Recreate index
CREATE INDEX IF NOT EXISTS idx_activity_log_user ON user_activity_log(user_id, timestamp DESC);
