-- Add Bloom filter storage to profiles table
ALTER TABLE profiles ADD COLUMN list_bloom TEXT;
ALTER TABLE profiles ADD COLUMN list_updated_at INTEGER;
