#!/bin/sh
set -e

# ==============================================================================
# ObexDNS Container Entrypoint
# Handles persistent directories, database initialization, automated Let's
# Encrypt Wildcard TLS certificates via Cloudflare DNS-01 & acme.sh,
# scheduled renewal via Debian cron, and server startup.
# ==============================================================================

# Fast path: bypass DB & SSL bootstrap when running maintenance/utility CLI subcommands
case "$1" in
  status|--status|-s|help|--help|-h|version|--version|-v|reset|sync|service|init-config)
    exec bun /app/dist/serverfull.mjs "$@"
    ;;
esac

DATA_DIR="/data"
CONFIG_DIR="$DATA_DIR/config"
SSL_DIR="$DATA_DIR/ssl"
ACME_DIR="$DATA_DIR/acme"

DB_PATH="${SERVERFULL_DB_PATH:-$DATA_DIR/dns_worker.sqlite}"
CERT_PATH="${SERVERFULL_TLS_CERT_PATH:-$SSL_DIR/fullchain.pem}"
KEY_PATH="${SERVERFULL_TLS_KEY_PATH:-$SSL_DIR/privkey.pem}"

# 1. Ensure persistent directories exist with appropriate permissions
mkdir -p "$CONFIG_DIR" "$SSL_DIR" "$ACME_DIR" "$(dirname "$DB_PATH")"
chmod 700 "$ACME_DIR"
chmod 755 "$CONFIG_DIR" "$SSL_DIR"

# 2. Maintain backward-compatibility symlinks for legacy paths
mkdir -p /var/lib /etc/ssl
[ -L /var/lib/dns-worker ] || ln -sfn "$DATA_DIR" /var/lib/dns-worker
[ -L /etc/dns-worker ] || ln -sfn "$CONFIG_DIR" /etc/dns-worker
[ -L /etc/ssl/dns-worker ] || ln -sfn "$SSL_DIR" /etc/ssl/dns-worker

# Backward-compatibility: if user mounted old /data/.env instead of /data/config/.env
if [ -f "$DATA_DIR/.env" ] && [ ! -f "$CONFIG_DIR/.env" ]; then
  ln -sfn "$DATA_DIR/.env" "$CONFIG_DIR/.env"
fi

# 3. Configuration extractor: safely reads key from process env, /data/config/.env, or /data/.env
# Process environment variables always take precedence over file-based values.
get_env_val() {
  _var="$1"
  _def="$2"
  _val=$(eval "printf '%s' \"\$$_var\"")
  if [ -n "$_val" ]; then
    printf '%s' "$_val"
    return 0
  fi
  for _f in "$CONFIG_DIR/.env" "$DATA_DIR/.env"; do
    if [ -f "$_f" ]; then
      _parsed=$(awk -F= -v k="$_var" -v dq='"' -v sq="'" '
        $1 ~ "^[[:space:]]*"k"[[:space:]]*$" {
          sub(/^[[:space:]]*[^=]+=[[:space:]]*/, "");
          val=$0;
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", val);
          len = length(val);
          if (len >= 2) {
            c1 = substr(val, 1, 1);
            c2 = substr(val, len, 1);
            if ((c1 == dq && c2 == dq) || (c1 == sq && c2 == sq)) {
              val = substr(val, 2, len - 2);
            }
          }
          result = val;
        }
        END {
          if (result != "") print result;
        }
      ' "$_f")
      if [ -n "$_parsed" ]; then
        printf '%s' "$_parsed"
        return 0
      fi
    fi
  done
  printf '%s' "$_def"
}

# 4. Optional: One-time database & persistent data restore (only if DB is missing or empty)
if [ ! -s "$DB_PATH" ]; then
  DB_INIT_URL=$(get_env_val "DB_INIT_URL" "")
  BACKUP_BUCKET=$(get_env_val "BACKUP_S3_BUCKET" "")
  TMP_DOWNLOAD="${DB_PATH}.download.$$"
  EXTRACT_DIR="${DATA_DIR}/.restore_tmp.$$"
  rm -rf "$EXTRACT_DIR" "$TMP_DOWNLOAD"
  DOWNLOAD_OK=0

  # Priority 1: Pull from private S3 / Cloudflare R2 if configured
  if [ -n "$BACKUP_BUCKET" ] && [ -f "/app/s3-client.mjs" ]; then
    S3_TARGET="latest.tar.gz"
    case "$DB_INIT_URL" in
      http://* | https://*) ;;
      ?*) S3_TARGET="$DB_INIT_URL" ;;
    esac

    echo "[DB-Restore] S3 bucket configured ($BACKUP_BUCKET). Attempting private restore from '$S3_TARGET'..."
    set +e
    bun /app/s3-client.mjs download "$S3_TARGET" "$TMP_DOWNLOAD"
    S3_DL_STATUS=$?
    set -e

    if [ $S3_DL_STATUS -eq 0 ] && [ -s "$TMP_DOWNLOAD" ]; then
      DOWNLOAD_OK=1
    elif [ $S3_DL_STATUS -eq 44 ]; then
      echo "[DB-Restore] No existing backup found in S3 bucket (clean setup)."
    else
      echo "[DB-Restore] Warning: Failed to download backup from S3 (exit code $S3_DL_STATUS)."
    fi
  fi

  # Priority 2: Fallback to external HTTP/HTTPS URL if DB_INIT_URL is set and S3 didn't download
  if [ $DOWNLOAD_OK -eq 0 ] && [ -n "$DB_INIT_URL" ]; then
    case "$DB_INIT_URL" in
      http://* | https://*)
        echo "[DB-Restore] Downloading database/archive from DB_INIT_URL: $DB_INIT_URL..."
        if curl -fsSL -o "$TMP_DOWNLOAD" "$DB_INIT_URL"; then
          DOWNLOAD_OK=1
        else
          echo "[DB-Restore] Warning: Failed to download from DB_INIT_URL ($DB_INIT_URL)."
          rm -f "$TMP_DOWNLOAD"
        fi
        ;;
    esac
  fi

  # Process downloaded file if available
  if [ $DOWNLOAD_OK -eq 1 ] && [ -s "$TMP_DOWNLOAD" ]; then
    mkdir -p "$EXTRACT_DIR"
    HEADER15=$(head -c 15 "$TMP_DOWNLOAD" 2>/dev/null || true)
    IS_RESTORED=0

    # Case 1: Raw SQLite database
    if [ "$HEADER15" = "SQLite format 3" ]; then
      echo "[DB-Restore] Detected raw SQLite database format."
      mv -f "$TMP_DOWNLOAD" "$DB_PATH"
      rm -f "${DB_PATH}-wal" "${DB_PATH}-shm"
      IS_RESTORED=1

    # Case 2: tar.gz archive
    elif tar -tzf "$TMP_DOWNLOAD" >/dev/null 2>&1; then
      echo "[DB-Restore] Detected tar.gz archive format. Extracting..."
      tar -xzf "$TMP_DOWNLOAD" -C "$EXTRACT_DIR"
      rm -f "$TMP_DOWNLOAD"

    # Case 3: zip archive
    elif command -v unzip >/dev/null 2>&1 && unzip -tq "$TMP_DOWNLOAD" >/dev/null 2>&1; then
      echo "[DB-Restore] Detected zip archive format. Extracting..."
      unzip -qo "$TMP_DOWNLOAD" -d "$EXTRACT_DIR"
      rm -f "$TMP_DOWNLOAD"

    else
      echo "[DB-Restore] Warning: Unknown file format from backup (not SQLite, tar.gz, or zip)."
      rm -f "$TMP_DOWNLOAD"
    fi

    # If extracted from archive (Case 2 or Case 3), locate and install components
    if [ -d "$EXTRACT_DIR" ] && [ "$IS_RESTORED" -eq 0 ]; then
      # 1. Restore SQLite database (Core Data: profiles, rules, logs, users, analytics)
      FOUND_DB=$(find "$EXTRACT_DIR" -type f -name "*.sqlite" ! -name "*-wal" ! -name "*-shm" | head -n 1)
      if [ -n "$FOUND_DB" ] && [ -s "$FOUND_DB" ]; then
        DB_CHECK=$(sqlite3 "$FOUND_DB" "PRAGMA integrity_check;" 2>/dev/null || echo "failed")
        if [ "$DB_CHECK" = "ok" ]; then
          mv -f "$FOUND_DB" "$DB_PATH"
          rm -f "${DB_PATH}-wal" "${DB_PATH}-shm"
          echo "[DB-Restore] Successfully restored SQLite database to $DB_PATH."
          IS_RESTORED=1
        else
          echo "[DB-Restore] Warning: Database in archive failed integrity check ($DB_CHECK)."
        fi
      fi

      # 2. Restore .jwt_secret only if present and /data/.jwt_secret does not already exist
      FOUND_SECRET=$(find "$EXTRACT_DIR" -type f -name ".jwt_secret" | head -n 1)
      if [ -n "$FOUND_SECRET" ] && [ ! -s "$DATA_DIR/.jwt_secret" ]; then
        cp -f "$FOUND_SECRET" "$DATA_DIR/.jwt_secret"
        chmod 600 "$DATA_DIR/.jwt_secret"
        echo "[DB-Restore] Successfully restored .jwt_secret."
      fi
    fi

    rm -rf "$EXTRACT_DIR" "$TMP_DOWNLOAD"
    if [ "$IS_RESTORED" -eq 1 ]; then
      echo "[DB-Restore] Data initialization complete."
    else
      echo "[DB-Restore] Warning: Failed to extract a valid database. ObexDNS will create a fresh database."
    fi
  fi
else
  echo "[DB-Restore] Existing database detected at $DB_PATH. Skipping restore."
fi

# 5. Resolve SSL configuration values
CF_TOKEN=$(get_env_val "CLOUDFLARE_API_TOKEN" "$(get_env_val "CF_Token" "")")
CERTBOT_DOMAINS=$(get_env_val "CERTBOT_DOMAINS" "$(get_env_val "SSL_DOMAINS" "")")
RAW_DOMAIN=$(get_env_val "SERVERFULL_DOT_DOMAIN" "$(get_env_val "DOT_DOMAIN" "")")
CRON_EXPR=$(get_env_val "SSL_RENEW_CRON" "23 3 * * *")
ACME_STAGING=$(get_env_val "ACME_STAGING" "")
ACME_EMAIL=$(get_env_val "ACME_EMAIL" "$(get_env_val "CERTBOT_EMAIL" "")")
CF_ACCOUNT_ID=$(get_env_val "CF_Account_ID" "")

DOMAIN_INPUT="${CERTBOT_DOMAINS:-$RAW_DOMAIN}"

PRIMARY_DOMAIN=""
ACME_DOM_ARGS=""
ALL_DOMAINS=""

for _raw_d in $(printf '%s' "$DOMAIN_INPUT" | tr ',' ' '); do
  _clean_d=$(printf '%s' "$_raw_d" | sed -e 's|^https*://||' -e 's|/.*$||' -e 's|:.*$||' -e 's|^\*\.||' -e 's|\.*$||' | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
  
  case "$_clean_d" in
    *[!a-z0-9.-]* | "" | *..* | .* | *-) continue ;;
    *.*) ;;
    *) continue ;;
  esac

  [ -z "$PRIMARY_DOMAIN" ] && PRIMARY_DOMAIN="$_clean_d"

  # Automatically issue for both base domain and wildcard (*.domain)
  for _target in "$_clean_d" "*.$_clean_d"; do
    case " $ALL_DOMAINS " in
      *" $_target "*) ;;
      *)
        ALL_DOMAINS="$ALL_DOMAINS $_target"
        ACME_DOM_ARGS="$ACME_DOM_ARGS -d $_target"
        ;;
    esac
  done
done

[ -z "$PRIMARY_DOMAIN" ] && [ -n "$ALL_DOMAINS" ] && PRIMARY_DOMAIN=$(printf '%s' "$ALL_DOMAINS" | awk '{print $1}' | sed 's|^\*\.||')

# 6. Automated Let's Encrypt Wildcard SSL via acme.sh (Cloudflare DNS-01)
if [ -n "$CF_TOKEN" ] && [ -n "$PRIMARY_DOMAIN" ]; then
  ACME_BIN="$(command -v acme.sh || echo '/opt/acme.sh/acme.sh')"
  if [ ! -x "$ACME_BIN" ]; then
    echo "[SSL] Warning: acme.sh executable not found at $ACME_BIN. Skipping SSL provisioning."
  else
    # Export Cloudflare DNS credentials for acme.sh dns_cf plugin
    export CF_Token="$CF_TOKEN"
    [ -n "$CF_ACCOUNT_ID" ] && export CF_Account_ID="$CF_ACCOUNT_ID"

    # Check if a valid certificate covering the primary domain already exists (expires in > 7 days)
    CERT_VALID=0
    if [ -s "$CERT_PATH" ] && openssl x509 -checkend 604800 -noout -in "$CERT_PATH" >/dev/null 2>&1; then
      _sans=$(openssl x509 -noout -ext subjectAltName -in "$CERT_PATH" 2>/dev/null | tr -d ' ' || true)
      case "$_sans" in
        *"DNS:${PRIMARY_DOMAIN}"* | *"DNS:*.${PRIMARY_DOMAIN}"*)
          CERT_VALID=1
          ;;
      esac
    fi

    if [ "$CERT_VALID" -eq 1 ]; then
      echo "[SSL] Valid certificate found at $CERT_PATH covering $PRIMARY_DOMAIN."
    else
      echo "[SSL] Requesting Let's Encrypt certificate for:$ALL_DOMAINS via Cloudflare DNS..."
      
      set -f
      ISSUE_ARGS="--home /opt/acme.sh --config-home $ACME_DIR --issue --dns dns_cf $ACME_DOM_ARGS --server letsencrypt"
      [ "$ACME_STAGING" = "true" ] || [ "$ACME_STAGING" = "1" ] && ISSUE_ARGS="$ISSUE_ARGS --staging"
      [ -n "$ACME_EMAIL" ] && ISSUE_ARGS="$ISSUE_ARGS -m $ACME_EMAIL"

      # Do not allow container to crash if initial issuance fails (e.g. rate limit, temporary network)
      set +e
      "$ACME_BIN" $ISSUE_ARGS
      ISSUE_STATUS=$?
      set -e
      set +f

      # Status 0 = successfully issued, Status 2 = cert already issued and valid
      if [ $ISSUE_STATUS -eq 0 ] || [ $ISSUE_STATUS -eq 2 ]; then
        echo "[SSL] Installing certificate to $CERT_PATH and $KEY_PATH..."
        "$ACME_BIN" --home /opt/acme.sh --config-home "$ACME_DIR" --install-cert -d "$PRIMARY_DOMAIN" \
          --key-file "$KEY_PATH" \
          --fullchain-file "$CERT_PATH"
        chmod 600 "$KEY_PATH"
        chmod 644 "$CERT_PATH"
        echo "[SSL] Certificate successfully installed."
      else
        echo "[SSL] Warning: Certificate issuance failed with status code $ISSUE_STATUS."
        echo "[SSL] Please verify that CLOUDFLARE_API_TOKEN has 'Zone -> DNS -> Edit' permissions."
        echo "[SSL] ObexDNS will continue starting (HTTP and UDP services remain operational)."
      fi
    fi

    # Save runtime environment for background cron renewals
    cat <<EOF > "$ACME_DIR/ssl.env"
DOMAIN="$PRIMARY_DOMAIN"
ALL_DOMAINS="$ALL_DOMAINS"
CERT_PATH="$CERT_PATH"
KEY_PATH="$KEY_PATH"
ACME_STAGING="$ACME_STAGING"
EOF
    chmod 600 "$ACME_DIR/ssl.env"

    # Validate 5-field cron expression
    VALID_CRON=$(printf '%s' "$CRON_EXPR" | awk '
      NF == 5 && $0 ~ /^[0-9*,\/-]+[[:space:]]+[0-9*,\/-]+[[:space:]]+[0-9*,\/-]+[[:space:]]+[0-9*,\/-]+[[:space:]]+[0-9*,\/-]+$/ {
        print "valid"
      }
    ')
    if [ "$VALID_CRON" != "valid" ]; then
      echo "[SSL] Warning: Invalid SSL_RENEW_CRON ('$CRON_EXPR'). Falling back to '23 3 * * *'."
      CRON_EXPR="23 3 * * *"
    fi

    # Write Debian cron schedule for ssl-renew.sh
    cat <<EOF > /etc/cron.d/ssl-renew
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin

$CRON_EXPR root /app/ssl-renew.sh > /proc/1/fd/1 2>&1
EOF
    chmod 0644 /etc/cron.d/ssl-renew
    echo "[SSL] Scheduled automated certificate renewal cron ($CRON_EXPR UTC)."
  fi
else
  # Auto-SSL disabled: ensure no orphan cron job exists
  rm -f /etc/cron.d/ssl-renew
fi

# 7. Setup automated S3 / Cloudflare R2 backup cron if configured
BACKUP_BUCKET=$(get_env_val "BACKUP_S3_BUCKET" "")
BACKUP_CRON_EXPR=$(get_env_val "BACKUP_CRON" "0 2 * * *")

if [ -n "$BACKUP_BUCKET" ]; then
  VALID_BCRON=$(printf '%s' "$BACKUP_CRON_EXPR" | awk '
    NF == 5 && $0 ~ /^[0-9*,\/-]+[[:space:]]+[0-9*,\/-]+[[:space:]]+[0-9*,\/-]+[[:space:]]+[0-9*,\/-]+[[:space:]]+[0-9*,\/-]+$/ {
      print "valid"
    }
  ')
  if [ "$VALID_BCRON" != "valid" ]; then
    echo "[Backup] Warning: Invalid BACKUP_CRON ('$BACKUP_CRON_EXPR'). Falling back to '0 2 * * *'."
    BACKUP_CRON_EXPR="0 2 * * *"
  fi

  cat <<EOF > /etc/cron.d/backup
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin

$BACKUP_CRON_EXPR root nice -n 19 /app/backup.sh > /proc/1/fd/1 2>&1
EOF
  chmod 0644 /etc/cron.d/backup
  echo "[Backup] Scheduled automated S3 backup cron ($BACKUP_CRON_EXPR UTC)."
else
  rm -f /etc/cron.d/backup
fi

# 8. Start Debian cron daemon in the background if any scheduled jobs exist
if [ -f /etc/cron.d/ssl-renew ] || [ -f /etc/cron.d/backup ]; then
  if ! pgrep -x cron >/dev/null 2>&1; then
    cron
  fi
fi

# 9. Start ObexDNS Serverfull runtime
# Switch working directory to /data/config so user's /data/config/.env takes precedence
# while /app/.env.serverfull acts as the base default fallback.
cd "$CONFIG_DIR"
exec bun /app/dist/serverfull.mjs "$@"
