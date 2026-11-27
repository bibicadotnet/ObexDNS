# syntax=docker/dockerfile:1

# ==============================================================================
# Stage 1: Build Web Dashboard & Serverfull Bundle (Runs natively on host platform)
# ==============================================================================
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder
WORKDIR /app

# Copy dependency manifests and configuration first for optimal Docker layer caching
COPY package.json package-lock.json .npmrc* ./
COPY web/package.json web/package-lock.json web/.npmrc ./web/

# Install dependencies deterministically without running lifecycle scripts early
RUN npm ci --ignore-scripts && npm --prefix web ci --ignore-scripts --legacy-peer-deps

# Copy full source tree
COPY . .

# Build Web UI (Vite) and bundle single-file serverfull runtime executable
RUN npm run build:serverfull

# ==============================================================================
# Stage 2: Production Runtime with Bun LTS
# ==============================================================================
FROM oven/bun:1-slim AS runner

LABEL maintainer="Hugo Koo <hokdung@outlook.com>" \
      org.opencontainers.image.title="DNS Worker" \
      org.opencontainers.image.description="Privacy-first DNS & DoH Resolver with modern Web Dashboard, powered by Bun LTS" \
      org.opencontainers.image.url="https://github.com/Obein/DNS-Worker" \
      org.opencontainers.image.source="https://github.com/Obein/DNS-Worker" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

WORKDIR /app

# Install ca-certificates, curl, openssl, cron, sqlite3, unzip for TLS, backup snapshots, and restore
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl openssl cron sqlite3 unzip && \
    rm -rf /var/lib/apt/lists/*

# Install acme.sh client (pinned version, installed with --no-cron to manage scheduling cleanly via Debian cron)
ARG ACME_SH_VERSION=3.1.0
RUN curl -fsSL "https://github.com/acmesh-official/acme.sh/archive/refs/tags/${ACME_SH_VERSION}.tar.gz" -o /tmp/acme.sh.tar.gz && \
    tar -xzf /tmp/acme.sh.tar.gz -C /tmp && \
    cd "/tmp/acme.sh-${ACME_SH_VERSION}" && \
    ./acme.sh --install --home /opt/acme.sh --no-cron && \
    ln -s /opt/acme.sh/acme.sh /usr/local/bin/acme.sh && \
    rm -rf /tmp/acme.sh*

# Default Serverfull environment variables
ENV NODE_ENV=production \
    SERVERFULL_HOST=0.0.0.0 \
    SERVERFULL_UDP_PORT=53 \
    SERVERFULL_DOT_PORT=853 \
    SERVERFULL_HTTP_PORT=80 \
    SERVERFULL_HTTPS_PORT=443 \
    SERVERFULL_DB_PATH=/data/dns_worker.sqlite \
    SERVERFULL_TLS_CERT_PATH=/data/ssl/fullchain.pem \
    SERVERFULL_TLS_KEY_PATH=/data/ssl/privkey.pem

# Pre-create system persistent directories and backward-compatibility symlinks
RUN mkdir -p /data /data/ssl /data/config /data/acme && \
    mkdir -p /var/lib /etc/ssl && \
    ln -sfn /data /var/lib/dns-worker && \
    ln -sfn /data/config /etc/dns-worker && \
    ln -sfn /data/ssl /etc/ssl/dns-worker

# Copy built application distribution assets
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/static ./static
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/.env.serverfull ./.env.serverfull

# Copy entrypoint, automated renewal, and backup scripts
COPY entrypoint.sh /app/entrypoint.sh
COPY ssl-renew.sh /app/ssl-renew.sh
COPY backup.sh /app/backup.sh
COPY s3-client.mjs /app/s3-client.mjs
RUN chmod +x /app/entrypoint.sh /app/ssl-renew.sh /app/backup.sh /app/s3-client.mjs

# Expose Serverfull network transports:
# - 53/udp:   Classic UDP DNS
# - 853/tcp:  DNS over TLS (DoT)
# - 80/tcp:   HTTP Web Dashboard & DoH (Auto-redirects to HTTPS when TLS is configured)
# - 443/tcp:  HTTPS Web Dashboard & DoH
EXPOSE 53/udp 853/tcp 80/tcp 443/tcp

# Unified persistent volume:
# - /data: SQLite database (/data/dns_worker.sqlite), config (/data/config/.env), SSL (/data/ssl), and ACME account (/data/acme)
VOLUME ["/data"]

# Healthcheck to verify HTTP / HTTPS Web Dashboard responsiveness.
# The long start period covers the one-time auto_vacuum conversion of an existing database, during which no port
# is open yet (about 1 second per 150 MB on an SSD, minutes for multi-GB databases on a hard disk). Probe failures
# inside the start period do not count towards --retries, and the first success ends it early.
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=3 \
  CMD curl -fsSLk http://127.0.0.1:${SERVERFULL_HTTP_PORT:-80}/ > /dev/null || exit 1

# Master runtime entry point
ENTRYPOINT ["/app/entrypoint.sh"]
