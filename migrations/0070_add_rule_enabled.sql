-- Migration 0070: Add enabled column to custom rules
ALTER TABLE rules ADD COLUMN enabled INTEGER DEFAULT 1;
