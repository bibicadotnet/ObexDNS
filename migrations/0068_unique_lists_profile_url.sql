-- Deduplicate any duplicate (profile_id, url) rows, keeping the lowest id
DELETE FROM lists
WHERE id NOT IN (
    SELECT MIN(id)
    FROM lists
    GROUP BY profile_id, url
);

-- Enforce uniqueness of (profile_id, url)
CREATE UNIQUE INDEX IF NOT EXISTS idx_lists_profile_url ON lists(profile_id, url);
