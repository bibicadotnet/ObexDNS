-- A/B Bloom Filter upgrade: staging table holds the bloom currently being built.
-- Active DNS queries always read from profile_blooms (the fully-completed bloom).
-- Once all lists in a sync cycle are done, the staging bloom is atomically
-- promoted to profile_blooms, eliminating partial/inconsistent states during sync.

CREATE TABLE IF NOT EXISTS profile_blooms_staging (
  profile_id    TEXT    NOT NULL,
  chunk_index   INTEGER NOT NULL,
  bloom_filter_chunk BLOB NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (profile_id, chunk_index)
);
