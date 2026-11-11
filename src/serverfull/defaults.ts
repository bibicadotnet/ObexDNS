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
# ==============================================================================
# You can edit this file directly, or copy it to .env:
#   可以直接在此文件修改配置，亦可选择复制为 .env (cp .env.serverfull .env)
# The server will automatically load .env, .env.serverfull, or system persistent .env.
# ==============================================================================

# ------------------------------------------------------------------------------
# Server Network & Port Configuration / 服务网络与端口监听
# ------------------------------------------------------------------------------
# Listening host / 监听网卡地址 (0.0.0.0 listens on all interfaces)
SERVERFULL_HOST=0.0.0.0

# Classic UDP DNS listening port / 经典 UDP DNS 监听端口 (RFC 1035, default: 53)
SERVERFULL_UDP_PORT=53

# DNS over TLS (DoT) listening port / 加密 DoT 监听端口 (RFC 7858, default: 853)
SERVERFULL_DOT_PORT=853

# Plain HTTP Web Dashboard & DoH listening port / HTTP Web 管理面板与 DoH 监听端口 (default: 10080)
SERVERFULL_HTTP_PORT=10080

# Secure HTTPS Web Dashboard & DoH listening port / HTTPS Web 管理面板与 DoH 监听端口 (default: 10443)
# HTTPS 服务在配置了有效 TLS 证书时自动启用；未配置证书或文件不存在时仅启用 HTTP 服务
SERVERFULL_HTTPS_PORT=10443

# ------------------------------------------------------------------------------
# DNS over TLS (DoT) Domain & TLS Certificates / 加密 DoT 域名与 TLS 证书配置
# ------------------------------------------------------------------------------
# Base domain name for DoT & HTTPS service / DoT 与 HTTPS 服务对外基准域名
# 用于 Android 原生私有 DNS 以及 Web 面板接入点引导展示 (如 dns.example.com)
# - 若持有通配符证书 (*.dns.example.com): 客户端填入 <profileKey>.dns.example.com 实现精准路由
# - 若持有单域名证书 (dns.example.com): 客户端直接填入 dns.example.com 自动路由至默认配置
#
# 提示: 若尚未申请证书，可使用 certbot 申请免费通配符证书:
#   certbot certonly -d *.your.domain -d your.domain --manual --preferred-challenges dns
# SERVERFULL_DOT_DOMAIN=dns.example.com

# Absolute path to your TLS private key (PEM format) / TLS 私钥路径 (兼容 SERFULL_TLS_KEY_PATH)
SERVERFULL_TLS_KEY_PATH=/etc/letsencrypt/live/dns.example.com/privkey.pem

# Absolute path to your TLS certificate chain (PEM format) / TLS 证书/公钥路径 (兼容 SERVERFULL_TLS_PUB_PATH)
SERVERFULL_TLS_CERT_PATH=/etc/letsencrypt/live/dns.example.com/fullchain.pem

# ------------------------------------------------------------------------------
# ECH, HTTP/3 & DNS over QUIC (DoQ) / 加密 ECH、HTTP/3 与 DoQ 配置
# ------------------------------------------------------------------------------
# Broadcast & enable ECH for HTTPS & TLS / 为 HTTPS 与 TLS 广播并启用 ECH (true/false, default: true)
# 客户端查询 RFC 9460 HTTPS/SVCB 及 RFC 9460 Section 8 DDR 时自动合成携带 ECHConfig 参数的响应
SERVERFULL_ECH_ENABLED=true

# Custom Base64-encoded ECHConfigList / 自定义 Base64 格式 ECHConfigList (选填，留空则根据外层域名自动生成)
# SERVERFULL_ECH_CONFIG=

# Fronting domain (outer SNI public_name) for ECH / ECH 外层 SNI 前置域名 (默认: cloudflare-ech.com)
SERVERFULL_ECH_FRONTING_DOMAIN=cloudflare-ech.com

# ------------------------------------------------------------------------------
# Database Configuration / 数据库配置 (Local SQLite 或远程 Turso / libSQL)
# ------------------------------------------------------------------------------
# Database service backend / 数据库后端服务选择 (D1 / Turso / File)
# Serverless (Cloudflare Workers) mode defaults to D1; Serverfull mode defaults to File.
# Serverless 模式下默认使用 D1，Serverfull 模式下默认使用 File (本地 SQLite)。
# Options / 可选值: D1, Turso, File
DATABASE_SERVICE=File

# Local SQLite database file path / 本地 SQLite 数据库文件存储路径
# Default: Linux: /var/lib/dns-worker/dns_worker.sqlite, Windows: %ProgramData%\\DNS-Worker\\dns_worker.sqlite
# 默认值: Linux 使用 /var/lib/dns-worker/dns_worker.sqlite, Windows 使用 %ProgramData%\\DNS-Worker\\dns_worker.sqlite
# Automatically applies all migrations on startup / 启动时自动执行表结构初始化与迁移
# SERVERFULL_DB_PATH=

# Turso (libSQL) Remote Database / 远程 Turso 分布式数据库配置 (选填)
# When configured, DNS Worker automatically switches from local SQLite to Turso and runs schema migrations.
# 当配置了 TURSO_DATABASE_URL 与 TURSO_AUTH_TOKEN 时，系统将自动使用 Turso 远程数据库替代本地 SQLite。
# Supports both libsql:// and https:// URLs (e.g. libsql://your-db-org.turso.io)
# TURSO_DATABASE_URL=libsql://your-db-org.turso.io
# TURSO_AUTH_TOKEN=your_turso_jwt_auth_token_here

# ------------------------------------------------------------------------------
# Default Profile Routing / 默认解析配置路由
# ------------------------------------------------------------------------------
# Profile key to use for queries arriving via UDP or DoT without SNI matching
# 经典 UDP DNS 或无 SNI 匹配的 DoT 请求所使用的默认 Profile Key。留空则默认自动使用首个创建的 Profile。
# SERVERFULL_DEFAULT_PROFILE_KEY=your_default_profile_key_here

# ------------------------------------------------------------------------------
# Security & Session Secret / 会话安全与密钥配置
# ------------------------------------------------------------------------------
# Secret key for JWT session token signing (Please replace with a strong random string!)
# JWT 会话签名密钥 (留空时程序会自动在数据目录生成并持久化 256 位安全随机密钥)
# JWT_SECRET=replace_with_a_secure_random_jwt_secret_string_32chars_min

# (Optional) Key Encryption Key for sensitive fields envelope encryption (e.g. TOTP secrets)
# (选填) 敏感数据信封加密密钥 (如 TOTP 密钥及恢复密钥)
# KEK_v1=replace_with_a_secure_random_kek_secret

# Session duration for authenticated users by default (in minutes) / 默认会话有效期 (分钟)
# DEFAULT_SESSION_EXPIRATION_MINUTES=1440

# Session duration for authenticated users when keeping logged in option is selected (in days) / 记住登录态会话有效期 (天)
# OPTIONAL_SESSION_EXPIRATION_DAYS=7

# Access Token expiration time (in minutes) / 短效访问令牌有效期 (分钟)
# ACCESS_TOKEN_EXPIRATION_MINUTES=1

# Maximum allowed distance (in km) between session login and current request / 会话异地登录允许的最大距离 (公里)
# SESSION_GEO_DISTANCE_KM=50

# TTL for temporary pre-auth session during login (in seconds) / 登录双因素认证临时预认证会话有效期 (秒)
# PREAUTH_TTL_SECONDS=300

# Throttle interval for updating session "last active" status in database (in seconds) / 会话活跃时间写入数据库节流间隔 (秒)
# SESSION_LAST_ACTIVE_UPDATE_INTERVAL=60

# In-memory authentication micro-cache TTL for dashboard requests (in seconds) / 鉴权内存微缓存有效期 (秒)
# AUTH_CACHE_TTL_SEC=30

# ------------------------------------------------------------------------------
# DNS Upstream & Fallback Settings / DNS 上游与回退配置
# ------------------------------------------------------------------------------
# Fail-open upstream when no matching rules/filters are hit, or during emergency fallback
# 兜底回退上游 DNS 地址 (支持 HTTPS/DoH、TLS/DoT 如 tls://1.1.1.1、TCP 如 tcp://1.1.1.1:53、DNS Stamps sdns://)
FAIL_OPEN_UPSTREAM=https://freedns.controld.com/no-ads-malware-typo

# Substitute domain for resolving DoH domain names
# 用于解析 DoH 域名 IP 的辅助域名
SUBSTITUTE_DOMAIN=www.okx.com

# Throttle interval for updating profile "last active" status (in seconds) / 活跃状态写入节流时间间隔 (秒)
# THROTTLE_ACTIVE_SEC=3600

# How long a client IP is remembered as "actively using this server's DNS" (in seconds, default 60)
# Thời gian ghi nhớ một IP client là "đang dùng DNS của máy chủ này" (giây, mặc định 60).
# Used by the dashboard's connection check / Debug API to detect which profile a device is using.
# Dùng cho chức năng kiểm tra kết nối / Debug API trên web để nhận biết thiết bị đang dùng profile nào.
# ACTIVE_DNS_CACHE_TTL=60

# ------------------------------------------------------------------------------
# Blocklist Sync & Bloom Filter Settings (Optional) / 规则同步与布隆过滤器配置 (选填)
# ------------------------------------------------------------------------------
# Bloom Filter false positive rate / 布隆过滤器假阳性率 (默认万分之一)
# BLOOM_FALSE_POSITIVE_RATE=0.0001

# Expected maximum domains per profile for bloom filter allocation / 单配置布隆过滤器预分配的最大域名数
# MAX_SYNC_DOMAINS=1000000

# Maximum domains processed from a single list per sync cycle / 单次同步中单个规则列表最多处理的域名数
# MAX_LIST_DOMAINS=500000

# Maximum bytes processed from a single list per sync cycle (default 25MB) / 单次同步中单个规则列表最大体积上限 (字节，默认 25MB)
# MAX_LIST_BYTES=26214400

# In-memory retention time for profile bloom filters (in milliseconds) / 内存中缓存布隆过滤器有效时长 (毫秒)
# BLOOM_MEM_TTL=600000

# In-memory retention time for profile config (in milliseconds) / 内存中缓存配置文件设置的有效时长 (毫秒)
# CONFIG_MEM_TTL=300000

# Maximum number of regex rules kept from lists (extra rules are ignored)
# Số quy tắc regex tối đa được giữ lại từ các danh sách (quy tắc vượt quá sẽ bị bỏ qua).
# MAX_REGEX_RULES=1000

# ------------------------------------------------------------------------------
# Scheduled Tasks & List Sync (Cron) / Tác vụ định kỳ & đồng bộ danh sách (Cron)
# ------------------------------------------------------------------------------
# The scheduler ticks every minute. The values below decide WHEN a list is actually refreshed.
# Bộ lập lịch chạy mỗi phút một lần. Các giá trị bên dưới quyết định KHI NÀO một danh sách thật sự được cập nhật.
# NOTE: the "Sync All Lists" / "Sync this list" buttons in the web dashboard run immediately and ignore these intervals.
# LƯU Ý: nút "Sync All Lists" / "Sync this list" trên giao diện web chạy ngay lập tức, không phụ thuộc các chu kỳ này.

# Automatic refresh interval for System Lists - the built-in shared lists (in seconds, default 21600 = 6 hours)
# Chu kỳ tự động cập nhật System List - các danh sách dùng chung có sẵn của hệ thống (giây, mặc định 21600 = 6 giờ).
# Unchanged lists are skipped via ETag / HTTP 304, so a short interval costs very little.
# Danh sách không thay đổi sẽ được bỏ qua nhờ ETag / HTTP 304, nên đặt chu kỳ ngắn cũng tốn rất ít tài nguyên.
# SYNC_SYSTEM_INTERVAL_SEC=21600

# Automatic refresh interval for user-added lists of each profile (in seconds, default 86400 = 24 hours)
# Chu kỳ tự động cập nhật các danh sách do người dùng tự thêm trong mỗi profile (giây, mặc định 86400 = 24 giờ).
# SYNC_PROFILE_INTERVAL_SEC=86400

# How long to wait before checking the database again when no profile is due for a sync (in seconds, default 1800 = 30 minutes)
# Thời gian chờ trước khi kiểm tra lại database khi không có profile nào đến hạn đồng bộ (giây, mặc định 1800 = 30 phút).
# Larger value = fewer idle database reads, but newly due profiles may start syncing a bit later.
# Giá trị lớn hơn = ít truy vấn database lúc rảnh hơn, nhưng profile vừa đến hạn có thể bắt đầu đồng bộ trễ hơn một chút.
# SYNC_IDLE_INTERVAL_SEC=1800

# Number of profiles processed per scheduler tick, each syncing one list (default 1)
# Số profile được xử lý trong mỗi lần chạy định kỳ, mỗi profile đồng bộ một danh sách (mặc định 1).
# Raise it only if you have many profiles and a powerful server; higher values use more CPU per tick.
# Chỉ nên tăng khi có nhiều profile và máy chủ mạnh; giá trị cao hơn sẽ tốn nhiều CPU hơn cho mỗi lượt chạy.
# SYNC_BATCH_SIZE=1

# Skip re-downloading a System List that was synced less than this many seconds ago when a sync is forced (default 60)
# Bỏ qua việc tải lại System List vừa được đồng bộ cách đây chưa tới số giây này khi đồng bộ cưỡng bức (mặc định 60).
# Only applies to API calls with ?force=true. Set 0 to always re-download.
# Chỉ áp dụng cho lệnh gọi API có ?force=true. Đặt 0 để luôn tải lại.
# SYNC_FORCE_COOLDOWN_SEC=60

# Timeout threshold when downloading upstream blocklists (in milliseconds, default 30000)
# Thời gian chờ tối đa khi tải danh sách chặn từ nguồn bên ngoài (mili giây, mặc định 30000).
# SYNC_TIMEOUT_MS=30000

# Number of extra attempts when a list download fails with a transient error (default 2, 0 = never retry)
# Số lần thử lại khi tải danh sách bị lỗi tạm thời (mặc định 2, đặt 0 = không thử lại).
# LIST_FETCH_MAX_RETRIES=2

# Base delay before the first retry in milliseconds, doubled on each further retry (default 1000)
# Độ trễ cơ bản trước lần thử lại đầu tiên, tính bằng mili giây, nhân đôi sau mỗi lần thử lại tiếp theo (mặc định 1000).
# LIST_FETCH_RETRY_DELAY_MS=1000

# Maximum HTTP redirects followed when downloading a list (default 5)
# Số lần chuyển hướng HTTP tối đa được theo dõi khi tải danh sách (mặc định 5).
# LIST_FETCH_MAX_REDIRECTS=5

# While parsing a large list, pause after every N domains so the server stays responsive (default 5000)
# Khi xử lý danh sách lớn, tạm nghỉ sau mỗi N tên miền để máy chủ vẫn phản hồi mượt (mặc định 5000).
# SYNC_YIELD_BATCH_SIZE=5000

# Length of that pause in milliseconds (default 10)
# Độ dài mỗi lần tạm nghỉ nói trên, tính bằng mili giây (mặc định 10).
# Lower values sync faster but use CPU in bursts; higher values spread the load out.
# Giá trị thấp đồng bộ nhanh hơn nhưng dùng CPU dồn dập; giá trị cao giúp dàn trải tải đều hơn.
# SYNC_YIELD_SLEEP_MS=10

# How often the cleanup task runs: deletes expired logs, expired sessions and inactive users (in seconds, default 3600 = 1 hour, minimum 60)
# Tần suất chạy tác vụ dọn dẹp: xóa log hết hạn, phiên đăng nhập hết hạn và người dùng không hoạt động (giây, mặc định 3600 = 1 giờ, tối thiểu 60).
# CLEANUP_INTERVAL_SEC=3600

# How often to refresh the official Cloudflare IP ranges and ECH configuration (in seconds, default 86400 = 1 day, minimum 60)
# Tần suất làm mới dải IP chính thức của Cloudflare và cấu hình ECH (giây, mặc định 86400 = 1 ngày, tối thiểu 60).
# CF_IP_SYNC_INTERVAL_SEC=86400

# ------------------------------------------------------------------------------
# Quotas, Retention & Inactivity Policy (Optional) / 系统配额、日志保留与闲置清理策略 (选填)
# ------------------------------------------------------------------------------
# Maximum number of profiles allowed per user / 单用户允许创建的最大配置数
# MAX_PROFILES_PER_USER=10

# Maximum number of access points allowed per profile / 单配置允许创建的最大接入点数
# MAX_ACCESS_POINTS_PER_PROFILE=100

# Maximum number of user-added (custom) lists allowed per profile (default 5)
# Số danh sách do người dùng tự thêm (custom list) tối đa trong mỗi profile (mặc định 5).
# MAX_CUSTOM_LISTS_PER_PROFILE=5

# Global hard cap on log retention days for ALL profiles (default 30). No user setting can exceed it, and the cleanup task deletes logs older than it.
# Mức trần toàn hệ thống cho số ngày lưu log của MỌI profile (mặc định 30). Không cài đặt nào của người dùng được vượt quá mức này, và tác vụ dọn dẹp sẽ xóa log cũ hơn mức này.
# MAX_LOG_RETENTION_DAYS=30

# Hard cap on log retention days for admin accounts (default: same as MAX_LOG_RETENTION_DAYS; cannot exceed it)
# Mức trần số ngày lưu log cho tài khoản admin (mặc định: bằng MAX_LOG_RETENTION_DAYS; không được vượt quá nó).
# ADMIN_USER_MAX_LOG_RETENTION_DAYS=30

# Default log retention days for new profiles of admin accounts (default 7)
# Số ngày lưu log mặc định cho profile mới của tài khoản admin (mặc định 7).
# DEFAULT_LOG_RETENTION_DAYS=7

# Hard cap on log retention days for normal users (default 7)
# Mức trần số ngày lưu log cho người dùng thường (mặc định 7).
# NORMAL_USER_MAX_LOG_RETENTION_DAYS=7

# Default log retention days for new profiles of normal users (default 1)
# Số ngày lưu log mặc định cho profile mới của người dùng thường (mặc định 1).
# NORMAL_USER_DEFAULT_LOG_RETENTION_DAYS=1

# Hard cap on stored log rows per profile, to keep the disk from filling up (default 500000)
# Số dòng log tối đa được lưu cho mỗi profile, để tránh đầy ổ đĩa (mặc định 500000).
# MAX_LOGS_PER_PROFILE=500000

# Number of days of DNS inactivity before normal user profiles & logs are cleared (0 to disable, default: 30)
# 连续无 DNS 解析请求达到此天数时自动清理普通用户的配置与日志 (填 0 为禁用, 默认: 30)
# INACTIVITY_THRESHOLD_DAYS=30

# Number of days of login inactivity before zombie normal user accounts are deleted (0 to disable, default: 90)
# 连续无登录达到此天数时自动删除未活跃普通用户账户 (填 0 为禁用, 默认: 90)
# INACTIVITY_USER_DAYS=90

# Maximum number of expired log rows deleted per cleanup run, shared across ALL profiles (default 1000)
# Số dòng log hết hạn tối đa được xóa trong mỗi lượt dọn dẹp, chia chung cho TẤT CẢ profile (mặc định 1000).
# Each profile gets an equal share (= this value / number of profiles, at least 1), so with 30 profiles each one loses at most ~33 rows per run.
# Mỗi profile được chia phần bằng nhau (= giá trị này / số profile, tối thiểu 1), ví dụ 30 profile thì mỗi profile bị xóa tối đa ~33 dòng mỗi lượt.
# How often a run happens is set by CLEANUP_INTERVAL_SEC. If old logs pile up, raise this value or shorten that interval.
# Tần suất mỗi lượt chạy do CLEANUP_INTERVAL_SEC quy định. Nếu log cũ tồn đọng nhiều, hãy tăng giá trị này hoặc rút ngắn chu kỳ đó.
# LOG_CLEANUP_BATCH_LIMIT=1000

# Maximum number of expired log rows deleted per day across all profiles (default 20000, 0 = no daily limit)
# Số dòng log hết hạn tối đa được xóa mỗi ngày trên tất cả profile (mặc định 20000, đặt 0 = không giới hạn theo ngày).
# Once reached, raw log deletion is skipped until the next UTC day. This protects the database's daily write quota (e.g. Cloudflare D1).
# Khi chạm mức này, việc xóa log thô sẽ tạm dừng đến hết ngày UTC. Giúp bảo vệ hạn mức ghi mỗi ngày của database (ví dụ Cloudflare D1).
# The log line shows it as "today: X/Y". With 0, only LOG_CLEANUP_BATCH_LIMIT limits each run.
# Dòng log hiển thị dạng "today: X/Y". Khi đặt 0, chỉ còn LOG_CLEANUP_BATCH_LIMIT giới hạn mỗi lượt.
# LOG_CLEANUP_DAILY_BUDGET=20000

# Minimum age in seconds before an unused encryption key (kem_key) with no logs referencing it can be deleted (default 86400 = 24 hours)
# Tuổi tối thiểu (giây) trước khi một khóa mã hóa (kem_key) không còn log nào tham chiếu được phép xóa (mặc định 86400 = 24 giờ).
# LOG_ORPHAN_KEY_MIN_AGE_SEC=86400

# Maximum number of unused kem_keys deleted per cleanup run (default 100)
# Số kem_key không còn được dùng tối đa bị xóa trong mỗi lượt dọn dẹp (mặc định 100).
# LOG_ORPHAN_KEY_BATCH_LIMIT=100

# NOT USED by the current code: the server never reads this value, so changing it has no effect (kept for compatibility).
# HIỆN CHƯA ĐƯỢC DÙNG trong code: máy chủ không đọc giá trị này nên thay đổi sẽ không có tác dụng (giữ lại để tương thích).
# DOMAIN_ROLLUP_MIN_COUNT=2

# ------------------------------------------------------------------------------
# Authentication Rate Limits (Optional) / Giới hạn tần suất xác thực (không bắt buộc)
# ------------------------------------------------------------------------------
# Protects against brute-force attacks. Limits are counted per client IP.
# Chống tấn công dò mật khẩu (brute-force). Giới hạn được tính theo từng IP client.

# Failed login attempts allowed per IP within the window before it is blocked (default 10)
# Số lần đăng nhập sai tối đa của mỗi IP trong khoảng thời gian bên dưới trước khi bị chặn (mặc định 10).
# LOGIN_MAX_ATTEMPTS=10

# Login block window in seconds (default 900 = 15 minutes)
# Khoảng thời gian chặn đăng nhập tính bằng giây (mặc định 900 = 15 phút).
# LOGIN_LOCK_WINDOW_SEC=900

# Sign-ups allowed per IP within the window (default 10)
# Số lượt đăng ký tài khoản tối đa của mỗi IP trong khoảng thời gian bên dưới (mặc định 10).
# SIGNUP_MAX_PER_WINDOW=10

# Sign-up window in seconds (default 60)
# Khoảng thời gian tính giới hạn đăng ký, tính bằng giây (mặc định 60).
# SIGNUP_WINDOW_SEC=60

# Forgot-password attempts allowed per IP within the window (default 10)
# Số lần thử khôi phục mật khẩu tối đa của mỗi IP trong khoảng thời gian bên dưới (mặc định 10).
# FORGOT_PASSWORD_MAX_ATTEMPTS=10

# Forgot-password window in seconds (default 600 = 10 minutes)
# Khoảng thời gian tính giới hạn khôi phục mật khẩu, tính bằng giây (mặc định 600 = 10 phút).
# FORGOT_PASSWORD_WINDOW_SEC=600

# Failed session-refresh attempts allowed per IP within the window (default 20)
# Số lần làm mới phiên đăng nhập thất bại tối đa của mỗi IP trong khoảng thời gian bên dưới (mặc định 20).
# REFRESH_MAX_FAILURES=20

# Session-refresh failure window in seconds (default 60)
# Khoảng thời gian tính giới hạn làm mới phiên thất bại, tính bằng giây (mặc định 60).
# REFRESH_WINDOW_SEC=60

# Wrong unlock-PIN attempts allowed before the session is destroyed and the user is logged out (default 3)
# Số lần nhập sai mã PIN mở khóa tối đa trước khi phiên bị hủy và người dùng bị đăng xuất (mặc định 3).
# PIN_MAX_ATTEMPTS=3

# How long wrong-PIN attempts are remembered in seconds (default 900 = 15 minutes)
# Thời gian ghi nhớ các lần nhập sai PIN, tính bằng giây (mặc định 900 = 15 phút).
# PIN_LOCK_WINDOW_SEC=900

# How long the browser waits for a Passkey / WebAuthn prompt in milliseconds (default 60000 = 60 seconds, minimum 1000)
# Thời gian trình duyệt chờ người dùng thao tác Passkey / WebAuthn, tính bằng mili giây (mặc định 60000 = 60 giây, tối thiểu 1000).
# WEBAUTHN_TIMEOUT_MS=60000

# ------------------------------------------------------------------------------
# Preset Upstream Services & External Filters (Optional) / 预设上游服务与外部过滤规则 (选填)
# ------------------------------------------------------------------------------
# Preset Upstream Services (JSON string) / 预设上游服务列表 (JSON 字符串)
PRESET_UPSTREAMS='[{"label":"settings.presetCloudflareSecurity","url":"https://security.cloudflare-dns.com/dns-query"},{"label":"settings.presetCloudflareFamilies","url":"https://family.cloudflare-dns.com/dns-query"},{"label":"Cloudflare","url":"https://cloudflare-dns.com/dns-query"},{"label":"settings.presetQuad9","url":"tls://dns.quad9.net"},{"label":"settings.presetQuad9Ecs","url":"tls://dns11.quad9.net"},{"label":"settings.presetControlDFree","url":"https://freedns.controld.com/no-ads-malware-typo"},{"label":"settings.presetControlDUncensored","url":"https://freedns.controld.com/uncensored"},{"label":"settings.presetAdGuard","url":"https://dns.adguard-dns.com/dns-query"},{"label":"settings.presetAdGuardFamily","url":"https://family.adguard-dns.com/dns-query"},{"label":"Cloudflare Security (1.1.1.2)","url":"tcp://1.1.1.2:53"},{"label":"Cloudflare (1.1.1.1)","url":"tcp://1.1.1.1:53"},{"label":"Quad9 ECS (9.9.9.11)","url":"tcp://9.9.9.11:9953"},{"label":"Google (8.8.8.8)","url":"tcp://8.8.8.8:53"}]'

# Preset External Filters (JSON string) / 预设外部规则过滤列表 (JSON 字符串)
PRESET_EXTERNAL_FILTERS='[{"label":"Blocklist (ABPVN + AdGuard DNS + 1Hosts Lite)","url":"https://lists.bibica.net/blocklists.txt"},{"label":"Whitelist (ShadowWhisperer)","url":"https://lists.bibica.net/whitelist.txt"},{"label":"DNS Rewrites","url":"https://lists.bibica.net/rewrites.txt"},{"label":"HaGeZi Light","url":"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/light.txt"},{"label":"HaGeZi Multi NORMAL","url":"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/multi.txt"},{"label":"HaGeZi Pro","url":"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt"},{"label":"HaGeZi Pro++","url":"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.plus.txt"},{"label":"HaGeZi Ultimate","url":"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/ultimate.txt"},{"label":"HaGeZi Threat Intelligence (Medium)","url":"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/tif.medium.txt"},{"label":"HaGeZi NSFW","url":"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/nsfw.txt"},{"label":"StevenBlack Unified Hosts","url":"https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts"},{"label":"OISD Big","url":"https://big.oisd.nl"},{"label":"OISD NSFW","url":"https://nsfw.oisd.nl"}]'

# Default profile external filter URLs (comma-separated, newline-separated, or JSON array)
# Automatically added to newly created profiles and default registration profile. Left empty by default.
# DEFAULT_PROFILE_FILTER_URLS=''

# System shared filter URLs (defaults to PRESET_EXTERNAL_FILTERS + DEFAULT_PROFILE_FILTER_URLS if omitted)
# Shared globally with two-tier Bloom filter architecture across all profiles
# SYSTEM_FILTER_URLS=''

# Preset ECH Fronting (outer SNI) domains (JSON string) / 预设 ECH 前置外层 SNI 域名 (JSON 字符串)
PRESET_ECH_FRONTING_DOMAINS='["cloudflare-ech.com","crypto.cloudflare.com","one.one.one.one","www.cloudflare.com","encryptedsni.com","cdnjs.com"]'
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
