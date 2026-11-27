/**
 * @file defaults.ts
 * @description Embedded configuration template and persistent file initializers for Serverfull mode.
 * Allows dns-worker to initialize, export, and inspect its complete configuration without external files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Built-in canonical .env configuration template with comprehensive explanations.
 */
export const DEFAULT_ENV_SERVERFULL_TEMPLATE = `# ==============================================================================
# DNS Worker - Serverfull Mode Environment Configuration (.env.serverfull)
# Cấu hình môi trường chế độ Serverfull / Docker cho DNS Worker
# ==============================================================================
# You can edit this file directly, or copy it to .env (cp .env.serverfull .env).
# Bạn có thể sửa trực tiếp file này, hoặc sao chép thành .env (cp .env.serverfull .env).
# The server will automatically load .env, .env.serverfull, or system persistent .env.
# Máy chủ sẽ tự động nạp cấu hình từ .env, .env.serverfull hoặc .env của hệ thống.
# ==============================================================================

# ------------------------------------------------------------------------------
# 1. Server Network & Port Configuration / Cấu hình mạng và cổng dịch vụ
# ------------------------------------------------------------------------------
# Listening network interface (0.0.0.0 listens on all available interfaces).
# Địa chỉ IP card mạng lắng nghe (0.0.0.0 để lắng nghe trên tất cả các cổng mạng).
SERVERFULL_HOST=0.0.0.0

# Standard UDP DNS listening port (RFC 1035, default: 53).
# Cổng lắng nghe DNS UDP truyền thống (RFC 1035, mặc định: 53).
SERVERFULL_UDP_PORT=53

# DNS-over-TLS (DoT) listening port (RFC 7858, default: 853).
# Cổng lắng nghe DNS mã hoá qua TLS / DoT (RFC 7858, mặc định: 853).
SERVERFULL_DOT_PORT=853

# Plain HTTP Web Dashboard and unencrypted DoH listening port (default: 80).
# Cổng HTTP cho giao diện Web quản trị và DoH không mã hoá (mặc định: 80 trong Docker/Production).
SERVERFULL_HTTP_PORT=80

# Secure HTTPS Web Dashboard and encrypted DoH listening port (default: 443).
# Cổng HTTPS cho giao diện Web bảo mật và DoH mã hoá (mặc định: 443 trong Docker/Production, cần có chứng chỉ TLS).
SERVERFULL_HTTPS_PORT=443

# Disable the standard UDP DNS listener (true/false, default: false).
# Tắt dịch vụ DNS UDP truyền thống (true/false, mặc định: false).
# SERVERFULL_DISABLE_UDP=false

# Disable the DNS-over-TLS (DoT) listener (true/false, default: false).
# Tắt dịch vụ DNS mã hoá qua TLS / DoT (true/false, mặc định: false).
# SERVERFULL_DISABLE_DOT=false

# Disable the HTTPS Web & DoH listener (true/false, default: false).
# Tắt dịch vụ HTTPS (true/false, mặc định: false).
# SERVERFULL_DISABLE_HTTPS=false

# Comma-separated list of trusted reverse proxy IP addresses or CIDR blocks (e.g. 127.0.0.1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16).
# When running behind a reverse proxy (Nginx, Caddy, Cloudflare, Traefik), enables reading real client IP from CF-Connecting-IP, X-Forwarded-For, or X-Real-IP.
# Private/loopback addresses and Cloudflare edge IPs (synced automatically) are always trusted; no need to list them here.
# Only add public proxies that are NOT Cloudflare.
# Danh sách địa chỉ IP hoặc dải mạng CIDR của reverse proxy tin cậy (ngăn cách bằng dấu phẩy).
# Khi đặt sau proxy (Nginx, Caddy, Cloudflare, Traefik), cho phép lấy đúng IP thật của client qua các header chuyển tiếp.
# IP nội bộ/loopback và IP edge của Cloudflare (tự đồng bộ) luôn được tin cậy, không cần khai ở đây.
# Chỉ thêm các proxy public KHÔNG phải Cloudflare.
# TRUSTED_PROXIES=127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16

# Max request body size in bytes for non-DoH endpoints (default: 8388608 = 8MB). DoH POST is always capped at 65535.
# Giới hạn kích thước body (byte) cho API thường (mặc định 8MB). DoH POST luôn bị chặn ở 65535.
# MAX_BODY_SIZE_BYTES=8388608

# ------------------------------------------------------------------------------
# 2. DNS-over-TLS (DoT) Domain & TLS Certificates / Tên miền DoT và chứng chỉ TLS
# ------------------------------------------------------------------------------
# Base domain name for DoT & HTTPS service (e.g. dns.example.com or *.dns.example.com).
# Tên miền chính cho dịch vụ DoT và HTTPS (dùng cho Android Private DNS và link DoH).
# SERVERFULL_DOT_DOMAIN=dns.example.com

# Absolute path to your TLS private key file in PEM format (Docker volume default: /etc/ssl/dns-worker/privkey.pem).
# Đường dẫn tuyệt đối đến file khoá riêng (private key) TLS định dạng PEM (mount Docker mặc định: /etc/ssl/dns-worker/privkey.pem).
# SERVERFULL_TLS_KEY_PATH=/etc/ssl/dns-worker/privkey.pem

# Absolute path to your TLS fullchain certificate file in PEM format (Docker volume default: /etc/ssl/dns-worker/fullchain.pem).
# Đường dẫn tuyệt đối đến file chứng chỉ (fullchain cert) TLS định dạng PEM (mount Docker mặc định: /etc/ssl/dns-worker/fullchain.pem).
# SERVERFULL_TLS_CERT_PATH=/etc/ssl/dns-worker/fullchain.pem

# ------------------------------------------------------------------------------
# 3. Encrypted Client Hello (ECH) / Cấu hình mã hoá ECH
# ------------------------------------------------------------------------------
# Enable Encrypted Client Hello (ECH) for HTTPS and TLS (default: true).
# Bật tính năng mã hoá ECH để che giấu tên miền truy cập khỏi nhà mạng (mặc định: true).
SERVERFULL_ECH_ENABLED=true

# Custom Base64-encoded ECHConfigList (optional, generated automatically if left empty).
# Chuỗi ECHConfigList mã hoá Base64 tuỳ chỉnh (tuỳ chọn, để trống sẽ tự sinh theo tên miền).
# SERVERFULL_ECH_CONFIG=

# Fronting domain (outer SNI public_name) used for ECH camouflage (default: cloudflare-ech.com).
# Tên miền mặt trước (outer SNI) dùng để ngụy trang gói tin ECH (mặc định: cloudflare-ech.com).
SERVERFULL_ECH_FRONTING_DOMAIN=cloudflare-ech.com

# ------------------------------------------------------------------------------
# 4. Database Configuration / Cấu hình cơ sở dữ liệu
# ------------------------------------------------------------------------------
# Database backend service type: File (local SQLite) or Turso (remote libSQL) (default: File).
# Loại cơ sở dữ liệu sử dụng: File (SQLite cục bộ) hoặc Turso (libSQL từ xa) (mặc định: File).
DATABASE_SERVICE=File

# File path to local SQLite database (default: /var/lib/dns-worker/dns_worker.sqlite on Linux/Docker).
# Đường dẫn lưu file SQLite cục bộ (Linux/Docker mặc định: /var/lib/dns-worker/dns_worker.sqlite).
# SERVERFULL_DB_PATH=

# SQLite in-memory page cache size in KiB (default: 32000 = 32 MiB; lower values reduce RAM usage).
# Kích thước bộ nhớ đệm trang SQLite tính bằng KiB (mặc định: 32000 = 32 MiB; giảm xuống nếu RAM hạn chế).
# SQLITE_CACHE_SIZE_KB=32000

# SQLite memory-mapped I/O (mmap) size in bytes (default: 67108864 = 64 MiB; lower values reduce process RSS).
# Dung lượng mmap cho đọc/ghi SQLite tính bằng byte (mặc định: 67108864 = 64 MiB; giảm xuống để hạ RSS RAM).
# SQLITE_MMAP_SIZE_BYTES=67108864

# SQLite -wal file is truncated back to this size after a checkpoint, in bytes (default: 67108864 = 64 MiB; minimum 1048576).
# File -wal của SQLite được cắt về kích thước này sau mỗi lần checkpoint, tính bằng byte (mặc định: 67108864 = 64 MiB; tối thiểu 1048576).
# SQLITE_WAL_SIZE_LIMIT_BYTES=67108864

# Run WAL checkpoints in a worker thread so COMMIT never copies the WAL into the database on the DNS thread (default: true; false = SQLite auto-checkpoint on the main thread).
# Chạy checkpoint WAL trong worker thread để COMMIT không phải copy WAL vào file DB trên luồng DNS (mặc định: true; false = SQLite tự checkpoint trên luồng chính).
# WAL_CHECKPOINT_WORKER=true

# How often the checkpoint worker runs a checkpoint, in milliseconds (default: 15000 = same rhythm as the log flush, minimum 1000). Idle databases cost nothing.
# Chu kỳ worker chạy checkpoint, tính bằng mili giây (mặc định: 15000, bằng nhịp ghi log; tối thiểu 1000). Database không có ghi mới thì không tốn gì.
# WAL_CHECKPOINT_INTERVAL_MS=15000

# Pages released per incremental_vacuum step after log cleanup (default: 256 = about 1 MiB; smaller = shorter pauses of the DNS thread, more steps).
# Số trang trả lại cho hệ điều hành mỗi bước incremental_vacuum sau khi dọn log (mặc định: 256 = khoảng 1 MiB; nhỏ hơn = luồng DNS dừng ngắn hơn nhưng nhiều bước hơn).
# SQLITE_RECLAIM_CHUNK_PAGES=256

# Minimum number of free pages before the periodic cleanup reclaims disk space (default: 2048 = about 8 MiB).
# Số trang trống tối thiểu để lần dọn định kỳ mới thu hồi dung lượng đĩa (mặc định: 2048 = khoảng 8 MiB).
# SQLITE_RECLAIM_MIN_FREE_PAGES=2048

# Disk space reclamation stops once this many free pages remain (default: 256).
# Việc thu hồi dung lượng dừng khi số trang trống còn lại không vượt quá giá trị này (mặc định: 256).
# SQLITE_RECLAIM_STOP_BELOW_PAGES=256

# Time budget of one periodic disk space reclamation run, in milliseconds (default: 30000, minimum 1000). Leftover pages are taken by the next run.
# Thời gian tối đa cho một lần thu hồi dung lượng định kỳ, tính bằng mili giây (mặc định: 30000, tối thiểu 1000). Phần còn lại để lần sau xử lý tiếp.
# SQLITE_RECLAIM_MAX_MS=30000

# Remote Turso database connection URL (e.g. libsql://your-db.turso.io, used when DATABASE_SERVICE=Turso).
# URL kết nối database Turso từ xa (ví dụ: libsql://your-db.turso.io, dùng khi DATABASE_SERVICE=Turso).
# TURSO_DATABASE_URL=libsql://your-db-org.turso.io

# Authentication JWT token for remote Turso database (used when DATABASE_SERVICE=Turso).
# Token xác thực JWT cho database Turso từ xa (dùng khi DATABASE_SERVICE=Turso).
# TURSO_AUTH_TOKEN=your_turso_jwt_auth_token_here

# ------------------------------------------------------------------------------
# 5. Default Profile Routing / Định tuyến Profile mặc định
# ------------------------------------------------------------------------------
# Profile key used for queries arriving via plain UDP or DoT without an SNI profile match.
# Khoá Profile dùng cho các truy vấn DNS UDP hoặc DoT không chỉ định profile (để trống sẽ lấy profile đầu tiên).
# SERVERFULL_DEFAULT_PROFILE_KEY=your_default_profile_key_here

# ------------------------------------------------------------------------------
# 6. Security, JWT & Session Secrets / Bảo mật, JWT và phiên đăng nhập
# ------------------------------------------------------------------------------
# Secret key for JWT session tokens (min 32 chars; auto-generated and saved if left empty).
# Khoá bí mật ký token JWT phiên đăng nhập (tối thiểu 32 ký tự; để trống sẽ tự sinh ngẫu nhiên).
# JWT_SECRET=replace_with_a_secure_random_jwt_secret_string_32chars_min

# Key Encryption Key (KEK) for envelope encryption of sensitive fields like 2FA/TOTP secrets.
# Khoá mã hoá cấp 2 (KEK) dùng để mã hoá phong bì các dữ liệu nhạy cảm như khoá 2FA/TOTP.
# KEK_v1=replace_with_a_secure_random_kek_secret

# Session duration for standard logins in minutes (default: 1440 = 24 hours).
# Thời hạn của phiên đăng nhập thông thường tính bằng phút (mặc định: 1440 = 24 giờ).
# DEFAULT_SESSION_EXPIRATION_MINUTES=1440

# Session duration when 'Remember Me' is selected, in days (default: 7).
# Thời hạn phiên đăng nhập khi tích chọn 'Ghi nhớ đăng nhập', tính bằng ngày (mặc định: 7).
# OPTIONAL_SESSION_EXPIRATION_DAYS=7

# Short-lived access token expiration time in minutes (default: 10).
# Thời hạn của token truy cập ngắn hạn tính bằng phút (mặc định: 10).
# ACCESS_TOKEN_EXPIRATION_MINUTES=10

# Maximum allowed distance in km between login location and current request (default: 50).
# Khoảng cách địa lý tối đa cho phép (km) giữa IP đăng nhập và IP truy cập hiện tại (mặc định: 50).
# SESSION_GEO_DISTANCE_KM=50

# TTL for temporary 2FA/TOTP verification session during login in seconds (default: 300 = 5 minutes).
# Thời gian chờ xác thực mã 2FA/TOTP khi đăng nhập tính bằng giây (mặc định: 300 = 5 phút).
# PREAUTH_TTL_SECONDS=300

# Minimum interval in seconds between database writes for updating session last-active status (default: 60).
# Giãn cách tối thiểu giữa các lần ghi thời gian hoạt động của phiên vào DB (giây, mặc định: 60).
# SESSION_LAST_ACTIVE_UPDATE_INTERVAL=60

# In-memory authentication cache TTL for dashboard requests in seconds (default: 30).
# Thời gian lưu cache RAM cho việc xác thực người dùng trong các request web (giây, mặc định: 30).
# AUTH_CACHE_TTL_SEC=30

# ------------------------------------------------------------------------------
# 7. DNS Upstream & Fallback Settings / Máy chủ DNS thượng nguồn và dự phòng
# ------------------------------------------------------------------------------
# Fallback upstream DNS used when no rules match or during emergency fail-open (DoH/DoT/TCP/DNS Stamps).
# Máy chủ DNS dự phòng khi không khớp quy tắc nào hoặc khi hệ thống gặp sự cố (hỗ trợ DoH, DoT, TCP).
FAIL_OPEN_UPSTREAM=https://freedns.controld.com/no-ads-malware-typo

# Auxiliary domain used to bootstrap and resolve IP addresses for DoH hostnames (default: www.okx.com).
# Tên miền phụ trợ dùng để phân giải địa chỉ IP khởi tạo cho các máy chủ DoH (mặc định: www.okx.com).
SUBSTITUTE_DOMAIN=www.okx.com

# Upstream DoH HTTP/2 speculative hedging delay in milliseconds (RFC 8484, default: 100, min: 20).
# If the first HTTP/2 session does not respond within this window, a parallel request is sent on a fresh session to eliminate tail latency.
# Độ trễ kích hoạt truy vấn DoH HTTP/2 dự phòng (hedging) tính bằng mili giây (RFC 8484, mặc định: 100, tối thiểu: 20).
# Nếu kết nối đầu tiên chưa phản hồi kịp, một request song song sẽ được bắn trên session mới để triệt tiêu độ trễ đuôi (tail latency).
# DOH_H2_HEDGE_MS=100

# Throttle interval in seconds for updating profile last-active status in database (default: 3600 = 1 hour).
# Giãn cách tối thiểu giữa các lần cập nhật thời gian hoạt động của profile vào DB (giây, mặc định: 3600 = 1 giờ).
# THROTTLE_ACTIVE_SEC=3600

# How long a client IP is remembered as actively using this server's DNS in seconds (default: 60).
# Thời gian ghi nhớ một IP thiết bị đang dùng DNS của máy chủ này (giây, mặc định: 60, dùng cho Debug API).
# ACTIVE_DNS_CACHE_TTL=60

# ------------------------------------------------------------------------------
# 8. In-Memory Cache Limits (L1 RAM) / Giới hạn bộ nhớ đệm RAM L1
# ------------------------------------------------------------------------------
# Maximum RAM budget in bytes for caching 64-bit domain filter tables (default: 268435456 = 256 MiB).
# Ngân sách RAM tối đa cho cache bảng lọc tên miền 64-bit (byte, mặc định 256 MiB; VPS 1GB+ có thể nâng 256-512 MiB).
# FILTER_MEM_BYTES=268435456

# In-memory retention time for profile filter tables in milliseconds (default: 0 = never expire by time; managed by ByteCappedMap and sync invalidation).
# Thời gian lưu bảng lọc của profile trong RAM (mili giây, mặc định: 0 = lưu vĩnh viễn đến khi có sync mới hoặc bị đẩy bởi FILTER_MEM_BYTES).
# FILTER_MEM_TTL=0

# In-memory retention time for profile settings & rules in milliseconds (default: 0 = never expire by time; managed by CONFIG_CACHE_LIMIT and instant clearCache).
# Thời gian lưu cấu hình và quy tắc của profile trong RAM (mili giây, mặc định: 0 = lưu vĩnh viễn đến khi user chỉnh sửa hoặc bị đẩy bởi CONFIG_CACHE_LIMIT).
# CONFIG_MEM_TTL=0

# Maximum number of profiles whose settings & metadata are cached in RAM (default: 5000).
# Số lượng profile tối đa được lưu cấu hình trong RAM L1 (mặc định: 5000).
# CONFIG_CACHE_LIMIT=5000

# Maximum number of resolved DNS query answers cached in RAM (default: 50000).
# Expired TTL records are lazy-evicted on query and swept from RAM every CLEANUP_INTERVAL_SEC.
# Số bản ghi DNS query tối đa được cache trong RAM L1 (mặc định: 50000).
# Bản ghi hết hạn TTL sẽ tự xoá khi có truy vấn hoặc được dọn sạch định kỳ theo CLEANUP_INTERVAL_SEC.
# DNS_CACHE_LIMIT=50000

# Maximum number of "blocked domain already logged" marks kept in RAM (default: 50000).
# A blocked domain is written to the log once per profile; later blocked queries only bump rollup counters.
# Marks are dropped when the profile config changes or when log rows of that profile are deleted.
# Số dấu "tên miền bị chặn đã được ghi log" tối đa lưu trong RAM (mặc định: 50000).
# Mỗi tên miền bị chặn chỉ ghi log một lần cho mỗi profile; các lần chặn sau chỉ tăng bộ đếm rollup.
# Dấu bị xoá khi cấu hình profile đổi hoặc khi profile đó bị xoá bớt dòng log.
# BLOCK_LOG_MARK_LIMIT=50000

# How long (seconds) a REDIRECT answer built only from the rule (fixed IP, TXT or CNAME) stays cached in RAM (default: 31536000 = 1 year, i.e. until cleared).
# Safe because any rule/setting change clears the profile's cache. Cache hits are counted, not logged. Records sent to clients keep their own 60s TTL.
# A CNAME redirect that resolves the target's addresses follows the target's real TTL instead.
# Thời gian (giây) một câu trả lời REDIRECT chỉ dựa trên rule (IP cố định, TXT hoặc CNAME) được giữ trong RAM (mặc định: 31536000 = 1 năm, tức là đến khi bị xoá).
# An toàn vì mọi thay đổi rule/setting đều xoá cache của profile. Cache trúng chỉ được đếm, không ghi log. Bản ghi gửi cho client vẫn có TTL 60 giây.
# REDIRECT dạng CNAME có phân giải IP của đích thì theo TTL thật của đích.
# STATIC_REDIRECT_CACHE_TTL=31536000

# Maximum number of Profile Key mappings cached in RAM (default: 10000).
# Số lượng khoá Profile Key tối đa được ánh xạ trong RAM L1 (mặc định: 10000).
# PROFILE_KEY_CACHE_LIMIT=10000

# Maximum number of entries in Node.js simulated Cache API (default: 20000).
# Used for auxiliary data: GeoIP client IP lookups, active client presence, 2FA preauth, cron throttles, and L2 profile fallback.
# Does NOT limit DNS query cache (DNS_CACHE_LIMIT), profile configs (CONFIG_CACHE_LIMIT), or blocklists (FILTER_MEM_BYTES).
# Số bản ghi tối đa trong bộ nhớ đệm Cache API giả lập của Node.js (mặc định: 20000).
# [Bao hàm]: Dữ liệu phụ trợ hệ thống như bảng tra cứu GeoIP (IP client), thiết bị đang online (active DNS profile), cờ cron/hệ thống, xác thực 2FA tạm thời và L2 profile cache.
# [Lưu ý]: KHÔNG ảnh hưởng hay giới hạn DNS cache (DNS_CACHE_LIMIT), cấu hình profile (CONFIG_CACHE_LIMIT) hay danh sách chặn (FILTER_MEM_BYTES).
# MEMORY_CACHE_LIMIT=20000

# Maximum number of parsed custom rule patterns cached in RAM (default: 5000).
# Số lượng quy tắc tùy chỉnh (custom rules) đã phân tích cú pháp tối đa được lưu trong RAM (mặc định: 5000).
# RULE_PARSE_CACHE_LIMIT=5000

# Cloudflare Zone ID for global edge cache invalidation when running behind Cloudflare CDN proxy (optional).
# Mã định danh Zone của Cloudflare để tự động xoá cache toàn cầu khi thay đổi cấu hình profile (tuỳ chọn).
# CF_ZONE_ID=

# Cloudflare API Bearer token with 'Zone -> Cache Purge' permission (optional).
# Token API Cloudflare có quyền 'Zone -> Cache Purge' để tự động xoá cache proxy (tuỳ chọn).
# CF_PURGE_TOKEN=

# ------------------------------------------------------------------------------
# 9. Blocklist Parsing & Capacity Limits / Giới hạn dung lượng và quy tắc bộ lọc
# ------------------------------------------------------------------------------
# Maximum number of domains processed from a single blocklist during sync (default: 2000000).
# Số lượng tên miền tối đa xử lý từ một danh sách chặn trong một lần đồng bộ (mặc định: 2000000).
# MAX_LIST_DOMAINS=2000000

# Maximum file size allowed for a downloaded filter list in bytes (default: 104857600 = 100 MB).
# Dung lượng file tối đa cho phép khi tải về một danh sách bộ lọc (byte, mặc định: 100 MB = 104857600).
# MAX_LIST_BYTES=104857600

# Maximum number of regex & wildcard rules kept from a single blocklist URL (default: 1000).
# Số quy tắc regex & wildcard tối đa được giữ lại từ một danh sách bộ lọc (mặc định: 1000).
# MAX_REGEX_RULES=1000

# ------------------------------------------------------------------------------
# 10. Scheduled Tasks & List Sync (Cron) / Tác vụ định kỳ và đồng bộ danh sách (Cron)
# ------------------------------------------------------------------------------
# Automatic refresh interval for System Lists in seconds (default: 21600 = 6 hours).
# Chu kỳ tự động làm mới danh sách hệ thống dùng chung (giây, mặc định: 21600 = 6 giờ; hỗ trợ ETag 304).
# SYNC_SYSTEM_INTERVAL_SEC=21600

# Automatic refresh interval for user custom lists per profile in seconds (default: 86400 = 24 hours).
# Chu kỳ tự động làm mới các danh sách riêng của từng profile (giây, mặc định: 86400 = 24 giờ).
# SYNC_PROFILE_INTERVAL_SEC=86400

# Sleep time in seconds when no profile is due for sync before querying DB again (default: 1800 = 30 minutes).
# Thời gian chờ trước khi kiểm tra lại DB khi không có profile nào đến hạn đồng bộ (giây, mặc định: 1800 = 30 phút).
# SYNC_IDLE_INTERVAL_SEC=1800

# Number of profiles processed per cron tick, each syncing one list (default: 1).
# Số profile được xử lý trong mỗi lượt cron chạy, mỗi profile đồng bộ 1 danh sách (mặc định: 1).
# SYNC_BATCH_SIZE=1

# Minimum cooldown in seconds before forced re-downloading a recently synced system list (default: 60).
# Thời gian tối thiểu giữa các lần bắt buộc tải lại một system list khi bấm force sync (giây, mặc định: 60).
# SYNC_FORCE_COOLDOWN_SEC=60

# Network timeout in milliseconds when downloading external filter lists (default: 30000 = 30 seconds).
# Thời gian chờ tối đa khi tải danh sách bộ lọc từ internet (mili giây, mặc định: 30000 = 30 giây).
# SYNC_TIMEOUT_MS=30000

# Maximum retry attempts when a list download fails with a transient error (default: 2, 0 to disable).
# Số lần thử lại tối đa khi tải danh sách bị lỗi mạng tạm thời (mặc định: 2, đặt 0 để tắt).
# LIST_FETCH_MAX_RETRIES=2

# Base delay in milliseconds before the first download retry, doubles on each attempt (default: 1000).
# Độ trễ khởi đầu trước lần thử lại đầu tiên (mili giây, nhân đôi ở các lần sau, mặc định: 1000).
# LIST_FETCH_RETRY_DELAY_MS=1000

# Maximum HTTP redirects followed when downloading a filter list URL (default: 5).
# Số lần chuyển hướng HTTP (redirect) tối đa được chấp nhận khi tải danh sách (mặc định: 5).
# LIST_FETCH_MAX_REDIRECTS=5

# While parsing a large list, pause after every N domains to keep the server responsive (default: 5000).
# Số lượng tên miền phân tích trước khi nhường CPU một chút để server luôn mượt (mặc định: 5000).
# SYNC_YIELD_BATCH_SIZE=5000

# Pause duration in milliseconds during heavy list parsing (default: 10).
# Độ dài mỗi lần tạm nghỉ CPU khi phân tích danh sách lớn (mili giây, mặc định: 10).
# SYNC_YIELD_SLEEP_MS=10

# Entries processed per slice when deduplicating and indexing a large filter list (sync and load into RAM), then the server pauses so DNS queries keep flowing (default: 131072, minimum 4096).
# Số mục xử lý mỗi lát khi lọc trùng và dựng chỉ mục cho danh sách lớn (lúc sync và lúc nạp vào RAM), sau mỗi lát server nghỉ để các truy vấn DNS được phục vụ (mặc định: 131072, tối thiểu 4096).
# FILTER_YIELD_CHUNK_ITEMS=131072

# Pause in milliseconds between two slices of that work (default: 1, maximum 1000). A smaller chunk or a longer pause lowers the longest DNS stall but makes a list load slower.
# Thời gian nghỉ giữa hai lát (mili giây, mặc định: 1, tối đa 1000). Lát nhỏ hơn hoặc nghỉ lâu hơn thì độ đứng DNS dài nhất giảm, nhưng nạp list chậm hơn.
# FILTER_YIELD_SLEEP_MS=1

# How often the cleanup task runs to sweep expired DNS cache in RAM, delete expired logs, and purge inactive users in seconds (default: 600 = 10 minutes).
# Chu kỳ chạy tác vụ dọn dẹp hệ thống (quét DNS cache hết hạn trong RAM, xoá log và tài khoản hết hạn) tính bằng giây (mặc định: 600 = 10 phút, tối thiểu 60).
# CLEANUP_INTERVAL_SEC=600

# How often to refresh Cloudflare official IP ranges in seconds (default: 86400 = 1 day).
# Chu kỳ cập nhật dải IP chính thức của Cloudflare tính bằng giây (mặc định: 86400 = 1 ngày, tối thiểu 60).
# CF_IP_SYNC_INTERVAL_SEC=86400

# ------------------------------------------------------------------------------
# 11. Quotas, Retention & Inactivity Policy / Hạn mức, lưu trữ log và tài khoản rác
# ------------------------------------------------------------------------------
# Maximum number of profiles allowed per regular user (default: 10).
# Số lượng profile tối đa một người dùng thường có thể tạo (mặc định: 10).
# MAX_PROFILES_PER_USER=10

# Maximum number of access points allowed per profile (default: 100).
# Số lượng điểm truy cập (Access Point) tối đa cho mỗi profile (mặc định: 100).
# MAX_ACCESS_POINTS_PER_PROFILE=100

# Maximum number of custom filter lists allowed per profile (default: 5).
# Số danh sách bộ lọc tự thêm (custom list) tối đa trong một profile (mặc định: 5).
# MAX_CUSTOM_LISTS_PER_PROFILE=5

# Global hard cap on log retention days for ALL profiles across the server (default: 30).
# Mức trần toàn hệ thống cho số ngày lưu trữ nhật ký truy vấn DNS của mọi profile (mặc định: 30 ngày).
# MAX_LOG_RETENTION_DAYS=30

# Hard cap on log retention days for admin accounts (default: 30).
# Mức trần số ngày lưu log cho tài khoản quản trị viên (mặc định: 30 ngày, không vượt quá MAX_LOG_RETENTION_DAYS).
# ADMIN_USER_MAX_LOG_RETENTION_DAYS=30

# Default log retention days applied to newly created admin profiles (default: 7).
# Số ngày lưu log mặc định khi tạo mới profile cho tài khoản admin (mặc định: 7 ngày).
# DEFAULT_LOG_RETENTION_DAYS=7

# Hard cap on log retention days for regular user accounts (default: 1).
# Mức trần số ngày lưu log cho tài khoản người dùng thông thường (mặc định: 1 ngày).
# NORMAL_USER_MAX_LOG_RETENTION_DAYS=1

# Default log retention days applied to newly created regular user profiles (default: 1).
# Số ngày lưu log mặc định khi tạo mới profile cho người dùng thường (mặc định: 1 ngày).
# NORMAL_USER_DEFAULT_LOG_RETENTION_DAYS=1

# Hard cap on stored log rows per profile on SQLite to prevent disk fill-up (default: 500000, 0 = no cap).
# Số dòng log tối đa lưu cho mỗi profile trong SQLite để chống đầy ổ cứng (mặc định: 500000, 0 = không giới hạn).
# MAX_LOGS_PER_PROFILE=500000

# SQLite disk space reclamation mode after log deletion (INCREMENTAL recovers space gradually, NONE disables it).
# Chế độ thu hồi dung lượng đĩa của SQLite sau khi xoá log (INCREMENTAL giải phóng dần, NONE để tắt).
# AUTO_VACUUM=INCREMENTAL

# Inactivity period in days with zero DNS queries before an unused profile and its logs are auto-cleared (default: 30, 0 to disable).
# Số ngày liên tiếp không có truy vấn DNS để tự động xoá profile và log không hoạt động (mặc định: 30, 0 = tắt).
# INACTIVITY_THRESHOLD_DAYS=30

# Inactivity period in days with zero logins before a zombie user account is deleted (default: 90, 0 to disable).
# Số ngày liên tiếp không đăng nhập để tự động xoá tài khoản người dùng bị bỏ hoang (mặc định: 90, 0 = tắt).
# INACTIVITY_USER_DAYS=90

# Number of log rows deleted per chunk across all log deletions (cron cleanup, row-cap trimming, manual purges, profile/user deletion; default: 2500).
# Keeping this between 2000-3000 prevents long synchronous SQLite locks, ensuring real-time DNS resolution is never blocked.
# Số dòng log được xoá trong mỗi mẻ nhỏ cho mọi thao tác xoá log (cron dọn dẹp định kỳ, cắt trần log, xoá log thủ công, xoá profile/tài khoản; mặc định: 2500).
# Giữ giá trị này trong khoảng 2000-3000 để tránh khoá đồng bộ SQLite quá lâu, đảm bảo phân giải DNS không bị đứng hay gián đoạn.
# LOG_CLEANUP_CHUNK_SIZE=2500

# Pause duration in milliseconds between cleanup chunks (and between chunks of a cache-hit counter backlog) to yield the event loop and keep DNS responsive (default: 10).
# Độ dài mỗi lần tạm nghỉ (sleep nhường event loop) giữa các mẻ xoá log và giữa các mẻ ghi bộ đếm cache hit để phân giải DNS luôn mượt (mili giây, mặc định: 10).
# LOG_CLEANUP_YIELD_SLEEP_MS=10

# Cache hits are served from RAM without a log row; they are counted in memory and written into the hourly analytics rollups every 15s.
# Maximum counter rows written per db.batch() (default: 200, min: 20). Larger backlogs are written in several chunks separated by LOG_CLEANUP_YIELD_SLEEP_MS.
# Cache hit không ghi log chi tiết mà được đếm trong RAM rồi ghi vào bảng thống kê theo giờ mỗi 15 giây.
# Số dòng bộ đếm tối đa ghi trong mỗi db.batch() (mặc định: 200, tối thiểu: 20). Phần dư được ghi thành nhiều mẻ, nghỉ giữa các mẻ theo LOG_CLEANUP_YIELD_SLEEP_MS.
# CACHE_HIT_FLUSH_CHUNK_SIZE=200

# Maximum log rows waiting in RAM for the database (default: 10000; values below 100 are ignored). Each flush writes only a few dozen rows per round trip, so a slow or failing database would otherwise let this queue grow without limit. When it is full, new logs are dropped (a rate-limited warning shows how many); statistics from cache-hit counters are unaffected.
# Số dòng log tối đa chờ ghi trong RAM (mặc định: 10000; giá trị dưới 100 bị bỏ qua). Mỗi lần flush chỉ ghi vài chục dòng, nên khi database chậm hoặc lỗi kéo dài hàng đợi sẽ phình vô hạn. Khi đầy, log mới bị bỏ (có cảnh báo giới hạn tần suất cho biết số dòng đã bỏ). Mỗi dòng log chiếm khoảng 1 KB RAM.
# LOG_QUEUE_MAX_ROWS=10000

# Maximum expired log rows deleted per cleanup cycle (default: 0 = unlimited, cleans all expired logs in chunks).
# Giới hạn trần số dòng log được xoá trong một lượt dọn dẹp (mặc định: 0 = không giới hạn, dọn sạch toàn bộ log hết hạn).
# LOG_CLEANUP_BATCH_LIMIT=0

# Daily hard cap on expired log rows deleted across all profiles (default: 0 = unlimited on local SQLite; metered D1 uses 20000).
# Hạn mức xoá log tối đa cả ngày (24 giờ) (mặc định: 0 = không giới hạn trên Serverfull; chỉ Cloudflare D1 mới cần đặt hạn mức).
# LOG_CLEANUP_DAILY_BUDGET=0

# Minimum age in seconds before an unused log encryption key (kem_key) can be deleted (default: 86400 = 24 hours).
# Thời gian tối thiểu (giây) một khoá mã hoá log vô thừa nhận phải tồn tại trước khi được xoá (mặc định: 86400 = 24 giờ).
# LOG_ORPHAN_KEY_MIN_AGE_SEC=86400

# Maximum unused log encryption keys deleted per cleanup cycle (default: 100).
# Số lượng khoá mã hoá log vô thừa nhận tối đa bị xoá trong mỗi lượt dọn dẹp (mặc định: 100).
# LOG_ORPHAN_KEY_BATCH_LIMIT=100

# Minimum query count threshold for domain hourly rollup aggregation (default: 1, filters single-query noise domains).
# Ngưỡng số lượng truy vấn tối thiểu của một tên miền để tổng hợp vào báo cáo thống kê theo giờ (mặc định: 1, lọc bỏ tên miền rác chỉ xuất hiện 1 lần).
# DOMAIN_ROLLUP_MIN_COUNT=1

# Minimum pause in seconds between two manual clicks on the Refresh button of Query Logs and Analytics (default: 3, 0 = no limit). Applies per user, per profile and per tab; during the pause the button is disabled with a countdown and the server answers 429. Normal loading, scrolling, searching and filtering are not affected.
# Thời gian nghỉ tối thiểu (giây) giữa hai lần bấm nút Refresh ở tab Query Logs và Analytics (mặc định: 3, 0 = không giới hạn). Tính riêng cho từng người dùng, từng profile và từng tab; trong lúc chờ nút bị khoá kèm đếm ngược và server trả về 429. Việc tải, cuộn, tìm kiếm và lọc thông thường không bị ảnh hưởng.
# REFRESH_COOLDOWN_SEC=3

# ------------------------------------------------------------------------------
# 12. Authentication Rate Limits / Giới hạn tần suất xác thực và chống dò mật khẩu
# ------------------------------------------------------------------------------
# Maximum failed login attempts allowed per IP within the window before temporary lockout (default: 10).
# Số lần đăng nhập sai tối đa của mỗi IP trước khi bị khoá tạm thời (mặc định: 10).
# LOGIN_MAX_ATTEMPTS=10

# Login lockout window duration in seconds (default: 900 = 15 minutes).
# Khoảng thời gian khoá đăng nhập tạm thời tính bằng giây (mặc định: 900 = 15 phút).
# LOGIN_LOCK_WINDOW_SEC=900

# Maximum account sign-ups allowed per IP within the window (default: 10).
# Số lượt đăng ký tài khoản mới tối đa cho mỗi IP trong một khoảng thời gian (mặc định: 10).
# SIGNUP_MAX_PER_WINDOW=10

# Sign-up rate limiting window duration in seconds (default: 60).
# Khoảng thời gian tính giới hạn đăng ký tài khoản tính bằng giây (mặc định: 60).
# SIGNUP_WINDOW_SEC=60

# Maximum password reset attempts allowed per IP within the window (default: 10).
# Số lần yêu cầu đặt lại mật khẩu tối đa của mỗi IP trong một khoảng thời gian (mặc định: 10).
# FORGOT_PASSWORD_MAX_ATTEMPTS=10

# Password reset rate limiting window duration in seconds (default: 600 = 10 minutes).
# Khoảng thời gian tính giới hạn đặt lại mật khẩu tính bằng giây (mặc định: 600 = 10 phút).
# FORGOT_PASSWORD_WINDOW_SEC=600

# Maximum failed session-refresh attempts allowed per IP within the window (default: 20).
# Số lần làm mới phiên đăng nhập thất bại tối đa của mỗi IP trước khi bị chặn (mặc định: 20).
# REFRESH_MAX_FAILURES=20

# Session-refresh rate limiting window duration in seconds (default: 60).
# Khoảng thời gian tính giới hạn làm mới phiên thất bại tính bằng giây (mặc định: 60).
# REFRESH_WINDOW_SEC=60

# Wrong unlock-PIN attempts allowed before the session is destroyed and user logged out (default: 3).
# Số lần nhập sai mã PIN tối đa trước khi phiên bị huỷ và người dùng bị đăng xuất (mặc định: 3).
# PIN_MAX_ATTEMPTS=3

# Time window in seconds for tracking wrong PIN attempts (default: 900 = 15 minutes).
# Khoảng thời gian ghi nhớ các lần nhập sai mã PIN tính bằng giây (mặc định: 900 = 15 phút).
# PIN_LOCK_WINDOW_SEC=900

# Timeout in milliseconds for Passkey / WebAuthn user interaction prompt (default: 60000 = 60s, min 1000).
# Thời gian tối đa chờ người dùng thao tác xác thực Passkey / WebAuthn (mili giây, mặc định: 60000 = 60 giây).
# WEBAUTHN_TIMEOUT_MS=60000

# ------------------------------------------------------------------------------
# 13. Preset Upstream Services & External Filters / Danh sách máy chủ và bộ lọc gợi ý sẵn
# ------------------------------------------------------------------------------
# Built-in upstream DNS resolvers selectable in the dashboard (JSON array string).
# Danh sách các máy chủ DNS thượng nguồn dựng sẵn để người dùng chọn trên giao diện web (chuỗi JSON).
PRESET_UPSTREAMS='[{"label":"settings.presetCloudflareSecurity","url":"https://security.cloudflare-dns.com/dns-query"},{"label":"settings.presetCloudflareFamilies","url":"https://family.cloudflare-dns.com/dns-query"},{"label":"Cloudflare","url":"https://cloudflare-dns.com/dns-query"},{"label":"settings.presetQuad9","url":"tls://dns.quad9.net"},{"label":"settings.presetQuad9Ecs","url":"tls://dns11.quad9.net"},{"label":"settings.presetControlDFree","url":"https://freedns.controld.com/no-ads-malware-typo"},{"label":"settings.presetControlDUncensored","url":"https://freedns.controld.com/uncensored"},{"label":"settings.presetAdGuard","url":"https://dns.adguard-dns.com/dns-query"},{"label":"settings.presetAdGuardFamily","url":"https://family.adguard-dns.com/dns-query"},{"label":"Cloudflare Security (1.1.1.2)","url":"tcp://1.1.1.2:53"},{"label":"Cloudflare (1.1.1.1)","url":"tcp://1.1.1.1:53"},{"label":"Quad9 ECS (9.9.9.11)","url":"tcp://9.9.9.11:9953"},{"label":"Google (8.8.8.8)","url":"tcp://8.8.8.8:53"}]'

# Recommended blocklists and whitelists selectable in the dashboard (JSON array string).
# Danh sách các bộ lọc chặn và ngoại lệ phổ biến được gợi ý sẵn trên giao diện web (chuỗi JSON).
PRESET_EXTERNAL_FILTERS='[{"label":"Blocklist (ABPVN + AdGuard DNS + 1Hosts Lite)","url":"https://lists.bibica.net/blocklists.txt"},{"label":"Whitelist (ShadowWhisperer)","url":"https://lists.bibica.net/whitelist.txt"},{"label":"DNS Rewrites","url":"https://lists.bibica.net/rewrites.txt"},{"label":"HaGeZi Light","url":"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/light.txt"},{"label":"HaGeZi Multi NORMAL","url":"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/multi.txt"},{"label":"HaGeZi Pro","url":"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt"},{"label":"HaGeZi Pro++","url":"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.plus.txt"},{"label":"HaGeZi Ultimate","url":"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/ultimate.txt"},{"label":"HaGeZi Threat Intelligence (Medium)","url":"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/tif.medium.txt"},{"label":"HaGeZi NSFW","url":"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/nsfw.txt"},{"label":"StevenBlack Unified Hosts","url":"https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts"},{"label":"OISD Big","url":"https://big.oisd.nl"},{"label":"OISD NSFW","url":"https://nsfw.oisd.nl"}]'

# Filter list URLs automatically assigned to newly registered profiles (comma/newline-separated or JSON array).
# Danh sách URL bộ lọc tự động kích hoạt cho mọi profile mới đăng ký (ngăn cách bằng dấu phẩy, dòng mới hoặc JSON).
# DEFAULT_PROFILE_FILTER_URLS=''

# Shared global system filter URLs preloaded into RAM for all profiles (Tier 1 filtering, defaults to PRESET_EXTERNAL_FILTERS if empty).
# Danh sách URL bộ lọc hệ thống dùng chung được nạp sẵn vào RAM cho mọi profile (tầng lọc Tier 1, để trống sẽ lấy từ PRESET_EXTERNAL_FILTERS).
# SYSTEM_FILTER_URLS=''

# Outer SNI domains used for Encrypted Client Hello (ECH) fronting (JSON array string).
# Danh sách tên miền ngụy trang outer SNI dùng cho công nghệ mã hoá ECH (chuỗi JSON).
PRESET_ECH_FRONTING_DOMAINS='["cloudflare-ech.com","crypto.cloudflare.com","one.one.one.one","www.cloudflare.com","encryptedsni.com","cdnjs.com"]'

# ------------------------------------------------------------------------------
# 14. UI & Branding Customization / Tùy biến giao diện và thương hiệu
# ------------------------------------------------------------------------------
# Application name displayed in the top-left sidebar and browser title (default: "DNS Shield").
# Tên ứng dụng hiển thị ở góc trên bên trái thanh điều hướng và tiêu đề trình duyệt (mặc định: "DNS Shield").
# APP_NAME="DNS Shield"

# Custom logo image URL for the sidebar and login screens. Leave empty to use the logo bundled in the app (web/src/assets).
# Đường dẫn logo hiển thị ở thanh điều hướng và màn hình đăng nhập. Để trống sẽ dùng logo có sẵn trong app (web/src/assets).
# APP_LOGO_URL=""

# Custom favicon URL for browser tabs (default: "/favicon.png", served from web/public).
# Đường dẫn biểu tượng favicon trên tab trình duyệt (mặc định: "/favicon.png", lấy từ web/public).
# APP_FAVICON_URL="/favicon.png"

# Enable or disable the GitHub Corner ribbon in the bottom-right corner (default: true).
# Bật hoặc tắt biểu tượng GitHub ở góc dưới bên phải giao diện (mặc định: true, đặt false để ẩn).
# GITHUB_CORNER_ENABLED=true

# Destination URL when clicking the GitHub ribbon (default: "https://github.com/bibicadotnet/ObexDNS").
# Đường dẫn khi bấm vào biểu tượng GitHub ở góc dưới bên phải (mặc định: "https://github.com/bibicadotnet/ObexDNS").
# GITHUB_CORNER_URL="https://github.com/bibicadotnet/ObexDNS"

# Package download URL for Windows DoH & Zapret DPI bypass installer (default: GitHub Releases).
# Đường dẫn tải gói cài đặt dnsproxy & Zapret DPI bypass cho Windows (mặc định từ GitHub Releases).
# WINDOWS_TOOLS_URL="https://github.com/bibicadotnet/ObexDNS/releases/download/windows-tools-setup/windows-tools-setup.zip"
`;

/**
 * Initializes or seeds a persistent configuration file with the default template.
 *
 * @param targetPath - Absolute or relative file path to write.
 * @param force - If true, overwrite existing file.
 * @returns Object with success flag and message.
 */
export function writeDefaultConfigFile(targetPath: string, force: boolean = false): { created: boolean; path: string } {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  }

  if (fs.existsSync(targetPath) && !force) {
    return { created: false, path: targetPath };
  }

  fs.writeFileSync(targetPath, DEFAULT_ENV_SERVERFULL_TEMPLATE, { encoding: 'utf-8', mode: 0o644 });
  if (process.platform === 'linux' && process.env.SUDO_USER && process.env.SUDO_USER !== 'root') {
    const sudoUser = process.env.SUDO_USER.trim();
    if (/^[a-zA-Z0-9._-]+$/.test(sudoUser)) {
      try {
        execFileSync('chown', [sudoUser, targetPath]);
      } catch {}
    }
  }
  return { created: true, path: targetPath };
}
