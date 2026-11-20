-- Migration 0069: Partial index for failed resolutions (action = 'FAIL')
-- The Query Logs "Failed" filter and the Failed counter otherwise scan every row of the selected time range,
-- because migration 0040 dropped the (profile_id, action, timestamp) index. FAIL rows are rare, so this partial
-- index stays tiny and adds no write cost to PASS / BLOCK / REDIRECT inserts.

CREATE INDEX IF NOT EXISTS idx_logs_profile_fail_time ON logs(profile_id, timestamp) WHERE action = 'FAIL';
