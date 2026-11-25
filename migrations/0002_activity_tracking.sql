-- Add activity tracking
ALTER TABLE users ADD COLUMN last_active_at INTEGER;
ALTER TABLE profiles ADD COLUMN last_active_at INTEGER;

-- Initialize existing records
UPDATE users SET last_active_at = created_at WHERE last_active_at IS NULL;
UPDATE profiles SET last_active_at = created_at WHERE last_active_at IS NULL;
