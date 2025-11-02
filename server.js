/**
 * index.js (Hoàn chỉnh, Sạch)
 *
 * Server đầy đủ chức năng:
 * - Kết nối DB (Local/Cloud)
 * - Kết nối Firebase (Local/Cloud)
 * - Gọi AI Python
 * - Chức năng Trạm Trung Chuyển (Đọc từ .env)
 * - Sửa lỗi "0 giây"
 * - Sửa lỗi Timezone
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config(); // Đọc file .env
const admin = require('firebase-admin');
const multer = require('multer'); // Giữ lại multer cho API /upload

// --------------- DEBUG ENV ----------------
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
if (process.env.RAILWAY_DB_URL) {
  console.log("✅ [DEBUG] ĐÃ TÌM THẤY BIẾN ĐỒNG BỘ RAILWAY_DB_URL.");
} else {
  console.log("⚠️ [DEBUG] KHÔNG TÌM THẤY BIẾN RAILWAY_DB_URL (Sẽ chỉ chạy local).");
}
console.log("--- KẾT THÚC DEBUG ---");

// --------------- CONFIG --------------------
const SERVER_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const PYTHON_SERVER_URL = process.env.PYTHON_SERVER_URL || "http://localhost:5001";
const RAPID_RISE_THRESHOLD = process.env.RAPID_RISE_THRESHOLD ? parseFloat(process.env.RAPID_RISE_THRESHOLD) : 0.5; // cm/s
// (Xóa các biến sync của file index.js cũ, vì chúng ta dùng trạm trung chuyển)

// --------------- DB POOL -------------------
let pool; // Đây là CSDL chính (Local hoặc Cloud)
let railwayPool; // Đây là CSDL Cloud (dùng cho trạm trung chuyển)

try {
    if (process.env.DATABASE_URL) {
        // MÔI TRƯỜNG CLOUD (RAILWAY)
        console.log("✅ [DB Config] Đang kết nối CSDL Cloud (sử dụng DATABASE_URL)...");
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
        railwayPool = null; // (Trên Cloud, không cần trạm trung chuyển)

    } else {
        // MÔI TRƯỜNG LOCAL (MÁY BẠN)
        console.log("⚠️ [DB Config] Đang kết nối CSDL Local (sử dụng DB_CONFIG)...");
        const DB_CONFIG = {
            user: process.env.DB_USER || 'postgres',
            host: process.env.DB_HOST || 'localhost',
            database: process.env.DB_NAME || 'flood_alert_db',
            password: process.env.DB_PASS || 'Quan@',
            port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
        };
        pool = new Pool(DB_CONFIG);

        // (CHỨC NĂNG TRẠM TRUNG CHUYỂN: Kết nối CSDL Cloud từ file .env)
        if (process.env.RAILWAY_DB_URL) {
            railwayPool = new Pool({
                connectionString: process.env.RAILWAY_DB_URL,
                ssl: { rejectUnauthorized: false }
            });
            console.log("✅ [DB Sync] Đã kết nối CSDL Cloud (Railway) để sẵn sàng đồng bộ.");
        } else {
            console.warn("⚠️ [DB Sync] Không tìm thấy RAILWAY_DB_URL trong .env, sẽ chỉ lưu vào Local.");
            railwayPool = null;
        }
    }
} catch (dbErr) {
    console.error("❌ LỖI KHI KHỞI TẠO CSDL POOL:", dbErr && dbErr.message ? dbErr.message : dbErr);
    pool = null;
}

// --------------- FIREBASE ADMIN -------------
try {
    if (process.env.SERVICE_ACCOUNT_JSON) {
        console.log("✅ [Firebase] Khởi tạo từ SERVICE_ACCOUNT_JSON (env)");
        const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } else {
        const localServicePath = path.join(__dirname, 'serviceAccountKey.json');
        if (fs.existsSync(localServicePath)) {
            console.log("⚠️ [Firebase] Khởi tạo từ file 'serviceAccountKey.json' (Local)");
            const serviceAccount = require(localServicePath);
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        } else {
            console.warn("⚠️ Firebase Admin chưa được khởi tạo: không tìm thấy SERVICE_ACCOUNT_JSON và serviceAccountKey.json.");
        }
    }
} catch (error) {
    console.error("❌ LỖI KHI KHỞI TẠO FIREBASE ADMIN:", error && error.message ? error.message : error);
}

// --------------- APP STATE -----------------
const appState = {
    fcmToken: null,
    lastSensorData: { mucNuocB: null, luuLuong: null, timestamp: null },
    lastSentAIStatus: "Bình thường",
    sentRapidRiseNotification: false,
    lastDangerAlertTime: null
};

// --------------- EXPRESS APP ---------------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors());
const upload = multer({ dest: path.join(__dirname, 'uploads/') }); // (Giữ lại /upload API)

// --------------- HELPERS -------------------
function formatCountdown(seconds) {
    if (seconds === null || seconds === undefined || isNaN(seconds) || seconds < 0) return null;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    return (minutes > 0) ? `${minutes} phút ${remainingSeconds} giây` : `${remainingSeconds} giây`;
}
function getNotificationTitle(status) {
    const titleMap = {
        "Bình thường": "✅ Tình hình ổn định", "Cảnh báo!": "⚠️ Cảnh báo Lũ",
        "Cảnh báo Cao!": "🔶 Cảnh báo Lũ Cao", "Nguy hiểm!": "🚨 BÁO ĐỘNG NGUY HIỂM"
    };
    return titleMap[status] || `Cảnh báo: ${status}`;
}
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
        if (countdown < 300) body += " HÃY DI CHUYỂN ĐẾN NƠI AN TOÀN NGAY!";
    }
    return body;
}
function shouldSendAIStatusNotification(lastStatus, currentStatus) {
    if (!appState.fcmToken) { console.log("📱 Chưa có FCM token, bỏ qua thông báo!"); return false; }
    if (lastStatus !== currentStatus) { console.log(`🔄 Thay đổi trạng thái AI: ${lastStatus} -> ${currentStatus}`); return true; }
    return false;
}

// --------------- PUSH (FCM) ----------------
async function sendPushNotificationInternal(title, body) {
    if (!admin.apps.length) { console.error("❌ Firebase Admin chưa khởi tạo."); return false; }
    if (!appState.fcmToken) { console.warn("sendPushNotificationInternal: fcmToken là null."); return false; }
    const message = {
        notification: { title, body }, token: appState.fcmToken,
        android: { priority: 'high', notification: { sound: 'default', channelId: 'FloodWarningChannel', icon: 'ic_warning', color: '#FF0000' } },
        apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default', alert: { title, body } } } }
    };
    try {
        await admin.messaging().send(message);
        console.log(`✅ ĐÃ GỬI THÔNG BÁO: ${title}`); return true;
    } catch (error) {
        console.error(`❌ Lỗi gửi Push Notification: ${error && error.message ? error.message : error}`);
        if (error && (error.code === 'messaging/registration-token-not-registered' || error.code === 'messaging/invalid-registration-token')) {
            console.warn(`🗑️ FCM token không hợp lệ. Xóa token.`); appState.fcmToken = null;
        }
        return false;
    }
}
async function sendAIStatusNotification(status, countdown) {
    const title = getNotificationTitle(status); const body = getNotificationBody(status, countdown);
    console.log(`📤 Chuẩn bị gửi thông báo AI: ${status}`); await sendPushNotificationInternal(title, body);
}
async function sendRapidRiseNotification(rate) {
    const title = "🌊 Cảnh báo: Nước Dâng Nhanh!"; const body = `Phát hiện mực nước B đang dâng nhanh (${rate.toFixed(1)} cm/s).`;
    console.log(`📤 Chuẩn bị gửi thông báo dâng nhanh`); await sendPushNotificationInternal(title, body);
}

// --------------- DB INIT (CREATE TABLE IF NOT EXISTS) -------------
async function ensureTables() {
    if (!pool) return;
    const createSql = `
    CREATE TABLE IF NOT EXISTS sensor_data (
        id SERIAL PRIMARY KEY,
        mucNuocA REAL,
        mucNuocB REAL,
        luuLuong REAL,
        trangThai VARCHAR(255),
        thongBao TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        predicted_trangthai VARCHAR(255),
        time_until_a_danger VARCHAR(255),
        predicted_time_to_a REAL,
        is_raining BOOLEAN
    );
    `;
    try {
        await pool.query(createSql);
        console.log("✅ Bảng sensor_data (Local) sẵn sàng.");
        // Đảm bảo bảng CSDL Cloud cũng tồn tại
        if (railwayPool) {
            await railwayPool.query(createSql);
            console.log("✅ Bảng sensor_data (Cloud Sync) sẵn sàng.");
        }
    } catch (err) {
        console.error("❌ Lỗi tạo bảng sensor_data:", err && err.message ? err.message : err);
    }
}
ensureTables().catch(e=>console.error(e)); // Chạy khi khởi động

// --------------- ROUTES ---------------------
// Health check
app.get('/', (req, res) => {
    res.send({ status: 'OK', now: new Date().toISOString() });
});

// Register FCM token
app.post('/api/register_fcm_token', (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ error: 'Missing token' });
        appState.fcmToken = token;
        console.log(`✅ Đã nhận FCM token: ${token.substring(0,10)}...`);
        res.json({ message: 'OK' });
    } catch (err) {
        console.error("❌ /api/register_fcm_token error:", err && err.message ? err.message : err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Main update endpoint
app.post('/update', async (req, res) => {
    let duDoanTrangThai = "Lỗi dự đoán";
    let duDoanThoiGian = -1;
    let b_rate_of_change = 0;
    let flow_rate_of_change = 0;
    let currentTime;
    try {
        const body = req.body || {};
        const { mucNuocA: mA, mucNuocB: mB, luuLuong: lL, isRaining: iR, trangThai: tS, thongBao: tBS, time_until_a_danger: tUAD } = body;

        const mucNuocA = parseFloat(mA); const mucNuocB = parseFloat(mB); const luuLuong = parseFloat(lL);
        const isRaining = iR === true || iR === 'true'; // Chấp nhận cả boolean và string 'true'
        const trangThaiSimulator = tS || '';
        const thongBaoSimulator = tBS || ''; const time_until_a_danger_simulator = tUAD;

        if (isNaN(mucNuocA) || isNaN(mucNuocB) || isNaN(luuLuong) || typeof body.isRaining === 'undefined') {
            console.warn("⚠️ Yêu cầu /update thiếu dữ liệu.");
            return res.status(400).json({ error: 'Thiếu dữ liệu hoặc sai định dạng' });
        }

        currentTime = Date.now();

        // 2. Tính tốc độ thay đổi
        if (appState.lastSensorData.timestamp !== null) {
            const timeDiffSeconds = (currentTime - appState.lastSensorData.timestamp) / 1000;
            if (timeDiffSeconds > 0) {
                const lastB = appState.lastSensorData.mucNuocB !== null ? appState.lastSensorData.mucNuocB : mucNuocB;
                const lastFlow = appState.lastSensorData.luuLuong !== null ? appState.lastSensorData.luuLuong : luuLuong;
                b_rate_of_change = (mucNuocB - lastB) / timeDiffSeconds;
                flow_rate_of_change = (luuLuong - lastFlow) / timeDiffSeconds;
       }
        }
        const currentSensorData = { mucNuocB, luuLuong, timestamp: currentTime };

        // 3. Cảnh báo dâng nhanh
        if (b_rate_of_change > RAPID_RISE_THRESHOLD && !appState.sentRapidRiseNotification) {
            console.warn(`🌊 Nước dâng nhanh! Tốc độ B: ${b_rate_of_change.toFixed(2)} cm/s`);
            await sendRapidRiseNotification(b_rate_of_change);
            appState.sentRapidRiseNotification = true;
        } else if (b_rate_of_change <= 0 && appState.sentRapidRiseNotification) {
            console.info("💧 Nước ngừng dâng nhanh.");
            appState.sentRapidRiseNotification = false;
        }

        // 4. Gọi AI
        // (CHỈ GỌI AI NẾU SERVER LÀ LOCAL HOẶC BIẾN CLOUD_AI=true)
        if (!process.env.DATABASE_URL || process.env.CLOUD_AI === 'true') {
            try {
                const ai_payload = { 
                    mucNuocA, mucNuocB, luuLuong, is_raining_now: isRaining ? 1 : 0, 
                    b_rate_of_change, flow_rate_of_change, ab_diff: mucNuocB - mucNuocA 
                };
                const [statusRes, timeRes] = await Promise.all([
                    axios.post(`${PYTHON_SERVER_URL}/predict`, ai_payload, { timeout: 6000 }),
                    axios.post(`${PYTHON_SERVER_URL}/predict_time`, ai_payload, { timeout: 6000 })
                ]);
                duDoanTrangThai = statusRes?.data?.prediction || duDoanTrangThai;
                duDoanThoiGian = parseFloat(timeRes?.data?.predicted_seconds) || -1;
                console.log(`[🧠 AI Status]: ${duDoanTrangThai}, Countdown: ${duDoanThoiGian >= 0 ? duDoanThoiGian.toFixed(2) + 's' : 'N/A'}`);
            } catch (ai_err) {
                console.error("❌ Lỗi gọi API dự đoán (Python):", ai_err && ai_err.message ? ai_err.message : ai_err);
            }
        }

        // 5. Gửi thông báo
        if (shouldSendAIStatusNotification(appState.lastSentAIStatus, duDoanTrangThai)) {
            await sendAIStatusNotification(duDoanTrangThai, duDoanThoiGian);
            appState.lastSentAIStatus = duDoanTrangThai;
            if (duDoanTrangThai !== "Nguy hiểm!") appState.lastDangerAlertTime = null;
        }
        if (duDoanTrangThai === "Nguy hiểm!" && appState.fcmToken) {
            const now = Date.now();
            if (!appState.lastDangerAlertTime || (now - appState.lastDangerAlertTime) > 2 * 60 * 1000) {
                console.log("🔄 Gửi cảnh báo định kỳ NGUY HIỂM");
                await sendAIStatusNotification(duDoanTrangThai, duDoanThoiGian);
                appState.lastDangerAlertTime = now;
            }
        }

        // ==========================================
        // === 7. LƯU DỮ LIỆU VÀO DB (Gửi 2 nơi)
        // ==========================================
        const sql = `INSERT INTO sensor_data 
            (mucNuocA, mucNuocB, luuLuong, trangThai, thongBao, created_at, predicted_trangthai, time_until_a_danger, predicted_time_to_a, is_raining) 
            VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9) RETURNING id, created_at`;

        // (SỬA LỖI TRÁO NGƯỢC "0 giây" - ĐÃ SỬA)
        const values = [
            mucNuocA, // $1
            mucNuocB, // $2
            luuLuong, // $3
            trangThaiSimulator, // $4
            thongBaoSimulator, // $5
            duDoanTrangThai, // $6
            
            // $7 (CHO CỘT "time_until_a_danger" [VARCHAR/STRING])
         formatCountdown(typeof time_until_a_danger_simulator !== 'undefined' && time_until_a_danger_simulator !== null ? time_until_a_danger_simulator : duDoanThoiGian), 
            
            // $8 (CHO CỘT "predicted_time_to_a" [REAL/NUMBER])
            (typeof duDoanThoiGian === 'number' && !isNaN(duDoanThoiGian)) ? duDoanThoiGian : null, 
            
            isRaining // $9
        ];

        // Tạo mảng tác vụ
        const dbTasks = [];
        const logMsg = `[DB Save]: A:${mucNuocA.toFixed(1)}, B:${mucNuocB.toFixed(1)}`;
        let savedRecord = null; // Biến để lưu trữ created_at cho CSDL offline

        // Tác vụ 1: Lưu vào CSDL Chính (Local hoặc Cloud)
        if (pool) {
            dbTasks.push(
                pool.query(sql, values)
                    .then((dbRes) => {
                        savedRecord = dbRes.rows && dbRes.rows[0] ? dbRes.rows[0] : null;
                        console.log(`[✓] ${process.env.DATABASE_URL ? '[Cloud]' : '[Local]'} ${logMsg}`);
                    })
                    .catch(err => console.error(`❌ Lỗi ${process.env.DATABASE_URL ? '[Cloud]' : '[Local]'} DB Save:`, err.message))
            );
        }

        // Tác vụ 2: Lưu vào CSDL Cloud (CHỈ KHI CHẠY LOCAL)
        if (railwayPool) { // railwayPool chỉ tồn tại khi chạy local
            dbTasks.push(
                railwayPool.query(sql, values)
                    .then(() => console.log(`[✓] [Sync->Cloud] ${logMsg}`))
                    .catch(err => console.error("❌ Lỗi [Sync->Cloud] DB Save:", err.message))
            );
        }

        // Đợi cả hai CSDL lưu xong
        await Promise.all(dbTasks);

        // (Xóa khối "attempt to sync" cũ vì "trạm trung chuyển" đã thay thế nó)

        // 8. Cập nhật trạng thái
        appState.lastSensorData = currentSensorData;

        // 9. Phản hồi
        res.status(200).json({
            message: 'Đã lưu và dự đoán thành công.',
            prediction_status: duDoanTrangThai,
            prediction_time: duDoanThoiGian
        });

    } catch (err) {
        console.error("❌ Lỗi /update:", err && err.message ? err.message : err);
        if (currentTime) {
            const body = req.body || {};
            appState.lastSensorData = {
                mucNuocB: parseFloat(body.mucNuocB) || appState.lastSensorData.mucNuocB || 0,
                luuLuong: parseFloat(body.luuLuong) || appState.lastSensorData.luuLuong || 0,
                timestamp: currentTime
            };
        }
        res.status(500).json({ error: 'Lỗi server khi xử lý dữ liệu', details: err && err.message ? err.message : err });
    }
});

// Get latest data
app.get('/data', async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'CSDL chưa sẵn sàng' });
    try {
        const sql = 'SELECT * FROM sensor_data ORDER BY id DESC LIMIT 1';
        const result = await pool.query(sql);
        if (!result || !result.rows || result.rows.length === 0) return res.status(404).json({ message: 'Chưa có dữ liệu.' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error("❌ /data error:", err && err.message ? err.message : err);
        res.status(500).json({ error: 'Lỗi server khi lấy dữ liệu' });
    }
});

// Chart data - last N samples
app.get('/api/chart_data', async (req, res) => {
    try {
        if (!pool) return res.status(500).json({ error: 'CSDL chưa sẵn sàng' });
        const sql = `
            SELECT id, mucnuoca, mucnuocb, luuluong, predicted_trangthai, created_at
            FROM sensor_data
            ORDER BY id DESC
            LIMIT 300;
        `;
        const result = await pool.query(sql);
        const rows = (result.rows || []).reverse();
        res.json(rows);
    } catch (err) {
        console.error("❌ /api/chart_data error:", err && err.message ? err.message : err);
        res.status(500).json({ error: 'Lỗi server khi lấy dữ liệu biểu đồ' });
    }
});

// History by date
app.get('/api/history_by_date', async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'CSDL chưa sẵn sàng' });
    try {
        const { date } = req.query;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'Thiếu hoặc sai định dạng tham số ngày (YYYY-MM-DD)' });
        }
        // (SỬA LỖI TIMEZONE - ĐÃ SỬA)
        const sql = `SELECT * FROM sensor_data WHERE (created_at AT TIME ZONE '+07')::date = $1 ORDER BY id DESC;`;
     const result = await pool.query(sql, [date]);
        res.json(result.rows || []);
    } catch (err) {
        console.error("❌ /api/history_by_date error:", err && err.message ? err.message : err);
        res.status(500).json({ error: 'Lỗi server khi lấy lịch sử' });
    }
});

// (Xóa các API thừa của index.js: /admin/force_sync, /upload, queue)
// (Vì logic "trạm trung chuyển" đã thay thế chúng)

// --------------- START SERVER ----------------
app.listen(SERVER_PORT, () => {
    console.log(`🚀 Server Node.js đang chạy tại cổng: ${SERVER_PORT}`);
    console.log(`🧠 Kết nối tới AI Python: ${PYTHON_SERVER_URL}`);
    console.log("📱 Sẵn sàng nhận FCM token từ client.");
});