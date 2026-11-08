-- Add session_lock_timeout to users table
ALTER TABLE users ADD COLUMN session_lock_timeout INTEGER DEFAULT 15;
