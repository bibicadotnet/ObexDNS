-- Migration 0050: Add destination geo columns to logs table
-- Enables native column extraction and eliminates runtime json_extract() overhead

ALTER TABLE logs ADD COLUMN dest_country_code TEXT;
ALTER TABLE logs ADD COLUMN dest_country TEXT;
ALTER TABLE logs ADD COLUMN dest_isp TEXT;
