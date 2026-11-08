-- 用户安全活动日志
CREATE TABLE IF NOT EXISTS user_activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN (
        'login_success', 'login_fail', 'logout',
        'password_change_success', 'password_change_fail',
        'totp_verify_success', 'totp_verify_fail',
        'totp_setup', 'totp_removed',
        'recovery_key_used'
    )),
    ip_address TEXT,
    user_agent TEXT,
    timestamp INTEGER NOT NULL,
    extra TEXT, -- JSON 附加信息 (如失败原因)
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 待验证的 TOTP 临时会话 (密码验证通过，等待 TOTP 验证)
CREATE TABLE IF NOT EXISTS pending_totp_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- TOTP 相关字段
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0;
-- 跳过密码模式：启用后登录只需 TOTP，不需要密码
ALTER TABLE users ADD COLUMN totp_skip_password INTEGER DEFAULT 0;
-- 恢复密钥：JSON 数组，存储 SHA-256 哈希后的 8 个一次性密钥
ALTER TABLE users ADD COLUMN totp_recovery_keys TEXT;

-- 索引
CREATE INDEX IF NOT EXISTS idx_activity_log_user ON user_activity_log(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_pending_totp_expires ON pending_totp_sessions(expires_at);
