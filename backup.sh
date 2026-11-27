#!/bin/sh
set -eu

# ==============================================================================
# ObexDNS Backup Worker
# Hot-backups SQLite database via online .backup API, verifies integrity,
# packages persistent data (.jwt_secret, config, ssl, acme),
# uploads to S3-compatible storage (Cloudflare R2, AWS S3), and prunes old backups.
# ==============================================================================

# 1. Single-instance lock to prevent overlapping backup runs
LOCK_FILE="/tmp/obexdns_backup.lock"
exec 9>"$LOCK_FILE"
flock -n 9 || {
  echo "[Backup] Another backup process is currently running. Skipping."
  exit 0
}

LOCAL_ONLY=""
OUTPUT_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --local-only)
      LOCAL_ONLY="1"
      shift
      ;;
    --output)
      OUTPUT_FILE="${2:-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

DATA_DIR="/data"
CONFIG_DIR="$DATA_DIR/config"
DB_FILE="$DATA_DIR/dns_worker.sqlite"
RETENTION_DAYS="${BACKUP_KEEP_DAYS:-30}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

TMP_DIR=$(mktemp -d "/tmp/obexdns_backup_${TIMESTAMP}_XXXXXX")
PKG_DIR="${TMP_DIR}/pkg"
SNAP_DB="${TMP_DIR}/dns_worker_snapshot.sqlite"
ARCHIVE_NAME="${TMP_DIR}/obexdns_backup_${TIMESTAMP}.tar.gz"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

mkdir -p "$PKG_DIR"

# 2. Hot-backup SQLite database using online .backup API (safe with WAL transactions)
if [ -s "$DB_FILE" ]; then
  echo "[Backup] [1/4] Hot-backing up SQLite database ($DB_FILE)..."
  sqlite3 "$DB_FILE" ".timeout 5000" ".backup main '${SNAP_DB}'"

  if [ ! -s "$SNAP_DB" ]; then
    echo "[Backup] Error: Snapshot database file is empty."
    exit 1
  fi

  INTEGRITY=$(sqlite3 "$SNAP_DB" "PRAGMA integrity_check;")
  if [ "$INTEGRITY" != "ok" ]; then
    echo "[Backup] Error: Snapshot database integrity check failed: $INTEGRITY"
    exit 1
  fi
  echo "[Backup]       -> SQLite snapshot integrity verified (ok)."
fi

# 3. Stage persistent database and secret into packaging directory
echo "[Backup] [2/4] Staging persistent core data files..."
if [ -s "$SNAP_DB" ]; then
  cp -f "$SNAP_DB" "$PKG_DIR/dns_worker.sqlite"
fi

if [ -f "$DATA_DIR/.jwt_secret" ]; then
  cp -f "$DATA_DIR/.jwt_secret" "$PKG_DIR/.jwt_secret"
fi

# 4. Pack staged files into gzip archive
echo "[Backup] [3/4] Creating compressed archive ($ARCHIVE_NAME)..."
tar -czf "$ARCHIVE_NAME" -C "$PKG_DIR" .

if [ ! -s "$ARCHIVE_NAME" ]; then
  echo "[Backup] Error: Archive creation failed or archive is empty."
  exit 1
fi

# Verify archive readability
tar -tzf "$ARCHIVE_NAME" > /dev/null
ARCHIVE_SIZE=$(du -h "$ARCHIVE_NAME" | cut -f1)
echo "[Backup]       -> Archive verified successfully ($ARCHIVE_SIZE)."

if [ -n "$OUTPUT_FILE" ]; then
  cp -f "$ARCHIVE_NAME" "$OUTPUT_FILE"
fi

if [ -n "$LOCAL_ONLY" ]; then
  echo "[Backup] Local snapshot archive successfully created at ${OUTPUT_FILE:-$ARCHIVE_NAME} ($ARCHIVE_SIZE)."
  exit 0
fi

# 5. Optional local copy if BACKUP_KEEP_LOCAL is enabled
if [ "${BACKUP_KEEP_LOCAL:-false}" = "true" ] || [ "${BACKUP_KEEP_LOCAL:-0}" = "1" ]; then
  LOCAL_DEST="${BACKUP_LOCAL_DEST:-/data/backups}"
  mkdir -p "$LOCAL_DEST"
  cp -f "$ARCHIVE_NAME" "$LOCAL_DEST/"
  echo "[Backup]       -> Local copy saved to $LOCAL_DEST."
  find "$LOCAL_DEST" -maxdepth 1 -name "obexdns_backup_*.tar.gz" -type f -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true
fi

# 6. Upload to S3-compatible Object Storage (Cloudflare R2, AWS S3, MinIO)
S3_CLIENT="/app/s3-client.mjs"
HAS_S3=""
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  HAS_S3="1"
elif [ -f "$CONFIG_DIR/.env" ] && grep -E "^[[:space:]]*BACKUP_S3_BUCKET[[:space:]]*=" "$CONFIG_DIR/.env" | grep -v '=""' | grep -v "=''" >/dev/null 2>&1; then
  HAS_S3="1"
fi

if [ -n "$HAS_S3" ] && [ -f "$S3_CLIENT" ]; then
  echo "[Backup] [4/4] Uploading to S3/Cloudflare R2 and enforcing retention policy..."
  bun "$S3_CLIENT" upload "$ARCHIVE_NAME" "obexdns_backup_${TIMESTAMP}.tar.gz"
  bun "$S3_CLIENT" upload "$ARCHIVE_NAME" "latest.tar.gz"
  bun "$S3_CLIENT" prune "$RETENTION_DAYS"
else
  echo "[Backup] [4/4] No S3 bucket configured. Skipping cloud upload."
fi

echo "[Backup] Backup completed successfully at $(date)."
