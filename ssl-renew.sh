#!/bin/sh
set -e

# ==============================================================================
# ObexDNS SSL Auto-Renewal Worker
# Invoked periodically by Debian cron daemon.
# Checks TLS certificate expiration and triggers acme.sh renewal only when
# remaining certificate lifetime falls below 1/3 (adaptive to 90d/64d/45d certs).
# ==============================================================================

# Single-instance lock to prevent overlapping runs
LOCK_FILE="/data/ssl/.renew.lock"
exec 200>"$LOCK_FILE"
flock -n 200 || {
  echo "[SSL-Renew] Another renewal process is currently running. Skipping."
  exit 0
}

# Load saved runtime configuration
if [ -f "/data/acme/ssl.env" ]; then
  . "/data/acme/ssl.env"
fi

DATA_DIR="/data"
CONFIG_DIR="$DATA_DIR/config"
SSL_DIR="$DATA_DIR/ssl"
ACME_DIR="$DATA_DIR/acme"

CERT_PATH="${CERT_PATH:-$SSL_DIR/fullchain.pem}"
KEY_PATH="${KEY_PATH:-$SSL_DIR/privkey.pem}"

# Fallback: resolve domain if missing from ssl.env
if [ -z "$DOMAIN" ]; then
  for _f in "$CONFIG_DIR/.env" "$DATA_DIR/.env"; do
    if [ -f "$_f" ]; then
      DOMAIN=$(awk -F= '$1 ~ /^[[:space:]]*SERVERFULL_DOT_DOMAIN[[:space:]]*$/ {
        sub(/^[[:space:]]*[^=]+=[[:space:]]*/, "");
        val=$0;
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", val);
        if ((val ~ /^".*"$/) || (val ~ /^'\''[^\'']*'\''$/)) {
          val = substr(val, 2, length(val) - 2);
        }
        print val;
      }' "$_f")
      [ -n "$DOMAIN" ] && break
    fi
  done
  DOMAIN=$(printf '%s' "$DOMAIN" | sed -e 's|^https*://||' -e 's|/.*$||' -e 's|:.*$||' -e 's|^\*\.||' -e 's|\.*$||' | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
fi

if [ -z "$DOMAIN" ]; then
  echo "[SSL-Renew] Error: No valid domain configured for renewal. Skipping."
  exit 0
fi

ACME_BIN="$(command -v acme.sh || echo '/opt/acme.sh/acme.sh')"
if [ ! -x "$ACME_BIN" ]; then
  echo "[SSL-Renew] Error: acme.sh executable not found at $ACME_BIN."
  exit 1
fi

NEED_RENEW=0

if [ ! -s "$CERT_PATH" ]; then
  echo "[SSL-Renew] Certificate file $CERT_PATH is missing. Renewal required."
  NEED_RENEW=1
else
  START_DATE=$(openssl x509 -noout -startdate -in "$CERT_PATH" 2>/dev/null | cut -d= -f2)
  END_DATE=$(openssl x509 -noout -enddate -in "$CERT_PATH" 2>/dev/null | cut -d= -f2)

  START_SEC=$(date -d "$START_DATE" +%s 2>/dev/null || echo 0)
  END_SEC=$(date -d "$END_DATE" +%s 2>/dev/null || echo 0)
  NOW_SEC=$(date +%s)

  if [ "$START_SEC" -gt 0 ] && [ "$END_SEC" -gt "$START_SEC" ]; then
    TOTAL_LIFETIME=$((END_SEC - START_SEC))
    REMAINING=$((END_SEC - NOW_SEC))
    # Adaptive threshold: renew when less than 1/3 lifetime remains
    RENEW_THRESHOLD=$((TOTAL_LIFETIME / 3))

    DAYS_LEFT=$((REMAINING / 86400))
    echo "[SSL-Renew] Certificate for $DOMAIN expires in $DAYS_LEFT days (total lifetime: $((TOTAL_LIFETIME / 86400)) days)."

    if [ "$REMAINING" -le "$RENEW_THRESHOLD" ]; then
      echo "[SSL-Renew] Certificate is within renewal window (< 1/3 lifetime remaining). Triggering renewal..."
      NEED_RENEW=1
    else
      echo "[SSL-Renew] Certificate is healthy. No renewal needed at this time."
      NEED_RENEW=0
    fi
  else
    echo "[SSL-Renew] Unable to parse certificate validity dates. Triggering renewal check..."
    NEED_RENEW=1
  fi
fi

if [ "$NEED_RENEW" -eq 1 ]; then
  RENEW_ARGS="--home /opt/acme.sh --config-home $ACME_DIR --renew -d $DOMAIN --force"
  [ "$ACME_STAGING" = "true" ] || [ "$ACME_STAGING" = "1" ] && RENEW_ARGS="$RENEW_ARGS --staging"

  echo "[SSL-Renew] Executing acme.sh renewal for $DOMAIN..."
  set +e
  "$ACME_BIN" $RENEW_ARGS
  RENEW_STATUS=$?
  set -e

  if [ $RENEW_STATUS -eq 0 ]; then
    echo "[SSL-Renew] Renewal successful. Installing updated certificates atomically..."
    TMP_KEY="${KEY_PATH}.tmp.$$"
    TMP_CERT="${CERT_PATH}.tmp.$$"

    "$ACME_BIN" --home /opt/acme.sh --config-home "$ACME_DIR" --install-cert -d "$DOMAIN" \
      --key-file "$TMP_KEY" \
      --fullchain-file "$TMP_CERT"

    if [ -s "$TMP_KEY" ] && [ -s "$TMP_CERT" ]; then
      chmod 600 "$TMP_KEY"
      chmod 644 "$TMP_CERT"
      mv -f "$TMP_KEY" "$KEY_PATH"
      mv -f "$TMP_CERT" "$CERT_PATH"
      echo "[SSL-Renew] Successfully installed renewed certificates to $CERT_PATH and $KEY_PATH."
      echo "[SSL-Renew] ObexDNS will automatically reload the certificate on new connections."
    else
      echo "[SSL-Renew] Error: Installed temp certificate files are empty or missing."
      rm -f "$TMP_KEY" "$TMP_CERT"
    fi
  else
    echo "[SSL-Renew] Warning: acme.sh renewal exited with status code $RENEW_STATUS."
  fi
fi
