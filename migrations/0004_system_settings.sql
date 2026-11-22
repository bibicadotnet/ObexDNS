-- 系统全局配置表
CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 预设默认值
INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES ('turnstile_site_key', '', 0);
INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES ('turnstile_secret_key', '', 0);
INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES ('turnstile_enabled_signup', 'false', 0);
INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES ('turnstile_enabled_login', 'false', 0);
