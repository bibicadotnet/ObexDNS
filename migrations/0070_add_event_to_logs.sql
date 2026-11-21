-- Migration 0070: Query Logs record *events*, not only cache misses.
-- A log row now says why it exists:
--   event = 'new'       first time this domain/type was seen (or seen again after the in-memory state was lost)
--           'changed'   the answer differs from the previous one (set comparison, order ignored)
--           'refreshed' the change was found by a background (lazy-cache) refresh
--           'recheck'   same answer, re-logged after a long time so the domain stays findable
--           'error'     the upstream failed (also: a background refresh failed while a stale answer was served)
--   NULL                rows written before this migration
-- prev_answer holds the previous answer of a 'changed' / 'refreshed' event (encrypted into the E2EE payload
-- for E2EE profiles, like `answer`). Both columns are nullable: no backfill and no index are needed.

ALTER TABLE logs ADD COLUMN event TEXT;
ALTER TABLE logs ADD COLUMN prev_answer TEXT;
