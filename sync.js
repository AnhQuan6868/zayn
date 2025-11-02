import pkg from "pg";
import axios from "axios";

const { Pool } = pkg;

// ==========================
// ⚙️ Cấu hình kết nối DATABASE LOCAL
// ==========================
const localDB = new Pool({
  user: "postgres",
  host: "localhost",
  database: "flood_alert_db",
  password: "Quan@",
  port: 5432,
});

// ==========================
// 🌐 URL API của Railway Server
// ==========================
const CLOUD_URL = "https://zayn-production-ab3d.up.railway.app/update";

// ==========================
// 🔁 Lưu ID cuối cùng đã đồng bộ
// ==========================
let lastSyncedId = 0;

// ==========================
// 🚀 Hàm đồng bộ dữ liệu lên cloud
// ==========================
async function syncToCloud() {
  try {
    const query = `
      SELECT id, mucnuoca, mucnuocb, luuluong, trangthai, thongbao,
             predicted_trangthai, time_until_a_danger, is_raining, created_at
      FROM sensor_data
      WHERE id > $1
      ORDER BY id ASC;
    `;
    const result = await localDB.query(query, [lastSyncedId]);
    const rows = result.rows;

    if (rows.length === 0) {
      console.log("⏳ Không có dữ liệu mới để đồng bộ...");
      return;
    }

    console.log(`🔄 Tìm thấy ${rows.length} bản ghi mới cần đồng bộ.`);

    for (const row of rows) {
      const payload = {
        mucNuocA: row.mucnuoca,
        mucNuocB: row.mucnuocb,
        luuLuong: row.luuluong,
        isRaining: row.is_raining,
        trangThai: row.trangthai,
        thongBao: row.thongbao,
        predicted_trangthai: row.predicted_trangthai,
        time_until_a_danger: row.time_until_a_danger,
        created_at: row.created_at,
      };

      try {
        const res = await axios.post(CLOUD_URL, payload, {
          timeout: 10000, // tránh treo request
          httpsAgent: new (await import("https")).Agent({ rejectUnauthorized: false }), // tránh lỗi TLS
        });

        if (res.status === 200) {
          console.log(`✅ Đã đồng bộ ID=${row.id} thành công.`);
          lastSyncedId = row.id;
        } else {
          console.warn(`⚠️ Server phản hồi lỗi với ID=${row.id}: Mã ${res.status}`);
        }
      } catch (err) {
        console.error(`❌ Gửi ID=${row.id} thất bại: ${err.message}`);
      }
    }
  } catch (err) {
    console.error("❌ Lỗi truy vấn cơ sở dữ liệu local:", err.message);
  }
}

// ==========================
// ⏱️ Chạy liên tục mỗi 5 giây
// ==========================
console.log("🚀 Bắt đầu đồng bộ LIÊN TỤC Local → Railway Cloud...");
setInterval(syncToCloud, 5000);
syncToCloud();
