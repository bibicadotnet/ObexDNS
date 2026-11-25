-- Recreate profile_blooms with foreign key cascade constraint
CREATE TABLE IF NOT EXISTS profile_blooms_new (
  profile_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  bloom_filter_chunk BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, chunk_index),
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- Copy existing data, automatically filter out orphan records
INSERT INTO profile_blooms_new (profile_id, chunk_index, bloom_filter_chunk, updated_at)
SELECT pb.profile_id, pb.chunk_index, pb.bloom_filter_chunk, pb.updated_at
FROM profile_blooms pb
INNER JOIN profiles p ON pb.profile_id = p.id;

DROP TABLE profile_blooms;
ALTER TABLE profile_blooms_new RENAME TO profile_blooms;

-- Recreate profile_blooms_staging with foreign key cascade constraint
CREATE TABLE IF NOT EXISTS profile_blooms_staging_new (
  profile_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  bloom_filter_chunk BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, chunk_index),
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- Copy existing data, automatically filter out orphan records
INSERT INTO profile_blooms_staging_new (profile_id, chunk_index, bloom_filter_chunk, updated_at)
SELECT pbs.profile_id, pbs.chunk_index, pbs.bloom_filter_chunk, pbs.updated_at
FROM profile_blooms_staging pbs
INNER JOIN profiles p ON pbs.profile_id = p.id;

DROP TABLE profile_blooms_staging;
ALTER TABLE profile_blooms_staging_new RENAME TO profile_blooms_staging;

-- Clean up legacy jwt_secret from system_settings table
DELETE FROM system_settings WHERE key = 'jwt_secret';
