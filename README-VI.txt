ObexDNS - Thiết kế lại giao diện (chỉ giao diện sáng, chỉ EN + VI)  [bản 2]
=======================================================================

CÁCH ÁP DỤNG
1. Chép đè toàn bộ thư mục trong zip này lên dự án cũ (giữ nguyên cấu trúc thư mục).
2. Xóa file không còn dùng:
     web/src/layouts/HeaderNavbar.tsx
   (Tùy chọn) xóa các file ngôn ngữ không còn được nạp:
     web/src/i18n/locales/*.json  ngoại trừ en-US.json và vi-VN.json
3. Cài font (đã thêm vào web/package.json + web/package-lock.json):
     cd web && npm install
4. Build như bình thường (cd web && npm run build).

BẢN 2 CÓ GÌ MỚI SO VỚI BẢN 1
- Trang HỆ THỐNG (/system) riêng cho admin: Người dùng, Cấu hình máy chủ, Cơ sở dữ liệu.
  Trang Tài khoản giờ chỉ còn việc của chính người dùng. Menu "Hệ thống" nằm trong menu tài khoản
  (desktop) và trong menu "Thêm" (điện thoại), chỉ hiện với admin.
- CÀI ĐẶT: gom nhóm theo mục đích (DNS và quyền riêng tư / Nhật ký truy vấn / Kiểm tra tên miền),
  có thanh nhảy nhanh, một cột thay vì lưới 2 cột kéo giãn; ECS chỉ hiện ô nhập subnet khi bật "Custom".
- THIẾT LẬP: tự nhận ra thiết bị đang dùng (iPhone/Mac, Android, Windows, Linux) và mở sẵn đúng hướng dẫn.
- THỐNG KÊ: chọn khoảng thời gian dạng nút gạt cuộn ngang được; thẻ số liệu gọn 2 cột trên điện thoại.
- Thanh bên vẫn dùng được ở trang Tài khoản/Hệ thống (lấy profile đầu tiên khi URL không có profile).
- Sửa: AccountView áp ngôn ngữ đã lưu qua normalizeLocale (tài khoản cũ lưu zh-CN... không còn lọt vào).

Đã kiểm tra: tsc, vite build, oxlint (0 lỗi), và chụp thử bằng trình duyệt ở điện thoại/tablet/desktop.
