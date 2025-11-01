// === DEBUG CODE ===
// Mã này sẽ chạy đầu tiên để kiểm tra xem Railway đã "nhìn thấy" biến chưa
console.log("--- BẮT ĐẦU DEBUG BIẾN MÔI TRƯỜNG ---");
if (process.env.SERVICE_ACCOUNT_JSON) {
  console.log("✅ [DEBUG] ĐÃ TÌM THẤY BIẾN SERVICE_ACCOUNT_JSON.");
} else {
  console.log("❌ [DEBUG] KHÔNG TÌM THẤY BIẾN SERVICE_ACCOUNT_JSON.");
}
if (process.env.DATABASE_URL) {
  console.log("✅ [DEBUG] ĐÃ TÌM THẤY BIẾN DATABASE_URL.");
} else {
  console.log("❌ [DEBUG] KHÔNG TÌM THẤY BIẾN DATABASE_URL.");
}
console.log("--- KẾT THÚC DEBUG ---");
// ==================

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const admin = require('firebase-admin');

// =============================
// CẤU HÌNH HỆ THỐNG
// =============================
// Railway sẽ tự động cung cấp biến PORT
const SERVER_PORT = process.env.PORT || 3000;
const PYTHON_SERVER_URL = process.env.PYTHON_SERVER_URL || "http://localhost:5001";
const RAPID_RISE_THRESHOLD = 0.5; // cm/giây

// =============================
// KHỞI TẠO CSDL (DATABASE) - TỰ ĐỘNG CHO CLOUD/LOCAL
// =============================
let pool;
try {
    if (process.env.DATABASE_URL) {
        // Môi trường Cloud (Railway)
        console.log("✅ [DB Config] Đang kết nối CSDL Cloud (sử dụng DATABASE_URL)...");
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            // Cấu hình SSL (thường cần thiết cho các CSDL cloud)
            ssl: {
                rejectUnauthorized: false
            }
        });
    } else {
        // Môi trường Local (Máy tính của bạn)
        console.log("⚠️ [DB Config] Đang kết nối CSDL Local (sử dụng DB_CONFIG)...");
        const DB_CONFIG = {
            user: process.env.DB_USER || 'postgres',
            host: process.env.DB_HOST || 'localhost',
            database: process.env.DB_NAME || 'flood_alert_db',
            password: process.env.DB_PASS || 'Quan@',
            port: process.env.DB_PORT || 5432,
        };
        pool = new Pool(DB_CONFIG);
    }
} catch (dbErr) {
    console.error("❌ LỖI NGHIÊM TRỌNG KHI KHỞI TẠO CSDL POOL:", dbErr.message);
}


// =============================
// KHỞI TẠO FIREBASE ADMIN - TỰ ĐỘNG CHO CLOUD/LOCAL
// =============================
try {
    if (process.env.SERVICE_ACCOUNT_JSON) {
        // Môi trường Cloud (Railway) - Đọc từ biến môi trường
        console.log("✅ [Firebase] Đang khởi tạo từ BIẾN MÔI TRƯỜNG (Cloud)...");
        // Parse chuỗi JSON từ biến môi trường
        const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase Admin SDK đã khởi tạo từ BIẾN MÔI TRƯỜNG (Cloud).");

    } else {
        // Môi trường Local (Máy tính) - Đọc từ file
        console.log("⚠️ [Firebase] Đang khởi tạo từ file './serviceAccountKey.json' (Local)...");
        const serviceAccount = require('./serviceAccountKey.json');
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase Admin SDK đã khởi tạo từ FILE (Local).");
    }
} catch (error) {
    console.error("❌ LỖI NGHIÊM TRỌNG KHI KHỞI TẠO FIREBASE ADMIN:", error.message);
    if (!process.env.SERVICE_ACCOUNT_JSON) {
       console.warn("⚠️ Hãy chắc chắn file 'serviceAccountKey.json' (Local) hoặc biến 'SERVICE_ACCOUNT_JSON' (Cloud) tồn tại.");
    }
}

// =============================
// TRẠNG THÁI MÁY CHỦ (State)
// =============================
// Nhóm các biến trạng thái vào một đối tượng để dễ quản lý
const appState = {
    fcmToken: null,
    lastSensorData: {
        mucNuocB: null,
        luuLuong: null,
        timestamp: null
    },
    lastSentAIStatus: "Bình thường",
    sentRapidRiseNotification: false,
    lastDangerAlertTime: null
};

// =============================
// KHỞI TẠO ỨNG DỤNG
// =============================
const app = express();
app.use(express.json());
app.use(cors());
// 'pool' đã được khởi tạo ở trên

// =============================
// HÀM HỖ TRỢ (Helpers)
// =============================

/** Lấy mức độ nghiêm trọng của trạng thái (0-3) */
function getStatusSeverity(status) {
    const severityMap = {
        "Bình thường": 0,
        "Cảnh báo!": 1,
        "Cảnh báo Cao!": 2,
        "Nguy hiểm!": 3
    };
    return severityMap[status] ?? -1; // Trả về -1 nếu trạng thái không xác định
}

/** Kiểm tra xem có nên gửi thông báo AI không */
function shouldSendAIStatusNotification(lastStatus, currentStatus) {
    if (!appState.fcmToken) { // Sửa: Dùng appState.fcmToken
        console.log("📱 Chưa có FCM token từ điện thoại, bỏ qua gửi thông báo!");
        return false;
    }
    
    // Gửi khi trạng thái thay đổi
    if (lastStatus !== currentStatus) {
        console.log(`🔄 Phát hiện thay đổi trạng thái AI: ${lastStatus} -> ${currentStatus}`);
        return true;
    }
    
    return false;
}

/** Định dạng giây sang "X phút Y giây" */
function formatCountdown(seconds) {
    if (seconds < 0) return null;
    
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    
    if (minutes > 0) {
        return `${minutes} phút ${remainingSeconds} giây`;
    } else {
        return `${remainingSeconds} giây`;
    }
}

/** Lấy Tiêu đề thông báo dựa trên trạng thái */
function getNotificationTitle(status) {
    const titleMap = {
        "Bình thường": "✅ Tình hình ổn định",
        "Cảnh báo!": "⚠️ Cảnh báo Lũ",
        "Cảnh báo Cao!": "🔶 Cảnh báo Lũ Cao",
        "Nguy hiểm!": "🚨 BÁO ĐỘNG NGUY HIỂM"
    };
    return titleMap[status] || `Cảnh báo: ${status}`;
}

/** Lấy Nội dung thông báo dựa trên trạng thái và thời gian */
function getNotificationBody(status, countdown) {
    const baseMessages = {
        "Bình thường": "Tình hình lũ hiện tại ổn định. Tiếp tục theo dõi.",
        "Cảnh báo!": "Mực nước đang tăng. Chuẩn bị sẵn sàng các biện pháp phòng ngừa.",
        "Cảnh báo Cao!": "Mực nước đang tăng nhanh. Sẵn sàng sơ tán nếu cần thiết.",
        "Nguy hiểm!": "LŨ ĐANG Ở MỨC NGUY HIỂM! CẦN SƠ TÁN NGAY LẬP TỨC!"
    };
    
    let body = baseMessages[status] || `Trạng thái: ${status}`;
    
    const formattedTime = formatCountdown(countdown);
    if (formattedTime && status !== "Bình thường") {
        body += ` Lũ dự kiến đến Điểm A sau khoảng ${formattedTime}.`;
        
        // Thêm cảnh báo khẩn cấp nếu thời gian quá gấp
        if (countdown < 300 && status !== "Bình thường") { // Dưới 5 phút
            body += " HÃY DI CHUYỂN ĐẾN NƠI AN TOÀN NGAY!";
        }
    }
    
    return body;
}

// =============================
// HÀM GỬI THÔNG BÁO PUSH
// =============================

/** Hàm gửi thông báo nội bộ qua FCM */
async function sendPushNotificationInternal(title, body) {
    if (!admin.apps.length) { 
        console.error("❌ Firebase Admin chưa khởi tạo, không thể gửi thông báo."); 
        return; 
    }
    if (!appState.fcmToken) { // Kiểm tra lại
        console.warn("sendPushNotificationInternal: Bỏ qua vì fcmToken là null.");
        return false;
    }

    const message = {
        notification: { 
            title: title, 
            body: body 
        },
        token: appState.fcmToken, // Sửa: Dùng appState.fcmToken
        android: { 
            priority: 'high', 
            notification: { 
                sound: 'default', 
                channelId: 'FloodWarningChannel', // Quan trọng: Khớp với Android
                icon: 'ic_warning', // Đảm bảo icon này tồn tại trên app
                color: '#FF0000' // Màu đỏ cho cảnh báo
            } 
        },
        apns: { 
            headers: { 'apns-priority': '10' }, 
            payload: { 
                aps: { 
                    sound: 'default',
                    alert: { title: title, body: body }
                } 
            } 
        }
    };
    
    try {
        await admin.messaging().send(message);
        console.log(`✅ ĐÃ GỬI THÔNG BÁO: ${title}`);
        console.log(`📱 Nội dung: ${body}`);
        return true;
    } catch (error) {
        console.error(`❌ Lỗi khi gửi Push Notification (${error.code}): ${error.message}`);
        // Nếu token sai, xóa nó đi để không gửi lỗi nữa
        if (error.code === 'messaging/registration-token-not-registered' || error.code === 'messaging/invalid-registration-token') {
            console.warn(`🗑️ FCM token không hợp lệ. Xóa token.`);
            appState.fcmToken = null; // Sửa: Dùng appState.fcmToken
        }
        return false;
    }
}

/** Gửi thông báo dựa trên trạng thái AI */
async function sendAIStatusNotification(status, countdown) {
    if (!admin.apps.length) { 
        console.error("❌ Firebase Admin chưa khởi tạo, không thể gửi thông báo AI."); 
        return; 
    }

    const title = getNotificationTitle(status);
    const body = getNotificationBody(status, countdown);
    
    console.log(`📤 Chuẩn bị gửi thông báo AI: ${status}`);
    await sendPushNotificationInternal(title, body);
}

/** Gửi thông báo khi nước dâng quá nhanh */
async function sendRapidRiseNotification(rate) {
    if (!admin.apps.length) { 
        console.error("❌ Firebase Admin chưa khởi tạo, không thể gửi thông báo dâng nhanh."); 
        return; 
    }

    const title = "🌊 Cảnh báo: Nước Dâng Nhanh!";
    const body = `Phát hiện mực nước tại điểm B đang dâng nhanh (${rate.toFixed(1)} cm/s). Hãy chú ý theo dõi và chuẩn bị sơ tán!`;
    
    console.log(`📤 Chuẩn bị gửi thông báo dâng nhanh`);
    await sendPushNotificationInternal(title, body);
}

// =============================
// API ENDPOINTS
// =============================

/** API: Đăng ký FCM token từ app Android */
app.post('/api/register_fcm_token', (req, res) => {
    try {
        const { token } = req.body;
        if (!token) {
            console.warn("⚠️ Yêu cầu /api/register_fcm_token thiếu token.");
            return res.status(400).send({ error: 'Missing token in request body' });
        }
        
        appState.fcmToken = token; // Sửa: Dùng appState.fcmToken
        console.log(`✅ Đã nhận FCM token từ điện thoại: ${token.substring(0, 10)}...`);
        res.status(200).send({ message: 'Token received successfully' });
    } catch (error) {
        console.error('❌ Lỗi trong /api/register_fcm_token:', error.message);
        res.status(500).send({ error: 'Internal server error' });
    }
});

/** API: Nhận dữ liệu chính từ cảm biến/simulator */
app.post('/update', async (req, res) => {
    let duDoanTrangThai = "Lỗi dự đoán";
    let duDoanThoiGian = -1;
    let b_rate_of_change = 0;
    let flow_rate_of_change = 0;
    let currentTime;

    try {
        const body = req.body;
        
        // 1. Parse và Validate Dữ liệu
        const mucNuocA = parseFloat(body.mucNuocA);
        const mucNuocB = parseFloat(body.mucNuocB);
        const luuLuong = parseFloat(body.luuLuong);
        const isRaining = body.isRaining === true;
        const trangThaiSimulator = body.trangThai || '';
        const thongBaoSimulator = body.thongBao || '';
        const time_until_a_danger_simulator = body.time_until_a_danger;

        if (isNaN(mucNuocA) || isNaN(mucNuocB) || isNaN(luuLuong) || body.isRaining === undefined) {
            console.warn("⚠️ Yêu cầu /update thiếu dữ liệu hoặc sai định dạng số.");
            return res.status(400).json({ error: 'Thiếu dữ liệu hoặc sai định dạng số' });
        }

        currentTime = Date.now();

        // 2. Tính toán tốc độ thay đổi
        if (appState.lastSensorData.timestamp !== null) { // Sửa: Dùng appState
            const timeDiffSeconds = (currentTime - appState.lastSensorData.timestamp) / 1000;
            if (timeDiffSeconds > 0) {
                b_rate_of_change = (mucNuocB - appState.lastSensorData.mucNuocB) / timeDiffSeconds;
                flow_rate_of_change = (luuLuong - appState.lastSensorData.luuLuong) / timeDiffSeconds;
            }
        }
        const currentSensorData = { mucNuocB, luuLuong, timestamp: currentTime };

        // 3. Xử lý Cảnh báo Dâng nhanh (Logic riêng)
        if (b_rate_of_change > RAPID_RISE_THRESHOLD && !appState.sentRapidRiseNotification) { // Sửa: Dùng appState
            console.warn(`🌊 Phát hiện nước dâng nhanh! Tốc độ B: ${b_rate_of_change.toFixed(2)} cm/s`);
            await sendRapidRiseNotification(b_rate_of_change);
            appState.sentRapidRiseNotification = true; // Sửa: Dùng appState
        } else if (b_rate_of_change <= 0 && appState.sentRapidRiseNotification) { // Sửa: Dùng appState
            console.info("💧 Nước ngừng dâng nhanh.");
            appState.sentRapidRiseNotification = false; // Sửa: Dùng appState
        }

        // 4. Gọi AI để dự đoán
        const ab_diff = mucNuocB - mucNuocA;
        const is_raining_now = isRaining ? 1 : 0;
        const ai_payload = { 
            mucNuocA, mucNuocB, luuLuong, 
            is_raining_now, b_rate_of_change, 
            flow_rate_of_change, ab_diff 
        };

        try {
            const [statusRes, timeRes] = await Promise.all([
                axios.post(`${PYTHON_SERVER_URL}/predict`, ai_payload),
                axios.post(`${PYTHON_SERVER_URL}/predict_time`, ai_payload)
            ]);
            
            duDoanTrangThai = statusRes.data.prediction;
            duDoanThoiGian = parseFloat(timeRes.data.predicted_seconds);
            if (isNaN(duDoanThoiGian)) duDoanThoiGian = -1;

            console.log(`[🧠 AI Status]: ${duDoanTrangThai}, Countdown: ${duDoanThoiGian >= 0 ? duDoanThoiGian.toFixed(2) + 's' : 'N/A'}`);

            // 5. Xử lý Cảnh báo AI
            // Sửa: Dùng hàm shouldSendAIStatusNotification để kiểm tra token VÀ sự thay đổi
            if (shouldSendAIStatusNotification(appState.lastSentAIStatus, duDoanTrangThai)) {
                console.log(`🔄 TRẠNG THÁI AI THAY ĐỔI: ${appState.lastSentAIStatus} -> ${duDoanTrangThai}`);
                await sendAIStatusNotification(duDoanTrangThai, duDoanThoiGian);
                appState.lastSentAIStatus = duDoanTrangThai; // Cập nhật trạng thái đã gửi
                
                // Reset thời gian cảnh báo nguy hiểm khi trạng thái thay đổi
                if (duDoanTrangThai !== "Nguy hiểm!") {
                    appState.lastDangerAlertTime = null; // Sửa: Dùng appState
                }
            }

            // 6. Xử lý Cảnh báo Định kỳ (cho "Nguy hiểm!")
            if (duDoanTrangThai === "Nguy hiểm!" && appState.fcmToken) { // Sửa: Dùng appState
                const now = Date.now();
                // Gửi nếu chưa gửi lần nào HOẶC đã hơn 2 phút kể từ lần gửi trước
                if (!appState.lastDangerAlertTime || (now - appState.lastDangerAlertTime) > 2 * 60 * 1000) { // Sửa: Dùng appState
                    console.log("🔄 Gửi cảnh báo định kỳ cho trạng thái NGUY HIỂM");
                    await sendAIStatusNotification(duDoanTrangThai, duDoanThoiGian);
                    appState.lastDangerAlertTime = now; // Sửa: Dùng appState
                }
            }

        } catch (ai_err) {
            console.error("❌ Lỗi khi gọi API dự đoán (Python):", ai_err.message);
            // Giữ nguyên trạng thái lỗi, không gửi thông báo
        }

        // 7. Lưu vào CSDL
        const sql = `INSERT INTO sensor_data 
            (mucNuocA, mucNuocB, luuLuong, trangThai, thongBao, created_at, predicted_trangthai, time_until_a_danger, predicted_time_to_a, is_raining) 
            VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9)`;
        const values = [
            mucNuocA, mucNuocB, luuLuong, 
            trangThaiSimulator, thongBaoSimulator, 
            duDoanTrangThai, time_until_a_danger_simulator, 
            duDoanThoiGian, isRaining
        ];
        
        // Chỉ thực thi query nếu 'pool' đã được khởi tạo
        if (pool) {
            await pool.query(sql, values);
            console.log(`[✓] DB Save: A:${mucNuocA.toFixed(1)}, B:${mucNuocB.toFixed(1)}, Mưa:${isRaining ? 'CÓ':'KO'}, Tốc độ B: ${b_rate_of_change.toFixed(2)} cm/s`);
        } else {
            console.error("❌ Bỏ qua DB Save: CSDL pool chưa được khởi tạo.");
        }


        // 8. Cập nhật trạng thái (sau khi mọi thứ thành công)
        appState.lastSensorData = currentSensorData; // Sửa: Dùng appState

        // 9. Phản hồi
        res.status(200).json({
            message: 'Đã lưu và dự đoán thành công.',
            prediction_status: duDoanTrangThai,
            prediction_time: duDoanThoiGian
        });

    } catch (err) {
        // Xử lý lỗi chung
        console.error('❌ Lỗi không xác định trong /update:', err.message);
        
        // Cập nhật trạng thái (nếu có thể) để tránh lỗi tính toán lần sau
        if (currentTime) {
            const body = req.body || {};
            appState.lastSensorData = { // Sửa: Dùng appState
                mucNuocB: parseFloat(body.mucNuocB) || appState.lastSensorData.mucNuocB || 0,
                luuLuong: parseFloat(body.luuLuong) || appState.lastSensorData.luuLuong || 0,
                timestamp: currentTime
            };
        }
        
        res.status(500).json({
            error: 'Lỗi server khi xử lý dữ liệu',
            details: err.message,
            prediction_status: duDoanTrangThai,
            prediction_time: duDoanThoiGian
        });
    }
});

/** API: Lấy dữ liệu mới nhất (cho MainActivity) */
app.get('/data', async (req, res) => {
    if (!pool) {
        console.error("❌ Lỗi /data: CSDL pool chưa được khởi tạo.");
        return res.status(500).json({ error: 'Lỗi server: CSDL chưa sẵn sàng' });
    }
    try {
        const sql = 'SELECT * FROM sensor_data ORDER BY id DESC LIMIT 1';
        const result = await pool.query(sql);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Chưa có dữ liệu.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error('❌ Lỗi khi lấy dữ liệu /data:', err.message);
        res.status(500).json({ error: 'Lỗi server khi lấy dữ liệu' });
    }
});

/** API: Lấy dữ liệu cho biểu đồ (ChartActivity) */
app.get('/api/chart_data', async (req, res) => {
    if (!pool) {
        console.error("❌ Lỗi /api/chart_data: CSDL pool chưa được khởi tạo.");
        return res.status(500).json({ error: 'Lỗi server: CSDL chưa sẵn sàng' });
    }
    try {
        const sql = `
            WITH Last300 AS ( SELECT * FROM sensor_data ORDER BY id DESC LIMIT 300 )
            SELECT * FROM Last300 ORDER BY id ASC;
        `;
        const result = await pool.query(sql);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('❌ Lỗi khi lấy dữ liệu /api/chart_data:', err.message);
        res.status(500).json({ error: 'Lỗi server khi lấy dữ liệu biểu đồ' });
    }
});

/** API: Lấy dữ liệu lịch sử theo ngày (HistoryActivity) */
app.get('/api/history_by_date', async (req, res) => {
    if (!pool) {
        console.error("❌ Lỗi /api/history_by_date: CSDL pool chưa được khởi tạo.");
        return res.status(500).json({ error: 'Lỗi server: CSDL chưa sẵn sàng' });
    }
    try {
        const { date } = req.query;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'Thiếu hoặc sai định dạng tham số ngày (cần YYYY-MM-DD)' });
        }
        const sql = `SELECT * FROM sensor_data WHERE created_at::date = $1 ORDER BY id DESC;`;
        const result = await pool.query(sql, [date]);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('❌ Lỗi khi lấy lịch sử /api/history_by_date:', err.message);
        res.status(500).json({ error: 'Lỗi server khi lấy lịch sử' });
    }
});
// =============================
// KIỂM TRA & TẠO BẢNG CSDL (Nếu chưa tồn tại)
// =============================
async function setupDatabase() {
    // Không cần chạy nếu kết nối CSDL bị lỗi
    if (!pool) return;

    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS sensor_data (
            id SERIAL PRIMARY KEY,
            mucNuocA NUMERIC(10, 2) NOT NULL,
            mucNuocB NUMERIC(10, 2) NOT NULL,
            luuLuong NUMERIC(10, 2) NOT NULL,
            is_raining BOOLEAN DEFAULT FALSE,
            trangThai VARCHAR(50), 
            thongBao TEXT,
            predicted_trangthai VARCHAR(50), 
            predicted_time_to_a NUMERIC(10, 2),
            time_until_a_danger NUMERIC(10, 2),
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;
    try {
        // Lệnh này chỉ tạo bảng nếu nó CHƯA tồn tại
        await pool.query(createTableQuery); 
        console.log("✅ [DB Setup] Bảng 'sensor_data' đã được tạo hoặc đã tồn tại.");
    } catch (err) {
        console.error("❌ [DB Setup] Lỗi khi tạo bảng 'sensor_data':", err.message);
    }
}

// Gọi hàm này ngay khi server khởi động
setupDatabase();

// =============================
// KHỞI ĐỘNG SERVER
// =============================
app.listen(SERVER_PORT, () => {
    // Railway sẽ dùng PORT động, nhưng log này vẫn hữu ích
    console.log(`🚀 Server Node.js đang chạy tại cổng: ${SERVER_PORT}`);
    console.log(`🧠 Đang kết nối tới API dự đoán tại: ${PYTHON_SERVER_URL}`);
    console.log(`📱 Hệ thống sẵn sàng nhận FCM token từ điện thoại!!`);
    console.log(`🔔 Hệ thống sẽ gửi cảnh báo KHI AI THAY ĐỔI TRẠNG THÁI`);
}); 