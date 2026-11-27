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

# 3. Optional: Initial SQLite database download from remote URL if DB does not exist
if [ ! -f "$DB_PATH" ] && [ -n "$DB_INIT_URL" ]; then
  echo "[DB] Initializing SQLite database from DB_INIT_URL..."
  if curl -fsSL -o "$DB_PATH" "$DB_INIT_URL"; then
    echo "[DB] Database successfully initialized at $DB_PATH."
  else
    echo "[DB] Warning: Failed to download database from $DB_INIT_URL. ObexDNS will create a fresh database."
    rm -f "$DB_PATH"
  fi
fi

# 4. Configuration extractor: safely reads key from process env, /data/config/.env, or /data/.env
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
      _parsed=$(awk -F= -v k="$_var" '
        $1 ~ "^[[:space:]]*"k"[[:space:]]*$" {
          sub(/^[[:space:]]*[^=]+=[[:space:]]*/, "");
          val=$0;
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", val);
          if ((val ~ /^".*"$/) || (val ~ /^'\''[^\'']*'\''$/)) {
            val = substr(val, 2, length(val) - 2);
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

# 5. Resolve SSL configuration values
CF_TOKEN=$(get_env_val "CLOUDFLARE_API_TOKEN" "$(get_env_val "CF_Token" "")")
RAW_DOMAIN=$(get_env_val "SERVERFULL_DOT_DOMAIN" "$(get_env_val "DOT_DOMAIN" "")")
CRON_EXPR=$(get_env_val "SSL_RENEW_CRON" "23 3 * * *")
ACME_STAGING=$(get_env_val "ACME_STAGING" "")
ACME_EMAIL=$(get_env_val "ACME_EMAIL" "$(get_env_val "CERTBOT_EMAIL" "")")
CF_ACCOUNT_ID=$(get_env_val "CF_Account_ID" "")

# Normalize domain: strip https?://, ports, paths, leading wildcard (*.), trailing dots & spaces, to lowercase
CLEAN_DOMAIN=$(printf '%s' "$RAW_DOMAIN" | sed -e 's|^https*://||' -e 's|/.*$||' -e 's|:.*$||' -e 's|^\*\.||' -e 's|\.*$||' | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')

# Validate domain format (must contain at least one dot, valid hostname characters)
DOMAIN_VALID=0
case "$CLEAN_DOMAIN" in
  *[!a-z0-9.-]* | "" | *..* | .* | *-)
    DOMAIN_VALID=0 ;;
  *.*)
    DOMAIN_VALID=1 ;;
  *)
    DOMAIN_VALID=0 ;;
esac

# 6. Automated Let's Encrypt Wildcard SSL via acme.sh (Cloudflare DNS-01)
if [ -n "$CF_TOKEN" ] && [ "$DOMAIN_VALID" -eq 1 ]; then
  ACME_BIN="$(command -v acme.sh || echo '/opt/acme.sh/acme.sh')"
  if [ ! -x "$ACME_BIN" ]; then
    echo "[SSL] Warning: acme.sh executable not found at $ACME_BIN. Skipping SSL provisioning."
  else
    # Export Cloudflare DNS credentials for acme.sh dns_cf plugin
    export CF_Token="$CF_TOKEN"
    [ -n "$CF_ACCOUNT_ID" ] && export CF_Account_ID="$CF_ACCOUNT_ID"

    # Check if a valid certificate covering the domain already exists (expires in > 7 days)
    CERT_VALID=0
    if [ -s "$CERT_PATH" ] && openssl x509 -checkend 604800 -noout -in "$CERT_PATH" >/dev/null 2>&1; then
      _sans=$(openssl x509 -noout -ext subjectAltName -in "$CERT_PATH" 2>/dev/null | tr -d ' ' || true)
      case "$_sans" in
        *"DNS:${CLEAN_DOMAIN}"* | *"DNS:*.${CLEAN_DOMAIN}"*)
          CERT_VALID=1
          ;;
      esac
    fi

    if [ "$CERT_VALID" -eq 1 ]; then
      echo "[SSL] Valid certificate found at $CERT_PATH for $CLEAN_DOMAIN (*.$CLEAN_DOMAIN)."
    else
      echo "[SSL] Requesting Let's Encrypt Wildcard certificate for ${CLEAN_DOMAIN} and *.${CLEAN_DOMAIN} via Cloudflare DNS..."
      
      ISSUE_ARGS="--home /opt/acme.sh --config-home $ACME_DIR --issue --dns dns_cf -d $CLEAN_DOMAIN -d *.$CLEAN_DOMAIN --server letsencrypt"
      [ "$ACME_STAGING" = "true" ] || [ "$ACME_STAGING" = "1" ] && ISSUE_ARGS="$ISSUE_ARGS --staging"
      [ -n "$ACME_EMAIL" ] && ISSUE_ARGS="$ISSUE_ARGS -m $ACME_EMAIL"

      # Do not allow container to crash if initial issuance fails (e.g. rate limit, temporary network)
      set +e
      "$ACME_BIN" $ISSUE_ARGS
      ISSUE_STATUS=$?
      set -e

      # Status 0 = successfully issued, Status 2 = cert already issued and valid
      if [ $ISSUE_STATUS -eq 0 ] || [ $ISSUE_STATUS -eq 2 ]; then
        echo "[SSL] Installing certificate to $CERT_PATH and $KEY_PATH..."
        "$ACME_BIN" --home /opt/acme.sh --config-home "$ACME_DIR" --install-cert -d "$CLEAN_DOMAIN" \
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
DOMAIN="$CLEAN_DOMAIN"
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

    # Start Debian cron daemon in the background
    cron
    echo "[SSL] Scheduled automated certificate renewal cron ($CRON_EXPR UTC)."
  fi
else
  # Auto-SSL disabled: ensure no orphan cron job exists
  rm -f /etc/cron.d/ssl-renew
fi

# 7. Start ObexDNS Serverfull runtime
# Switch working directory to /data/config so user's /data/config/.env takes precedence
# while /app/.env.serverfull acts as the base default fallback.
cd "$CONFIG_DIR"
exec bun /app/dist/serverfull.mjs "$@"
