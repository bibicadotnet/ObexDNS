-- Migration to add Envelope Encryption columns for user TOTP secrets
ALTER TABLE users ADD COLUMN totp_secret_encrypted TEXT;
ALTER TABLE users ADD COLUMN totp_secret_dek TEXT;
ALTER TABLE users ADD COLUMN totp_recovery_keys_encrypted TEXT;
ALTER TABLE users ADD COLUMN totp_recovery_keys_dek TEXT;
