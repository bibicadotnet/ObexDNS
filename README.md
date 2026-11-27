# ObexDNS (Serverfull Mode)

Bản fork từ [DNS-Worker](https://github.com/Oppidi/DNS-Worker), tối ưu chuyên biệt cho chế độ **Serverfull / Docker** với cấu trúc volume tinh gọn, tự động cấp phát SSL Wildcard qua Cloudflare DNS, và tự động sao lưu / khôi phục dữ liệu qua Cloudflare R2 / S3.

---

## 1. Cấu trúc lưu trữ dữ liệu (`/data`)

Hệ thống gom toàn bộ dữ liệu vào **1 volume duy nhất (`/data`)**:

```text
/data
├── dns_worker.sqlite          # SQLite database chính (profiles, rules, users, logs)
├── .jwt_secret                # Khóa bí mật ký session JWT
├── config/
│   └── .env                   # Cấu hình tuỳ chỉnh của người dùng (ưu tiên cao nhất)
├── ssl/
│   ├── fullchain.pem          # Chứng chỉ TLS (tự reload khi được gia hạn)
│   └── privkey.pem            # Khóa riêng TLS
└── acme/                      # Dữ liệu tài khoản acme.sh (được bảo vệ, chmod 700)
```

---

## 2. Cách chạy nhanh qua Docker

### Chạy bằng lệnh `docker run`:

```bash
docker run -d \
  --name dns-worker \
  --restart unless-stopped \
  -p 53:53/udp \
  -p 853:853/tcp \
  -p 80:80/tcp \
  -p 443:443/tcp \
  -v dns_worker_data:/data \
  -e SERVERFULL_DOT_DOMAIN=dns.example.com \
  -e CLOUDFLARE_API_TOKEN=your_cf_api_token \
  bibica/obexdns:latest
```

### Chạy bằng `docker-compose.yml`:

```yaml
services:
  obexdns:
    image: bibica/obexdns:latest
    container_name: dns-worker
    restart: unless-stopped
    ports:
      - "53:53/udp"
      - "853:853/tcp"
      - "80:80/tcp"
      - "443:443/tcp"
    volumes:
      - dns_worker_data:/data
    environment:
      # --- Tự động cấp & gia hạn SSL Let's Encrypt Wildcard ---
      - SERVERFULL_DOT_DOMAIN=dns.example.com
      - CLOUDFLARE_API_TOKEN=your_cloudflare_dns_edit_api_token
      - SSL_RENEW_CRON=23 3 * * *         # 03:23 UTC hàng ngày

      # --- Tự động sao lưu & khôi phục Cloudflare R2 / S3 (Private 100%) ---
      - BACKUP_CRON=0 2 * * *             # 02:00 UTC hàng ngày
      - BACKUP_KEEP_DAYS=30               # Giữ 30 ngày gần nhất
      - BACKUP_S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
      - BACKUP_S3_BUCKET=my-dns-backup
      - BACKUP_S3_REGION=auto
      - BACKUP_S3_ACCESS_KEY_ID=your_r2_access_key
      - BACKUP_S3_SECRET_ACCESS_KEY=your_r2_secret_key
      - BACKUP_S3_PREFIX=obexdns

volumes:
  dns_worker_data:
```

---

## 3. Tính năng tự động cấp & gia hạn SSL (Cloudflare DNS-01)

- **Cấp tự động:** Khi có `SERVERFULL_DOT_DOMAIN` và `CLOUDFLARE_API_TOKEN` (yêu cầu quyền `Zone -> DNS -> Edit`), container tự động đăng ký chứng chỉ Wildcard cho cả domain chính và subdomains (`dns.example.com` và `*.dns.example.com`).
- **Khởi động an toàn:** Nếu đã có chứng chỉ hợp lệ (còn hạn > 7 ngày), container bỏ qua không gọi mạng. Nếu có lỗi mạng hoặc rate limit khi cấp lần đầu, container vẫn khởi động để phục vụ UDP/HTTP bình thường.
- **Tự động gia hạn:** Cron nội bộ chạy kiểm tra định kỳ (mặc định 03:23 UTC). Khi chứng chỉ còn dưới 1/3 vòng đời, script sẽ tự động gia hạn và ghi đè nguyên tử. ObexDNS sẽ tự động nạp chứng chỉ mới mà không cần restart container.

---

## 4. Tự động sao lưu & Di dời (Disaster Recovery) với Cloudflare R2 / S3

- **Snapshot an toàn tuyệt đối:** Chụp bản sao lưu bằng `VACUUM INTO` (một transaction đọc duy nhất, không bị khởi động lại khi ứng dụng đang ghi), kiểm tra `quick_check` và kiểm tra lại file nén trước khi tải lên. Nén bằng `zstd` ở mức ưu tiên CPU thấp nhất. Bản lỗi không bao giờ ghi đè `latest`.
- **Lưu trữ riêng tư (Private 100%):** Dùng chữ ký số AWS SigV4 trực tiếp từ container. Bucket của bạn hoàn toàn bảo mật, không cần mở Public URL.
- **Upload kép & Tự dọn dẹp:** Mỗi ngày tự upload 1 bản theo ngày giờ (`obexdns_backup_YYYYMMDD_HHMMSS.tar.zst`) và 1 bản cố định (`latest.tar.zst`). Tự động xóa các bản cũ hơn `BACKUP_KEEP_DAYS`.
- **Tải bản sao lưu từ trang quản trị:** nút *Sao lưu ngay* chạy nền (theo dõi tiến trình trực tiếp), danh sách bản sao lưu hiển thị ngay trong trang và nút *Tải về* tải thẳng từ R2/S3 bằng đường dẫn ký sẵn có hạn 5 phút, VPS không phải truyền file.
- **Tự động khôi phục khi chuyển VPS (Zero-touch):** Khi dựng container trên VPS mới với cùng thông số S3 ở trên, container thấy database chưa có dữ liệu sẽ **tự động kết nối vào bucket private kéo `latest.tar.zst` về khôi phục lại toàn bộ database và phiên đăng nhập**. Sau đó tự động cấp SSL mới chuẩn cho VPS đó mà bạn không cần thao tác thủ công.

