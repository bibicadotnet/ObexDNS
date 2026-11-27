-- Migration 0066: Store the description parsed from a list's `! Description:` / `# Description:` header.
-- NULL  = never scanned yet (the next sync re-downloads once to backfill it, ignoring ETag/Last-Modified).
-- ''    = scanned, the upstream list has no description header.
ALTER TABLE lists ADD COLUMN description TEXT;
ALTER TABLE system_lists ADD COLUMN description TEXT;
