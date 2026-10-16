# PlayBack demo guide

About 5 minutes on one laptop. From the project folder:

```bash
npm run dev
```

Open http://127.0.0.1:5173

The laptop camera is only for Court 1. Courts 2–8 can show check-in, a verified score, and a rating change with no webcam. A phone that scans a court QR opens the court page and does not start a camera.

Player names stay as stored. Do not translate Minh Trần, Lan Phạm, An Nguyễn, Khoa Lê, Hà Vũ, Quang Đỗ, Mai Bùi, or Tuấn Hoàng.

## English

1. On the home page, choose English or Tiếng Việt. The choice is remembered.
2. Open Facility dashboard. The club is PlayBack Demo Club. The page says this is a local demo with no production sign-in. Eight courts are listed. Court 1 says it records on this laptop. Courts 2–8 say simulated status. There is no revenue number. Saved sessions, people, and the demo credit balance are still on this page.
3. Open Court 1. The QR on the home page is only a court link. On a phone it must not ask for a camera.
4. Leave Doubles selected. Join Lan Phạm and Quang Đỗ on red (Team A). Join An Nguyễn and Mai Bùi on blue (Team B). Names stay on the colored cards. The same player cannot join twice. When both sides are full, the court says the host can start.
5. Tick the recording consent and choose Start match on this laptop. On the record screen, enable the camera, start, stop, and save. Replay opens when the file is stored. Choose Enter the result.
6. Type 11 for red and 7 for blue. Save the score, then verify. The page says the rating was updated once. Verify again and it stays refused. The video did not pick the winner.
7. Open Lan Phạm. PIR is no longer 1680. Wins, matches, win rate, and the rating chart come from stored rows. Serve speed, shot placement, and movement say not available yet. The illustration box is labeled as a demo, separate from those numbers.
8. Open Matchmaking. Pick four players, including the four above if you want. Recommend a split. Three pairings appear. The closest average PIR split is marked recommended, with the gap and a short reason. It is a recommendation, not a guarantee.
9. On a player page, tick the equipment consent, enter a paddle, shoes, or apparel, and save. Remove equipment clears it. Nothing is read from the video.
10. Refresh the browser. The match, rating, and equipment are still there. To restore demo ratings, open Facility dashboard or Settings and type `RESET DEMO`. Recordings in `data/recordings/` stay.

To practice steps 4–7 without the webcam, open Court 2 instead of Court 1 and choose Start simulated match. Then enter and verify the score the same way.

## Tiếng Việt

1. Ở trang chủ, chọn Tiếng Việt hoặc English. Lựa chọn được ghi nhớ.
2. Mở Quản lý sân. Câu lạc bộ là PlayBack Demo Club. Trang ghi đây là bản demo trên máy này, không có đăng nhập sản xuất. Có 8 sân. Sân 1 ghi hình trên laptop. Sân 2–8 ghi trạng thái mô phỏng. Không có số doanh thu. Phiên đã lưu, người để lại số, và số dư tín dụng demo vẫn ở trang này.
3. Mở Sân 1. Mã QR ở trang chủ chỉ là liên kết sân. Điện thoại quét mã không được xin camera.
4. Giữ Đánh đôi. Cho Lan Phạm và Quang Đỗ vào đội đỏ (Đội A). Cho An Nguyễn và Mai Bùi vào đội xanh dương (Đội B). Tên nằm trên thẻ màu. Một người không vào hai lần. Khi đủ người, sân báo chủ sân có thể bắt đầu.
5. Tick đồng ý ghi hình và chọn Bắt đầu trận trên máy tính này. Ở màn hình quay, bật camera, bắt đầu, dừng và lưu. Trang xem lại mở khi file đã lưu. Chọn Nhập kết quả.
6. Nhập 11 cho đội đỏ và 7 cho đội xanh dương. Lưu tỷ số, rồi xác minh. Trang báo điểm đã được cập nhật một lần. Bấm xác minh lần nữa thì bị từ chối. Video không chọn người thắng.
7. Mở Lan Phạm. PIR không còn 1680. Thắng, số trận, tỷ lệ thắng và biểu đồ lấy từ dữ liệu đã lưu. Tốc độ giao bóng, vị trí bóng và di chuyển hiện “Chưa có”. Ô minh họa được ghi là demo, tách khỏi các số thật.
8. Mở Ghép cặp. Chọn bốn người. Bấm Gợi ý cách chia. Có ba cách chia. Cách có chênh lệch PIR trung bình nhỏ nhất được đánh dấu gợi ý, kèm chênh lệch và một câu lý do. Đây là gợi ý, không phải bảo đảm.
9. Ở trang người chơi, tick đồng ý lưu dụng cụ, nhập vợt, giày hoặc trang phục, rồi lưu. Xóa dụng cụ sẽ gỡ ghi chú. Máy quay không nhận thương hiệu.
10. Tải lại trang. Trận, điểm và dụng cụ vẫn còn. Để khôi phục điểm demo, mở Quản lý sân hoặc Cài đặt và gõ `RESET DEMO`. File trong `data/recordings/` được giữ.

Muốn làm bước 4–7 không cần webcam, mở Sân 2 và chọn Bắt đầu trận mô phỏng. Sau đó nhập và xác minh tỷ số như trên.

## Recording details

Court 1 still uses the existing camera flow. Consent comes before Enable camera. One camera records one end. Two cameras record two files. The app does not copy one picture onto both ends. The score on the record screen is manual. A game is to 11, and the teams stay on the sides where they started. Replay can show the full match, rallies, or starred rallies. Zalo or WhatsApp is optional and can be skipped. No message is sent.

## Client phone, same Wi-Fi

1. Put the laptop and the phone on the same Wi-Fi.
2. On the laptop, run `npm run dev:lan`.
3. Open the LAN URL printed in the terminal, such as `http://192.168.x.x:5173`. An amber bar says this is a demo with no production login.
4. Leave Court 1 selected. The QR code must show `http://192.168.x.x:5173/court/court-1`, not localhost.
5. Scan it with the phone. The phone opens the court page. It does not ask for the phone camera and it cannot start the laptop webcam.
6. Record on the laptop at http://127.0.0.1:5173.
