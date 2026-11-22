ObexDNS - Thiết kế lại giao diện (chỉ giao diện sáng, chỉ EN + VI)
====================================================================

CÁCH ÁP DỤNG
1. Chép đè toàn bộ thư mục trong zip này lên dự án cũ (giữ nguyên cấu trúc thư mục).
2. Xóa file không còn dùng:
     web/src/layouts/HeaderNavbar.tsx
   (Tùy chọn) xóa các file ngôn ngữ không còn được nạp, chúng vô hại nếu để lại:
     web/src/i18n/locales/*.json  ngoại trừ en-US.json và vi-VN.json
3. Cài thêm font (đã thêm vào web/package.json + web/package-lock.json):
     cd web && npm install
   (Dockerfile / CI dùng "npm ci" cũng ổn vì lockfile đã cập nhật.)
4. Build như bình thường (cd web && npm run build). 

GHI CHÚ
- Font: Plus Jakarta Sans (có đủ dấu tiếng Việt), host cùng domain nên không vướng CSP.
- src/serverfull/http/assets.ts: thêm MIME .woff2/.woff cho bản serverfull.
- Ngôn ngữ chỉ còn English / Tiếng Việt. Tài khoản đang lưu ngôn ngữ khác sẽ tự về English.
- Trang "Bảo vệ" (Protection) gộp Danh sách chặn (/filter) và Quy tắc riêng (/rules) thành 2 tab.
- Đã kiểm tra: tsc, vite build, oxlint (0 lỗi) và chụp thử bằng trình duyệt ở cỡ điện thoại, tablet, desktop.
