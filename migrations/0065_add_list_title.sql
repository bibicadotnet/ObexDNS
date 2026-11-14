-- Migration 0065: Store the display title parsed from a list's `! Title:` / `# Title:` header
ALTER TABLE lists ADD COLUMN title TEXT;
