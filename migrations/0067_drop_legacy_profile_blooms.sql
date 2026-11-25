-- Drop obsolete profile-level merged Bloom and AdGuard tables (superseded by per-list filtering)
DROP TABLE IF EXISTS profile_blooms;
DROP TABLE IF EXISTS profile_blooms_staging;
DROP TABLE IF EXISTS profile_adguard_rules;
DROP TABLE IF EXISTS profile_adguard_rules_staging;
