// DEBUG: kiểm tra biến môi trường
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

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config(); // Đọc file .env
const admin = require('firebase-admin');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// =============================
// CẤU HÌNH HỆ THỐNG
// =============================
const SERVER_PORT = process.env.PORT || 3000;
const PYTHON_SERVER_URL = process.env.PYTHON_SERVER_URL || "http://localhost:5001";
const RAPID_RISE_THRESHOLD = 0.3; // cm/giây - GIẢM NGƯỠNG XUỐNG 0.3
const ABSOLUTE_RISE_THRESHOLD = 3; // cm - THÊM NGƯỠNG TĂNG TUYỆT ĐỐI (GIẢM XUỐNG 3cm)
const HIGH_WATER_LEVEL_THRESHOLD = 12; // cm - THÊM NGƯỠNG MỰC NƯỚC CAO
const TOKEN_SYNC_INTERVAL = 30000; // 30 giây

// =============================
// KHỞI TẠO CSDL (DATABASE)
// =============================
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
    console.error("❌ LỖI NGHIÊM TRỌNG KHI KHỞI TẠO CSDL POOL:", dbErr.message);
}

// =============================
// KHỞI TẠO FIREBASE ADMIN
// =============================
try {
    if (process.env.SERVICE_ACCOUNT_JSON) {
        console.log("✅ [Firebase] Đang khởi tạo từ BIẾN MÔI TRƯỜNG (Cloud)...");
        const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        console.log("✅ Firebase Admin SDK đã khởi tạo từ BIẾN MÔI TRƯỜNG (Cloud).");
    } else {
        const localServicePath = path.join(__dirname, 'serviceAccountKey.json');
        if (fs.existsSync(localServicePath)) {
            console.log("⚠️ [Firebase] Đang khởi tạo từ file './serviceAccountKey.json' (Local)...");
            const serviceAccount = require(localServicePath);
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            console.log("✅ Firebase Admin SDK đã khởi tạo từ FILE (Local).");
        } else {
            console.warn("⚠️ Firebase Admin chưa được khởi tạo: không tìm thấy SERVICE_ACCOUNT_JSON và serviceAccountKey.json.");
        }
    }
} catch (error) {
    console.error("❌ LỖI NGHIÊM TRỌNG KHI KHỞI TẠO FIREBASE ADMIN:", error && error.message ? error.message : error);
}

// =============================
// TRẠNG THÁI MÁY CHỦ (State)
// =============================
const appState = {
    fcmTokens: [],
    lastSensorData: { mucNuocB: null, luuLuong: null, timestamp: null },
    lastSentAIStatus: "Bình thường",
    sentRapidRiseNotification: false,
    rapidRiseNotificationTime: null,
    lastAbsoluteRiseAlert: { value: null, time: null },
    lastHighWaterAlert: { value: null, time: null }, // THÊM: Cảnh báo mực nước cao
    lastDangerAlertTime: null,
    b_total_rise_start: null // THÊM: Theo dõi tổng mức tăng từ đầu
};

// =============================
// KHỞI TẠO ỨNG DỤNG
// =============================
const app = express();
app.use(express.json());
app.use(cors());
const upload = multer({ dest: path.join(__dirname, 'uploads/') });

// =============================
// HÀM HỖ TRỢ (Helpers)
// =============================
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
    if (!appState.fcmTokens || appState.fcmTokens.length === 0) { 
        console.log("📱 Chưa có FCM token (đang chờ đồng bộ từ Cloud DB), bỏ qua thông báo!"); 
        return false; 
    }
    if (lastStatus !== currentStatus) { console.log(`🔄 Thay đổi trạng thái AI: ${lastStatus} -> ${currentStatus}`); return true; }
    return false;
}

// =============================
// HÀM GỬI THÔNG BÁO PUSH
// =============================
async function sendPushNotificationInternal(title, body) {
    if (!admin.apps.length) { console.error("❌ Firebase Admin chưa khởi tạo."); return false; }
    if (!appState.fcmTokens || appState.fcmTokens.length === 0) { 
        console.warn("sendPushNotificationInternal: Bỏ qua vì danh sách fcmTokens rỗng (chưa đồng bộ được)."); 
        return false; 
    }
    
    const message = {
        notification: { title: title, body: body }, 
        tokens: appState.fcmTokens,
        android: { priority: 'high', notification: { sound: 'default', channelId: 'FloodWarningChannel', icon: 'ic_warning', color: '#FF0000' } },
        apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default', alert: { title: title, body: body } } } }
    };
    
    try {
        const response = await admin.messaging().sendEachForMulticast(message);
        console.log(`✅ ĐÃ GỬI THÔNG BÁO đến ${response.successCount} máy. Thất bại: ${response.failureCount} máy.`);
        
        if (response.failureCount > 0) {
            const tokensToDelete = [];
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    const errorCode = resp.error.code;
                    if (errorCode === 'messaging/registration-token-not-registered' || errorCode === 'messaging/invalid-registration-token') {
                        const badToken = appState.fcmTokens[idx];
                        console.warn(`🗑️ Phát hiện token hỏng (sẽ xóa): ${badToken}`);
                        tokensToDelete.push(badToken);
                    }
                }
            });

            if (tokensToDelete.length > 0 && (railwayPool || pool)) {
                const db = railwayPool || pool; 
                try {
                    await db.query("DELETE FROM fcm_tokens WHERE token = ANY($1::text[])", [tokensToDelete]);
                    console.log(`🗑️ Đã xóa ${tokensToDelete.length} token hỏng khỏi CSDL.`);
                } catch (e) {
                    console.error("❌ Lỗi khi xóa token hỏng:", e.message);
                }
            }
        }
        return true;

    } catch (error) {
        console.error(`❌ Lỗi nghiêm trọng khi gửi Push Notification: ${error && error.message ? error.message : error}`);
        return false;
    }
}
async function sendAIStatusNotification(status, countdown) {
    const title = getNotificationTitle(status); const body = getNotificationBody(status, countdown);
    console.log(`📤 Chuẩn bị gửi thông báo AI: ${status}`); await sendPushNotificationInternal(title, body);
}
async function sendRapidRiseNotification(rate) {
    const title = "🌊 Cảnh báo: Nước Dâng Nhanh!"; 
    const body = `Phát hiện mực nước B đang dâng nhanh (${rate.toFixed(1)} cm/s). Cần theo dõi chặt chẽ!`;
    console.log(`📤 Chuẩn bị gửi thông báo dâng nhanh`); await sendPushNotificationInternal(title, body);
}
async function sendAbsoluteRiseNotification(absoluteRise) {
    const title = "📈 Cảnh báo: Mực nước Tăng Mạnh!"; 
    const body = `Mực nước B đã tăng ${absoluteRise.toFixed(1)} cm so với lần trước. Cần cảnh giác!`;
    console.log(`📤 Chuẩn bị gửi thông báo tăng mạnh`); await sendPushNotificationInternal(title, body);
}
// THÊM HÀM MỚI: Cảnh báo mực nước cao
async function sendHighWaterNotification(waterLevel) {
    const title = "💧 Cảnh báo: Mực nước Cao!"; 
    const body = `Mực nước B đang ở mức ${waterLevel.toFixed(1)} cm. Cần theo dõi sát sao!`;
    console.log(`📤 Chuẩn bị gửi thông báo mực nước cao`); await sendPushNotificationInternal(title, body);
}

// =============================
// KHỞI TẠO BẢNG CSDL (Nếu chưa có)
// =============================
async function ensureTables() {
    if (!pool) {
        console.error("❌ Bỏ qua ensureTables: CSDL chính 'pool' chưa được khởi tạo.");
        return;
    }
    
    const createSqlSensorData = `
    CREATE TABLE IF NOT EXISTS sensor_data (
        id SERIAL PRIMARY KEY,
        mucNuocA REAL, mucNuocB REAL, luuLuong REAL,
        trangThai VARCHAR(255), thongBao TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        predicted_trangthai VARCHAR(255),
        time_until_a_danger VARCHAR(255),
        predicted_time_to_a REAL, 
        is_raining BOOLEAN
    );
    `;
    
    const createSqlFcm = `
    CREATE TABLE IF NOT EXISTS fcm_tokens (
        id SERIAL PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
    `;

    try {
        await pool.query(createSqlSensorData);
        console.log(`✅ Bảng sensor_data (${process.env.DATABASE_URL ? 'Cloud' : 'Local'}) sẵn sàng.`);
        
        if (process.env.DATABASE_URL) {
            await pool.query(createSqlFcm);
            console.log("✅ Bảng fcm_tokens (Cloud) sẵn sàng.");
        }
        
        if (railwayPool) {
            await railwayPool.query(createSqlSensorData);
            console.log("✅ Bảng sensor_data (Cloud Sync) sẵn sàng.");
            await railwayPool.query(createSqlFcm);
            console.log("✅ Bảng fcm_tokens (Cloud Sync) sẵn sàng.");
        }
    } catch (err) {
        console.error("❌ Lỗi tạo bảng:", err && err.message ? err.message : err);
    }
}
ensureTables().catch(e=>console.error(e));

// =============================
// (HÀM NÂNG CẤP: TỰ ĐỘNG LẤY NHIỀU TOKEN)
// =============================
async function syncTokenFromCloudDB() {
    if (!railwayPool) return; // Chỉ chạy ở Local
    
    try {
        const res = await railwayPool.query("SELECT token FROM fcm_tokens ORDER BY id DESC");
        
        if (res.rows.length > 0) {
            const cloudTokens = res.rows.map(row => row.token);
            if (JSON.stringify(cloudTokens) !== JSON.stringify(appState.fcmTokens)) {
                console.log(`🔄 [FCM Mailbox] Đã đồng bộ ${cloudTokens.length} token từ CSDL Cloud.`);
                appState.fcmTokens = cloudTokens;
            }
        } else {
            if (appState.fcmTokens.length > 0) {
                console.log("⚠️ [FCM Mailbox] Không tìm thấy token nào trong CSDL Cloud. Đã xóa danh sách local.");
                appState.fcmTokens = [];
            }
        }
    } catch (err) {
        console.error("❌ Lỗi đồng bộ FCM token từ Cloud DB:", err.message);
    }
}

// =============================
// API ENDPOINTS
// =============================
app.get('/', (req, res) => {
    res.send({ status: 'OK', now: new Date().toISOString() });
});

// (API NÂNG CẤP: Dùng "Hộp thư" cho nhiều máy)
app.post('/api/register_fcm_token', async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ error: 'Missing token' });

        if (pool) { // 'pool' ở đây là CSDL Cloud (nếu chạy trên Railway)
            const sql = "INSERT INTO fcm_tokens (token) VALUES ($1) ON CONFLICT (token) DO NOTHING;";
            await pool.query(sql, [token]);
            console.log(`✅ [FCM Mailbox] Đã LƯU/CẬP NHẬT token vào CSDL Cloud: ${token.substring(0,10)}...`);
            res.json({ message: 'Token saved to DB' });
        } else {
            console.error("❌ /api/register_fcm_token: Không thể lưu token, 'pool' chưa sẵn sàng.");
            res.status(500).json({ error: 'Server DB error' });
        }
        
    } catch (err) {
        console.error("❌ /api/register_fcm_token error:", err && err.message ? err.message : err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/update', async (req, res) => {
    let duDoanTrangThai = "Lỗi dự đoán";
    let duDoanThoiGian = -1;
    let b_rate_of_change = 0;
    let flow_rate_of_change = 0;
    let b_absolute_change = 0; // THÊM: Biến mới cho thay đổi tuyệt đối
    let currentTime;
    
    try {
        const body = req.body || {};
        const { mucNuocA: mA, mucNuocB: mB, luuLuong: lL, isRaining: iR, trangThai: tS, thongBao: tBS, time_until_a_danger: tUAD } = body;

        const mucNuocA = parseFloat(mA); const mucNuocB = parseFloat(mB); const luuLuong = parseFloat(lL);
        const isRaining = iR === true || iR === 'true';
        const trangThaiSimulator = tS || '';
        const thongBaoSimulator = tBS || ''; const time_until_a_danger_simulator = tUAD;

        if (isNaN(mucNuocA) || isNaN(mucNuocB) || isNaN(luuLuong) || typeof body.isRaining === 'undefined') {
            console.warn("⚠️ Yêu cầu /update thiếu dữ liệu.");
            return res.status(400).json({ error: 'Thiếu dữ liệu hoặc sai định dạng' });
        }

        currentTime = Date.now();

        // 2. Tính tốc độ thay đổi và mức tăng tuyệt đối
        let absoluteRise = 0;
        if (appState.lastSensorData.timestamp !== null && appState.lastSensorData.mucNuocB !== null) {
            const timeDiffSeconds = (currentTime - appState.lastSensorData.timestamp) / 1000;
            if (timeDiffSeconds > 0) {
                const lastB = appState.lastSensorData.mucNuocB;
                const lastFlow = appState.lastSensorData.luuLuong !== null ? appState.lastSensorData.luuLuong : luuLuong;
                b_rate_of_change = (mucNuocB - lastB) / timeDiffSeconds;
                flow_rate_of_change = (luuLuong - lastFlow) / timeDiffSeconds;
                absoluteRise = mucNuocB - lastB;
                b_absolute_change = absoluteRise; // Gán cho biến mới
            }
        }

        // KHỞI TẠO TỔNG MỨC TĂNG NẾU CHƯA CÓ
        if (appState.b_total_rise_start === null) {
            appState.b_total_rise_start = mucNuocB;
            console.log(`📊 Khởi tạo tổng mức tăng từ: ${mucNuocB} cm`);
        }
        const b_total_rise = mucNuocB - appState.b_total_rise_start;

        const currentSensorData = { mucNuocB, luuLuong, timestamp: currentTime };

        // 3. CẢNH BÁO THÔNG MINH - 3 MỨC ĐỘ
        console.log(`📊 [DEBUG] Tốc độ dâng: ${b_rate_of_change.toFixed(3)} cm/s, Tăng tuyệt đối: ${absoluteRise.toFixed(1)} cm, Mực nước B: ${mucNuocB} cm, Tổng tăng: ${b_total_rise.toFixed(1)} cm`);

        const now = Date.now();
        
        // 🚨 CẢNH BÁO TỐC ĐỘ DÂNG NHANH
        if (b_rate_of_change > RAPID_RISE_THRESHOLD) {
            const canSendAgain = !appState.rapidRiseNotificationTime || 
                (now - appState.rapidRiseNotificationTime) > (10 * 60 * 1000); // 10 phút cooldown
            
            if (!appState.sentRapidRiseNotification || canSendAgain) {
                console.warn(`🌊 NƯỚC DÂNG NHANH! Tốc độ: ${b_rate_of_change.toFixed(2)} cm/s (Vượt ngưỡng ${RAPID_RISE_THRESHOLD} cm/s)`);
                await sendRapidRiseNotification(b_rate_of_change);
                appState.sentRapidRiseNotification = true;
                appState.rapidRiseNotificationTime = now;
                console.log("✅ ĐÃ GỬI CẢNH BÁO DÂNG NHANH");
            }
        } 
        
        // 📈 CẢNH BÁO TĂNG TUYỆT ĐỐI MẠNH
        if (absoluteRise > ABSOLUTE_RISE_THRESHOLD) {
            const canSendAbsoluteAlert = !appState.lastAbsoluteRiseAlert.time || 
                (now - appState.lastAbsoluteRiseAlert.time) > (15 * 60 * 1000) || // 15 phút cooldown
                Math.abs(absoluteRise - appState.lastAbsoluteRiseAlert.value) > 2; // Hoặc tăng khác biệt > 2cm
            
            if (canSendAbsoluteAlert) {
                console.warn(`📈 MỰC NƯỚC TĂNG MẠNH! Tăng: ${absoluteRise.toFixed(1)} cm (Vượt ngưỡng ${ABSOLUTE_RISE_THRESHOLD} cm)`);
                await sendAbsoluteRiseNotification(absoluteRise);
                appState.lastAbsoluteRiseAlert = { value: absoluteRise, time: now };
                console.log("✅ ĐÃ GỬI CẢNH BÁO TĂNG MẠNH");
            }
        }

        // 💧 CẢNH BÁO MỰC NƯỚC CAO
        if (mucNuocB > HIGH_WATER_LEVEL_THRESHOLD) {
            const canSendHighWaterAlert = !appState.lastHighWaterAlert.time || 
                (now - appState.lastHighWaterAlert.time) > (20 * 60 * 1000) || // 20 phút cooldown
                Math.abs(mucNuocB - appState.lastHighWaterAlert.value) > 3; // Hoặc thay đổi > 3cm
            
            if (canSendHighWaterAlert) {
                console.warn(`💧 MỰC NƯỚC CAO! Mực nước B: ${mucNuocB} cm (Vượt ngưỡng ${HIGH_WATER_LEVEL_THRESHOLD} cm)`);
                await sendHighWaterNotification(mucNuocB);
                appState.lastHighWaterAlert = { value: mucNuocB, time: now };
                console.log("✅ ĐÃ GỬI CẢNH BÁO MỰC NƯỚC CAO");
            }
        }
        
        // 🔄 RESET KHI TỐC ĐỘ GIẢM
        if (b_rate_of_change <= RAPID_RISE_THRESHOLD * 0.3) {
            if (appState.sentRapidRiseNotification) {
                console.info("💧 Tốc độ dâng nước đã giảm, cho phép gửi cảnh báo mới khi cần");
                appState.sentRapidRiseNotification = false;
            }
        }

 
        // ==========================================
        // 4. GỌI AI NÂNG CAO (ĐÃ BỎ CHECK LOCAL - LUÔN LUÔN GỌI)
        // ==========================================
        try {
            // TÍNH TOÁN CÁC FEATURES NGUỒN MÀ AI CẦN
            const ab_diff = mucNuocB - mucNuocA;
            
            // LƯU Ý: Không cần tính ab_ratio, danger_index ở đây.
            // Python API (model_api.py) sẽ tự tính 2 features đó
            // để đảm bảo tính nhất quán (tránh Training-Serving Skew).

            // 🎯 Payload CHUẨN (8 features) khớp với model_api.py
            // Đây là 8 features "nguồn" mà model_api.py dùng hàm .get()
            // để lấy về, sau đó nó tự tính 2 features còn lại 
            // (ab_ratio, danger_index) để tạo ra đủ 10 features cho model.
            const ai_payload = { 
                mucNuocA, 
                mucNuocB, 
                luuLuong, 
                is_raining_now: isRaining ? 1 : 0, 
                b_rate_of_change, 
                flow_rate_of_change, 
                ab_diff,
                b_absolute_change
                // ĐÃ LOẠI BỎ: b_total_rise, b_trend (gây lỗi skew)
                // ĐÃ LOẠI BỎ: ab_ratio, danger_index (Python tự tính)
            };

            // Cập nhật log cho chính xác
            console.log(`🧠 [AI API-Safe] Gửi 8 features (nguồn) đến AI...`);
            
            const [statusRes, timeRes] = await Promise.all([
                axios.post(`${PYTHON_SERVER_URL}/predict`, ai_payload, { timeout: 8000 }),
                axios.post(`${PYTHON_SERVER_URL}/predict_time`, ai_payload, { timeout: 8000 })
            ]);
            
            // Lấy kết quả dự đoán
            duDoanTrangThai = statusRes?.data?.prediction || duDoanTrangThai;
            duDoanThoiGian = parseFloat(timeRes?.data?.predicted_seconds) || -1;
            
            // HIỂN THỊ PHÂN TÍCH NGUY HIỂM CHI TIẾT
            const dangerAnalysis = statusRes?.data?.danger_analysis;
            if (dangerAnalysis) {
                console.log(`🔍 [AI Analysis] Mực nước: ${dangerAnalysis.mucnuocb_level}, Tốc độ: ${dangerAnalysis.rate_of_change_level}, Thay đổi: ${dangerAnalysis.absolute_change_level}, Chỉ số: ${dangerAnalysis.danger_index.toFixed(1)}`);
            }
            
            console.log(`[🧠 AI API-Safe Status]: ${duDoanTrangThai}, Countdown: ${duDoanThoiGian >= 0 ? duDoanThoiGian.toFixed(2) + 's' : 'N/A'}`);
        
        } catch (ai_err) {
            console.error("❌ Lỗi gọi API dự đoán NÂNG CAO (Python):", ai_err && ai_err.message ? ai_err.message : ai_err);
            // Vẫn tiếp tục dù AI lỗi, duDoanTrangThai sẽ là "Lỗi dự đoán"
        }

        // ==========================================
        // 5. GỬI THÔNG BÁO AI (ĐÃ BỎ CHECK LOCAL - LUÔN LUÔN GỬI)
        // ==========================================
        if (shouldSendAIStatusNotification(appState.lastSentAIStatus, duDoanTrangThai)) {
            await sendAIStatusNotification(duDoanTrangThai, duDoanThoiGian);
            appState.lastSentAIStatus = duDoanTrangThai;
            // Reset bộ đếm thời gian cảnh báo nguy hiểm nếu trạng thái về bình thường
            if (duDoanTrangThai !== "Nguy hiểm!") appState.lastDangerAlertTime = null;
        }
        
        // CẢNH BÁO NGUY HIỂM ĐỊNH KỲ (Lặp lại sau mỗi 2 phút nếu vẫn nguy hiểm)
        if (duDoanTrangThai === "Nguy hiểm!" && appState.fcmTokens.length > 0) {
            const now = Date.now();
            if (!appState.lastDangerAlertTime || (now - appState.lastDangerAlertTime) > 2 * 60 * 1000) { // 2 phút
                console.log("🔄 Gửi cảnh báo định kỳ NGUY HIỂM");
                await sendAIStatusNotification(duDoanTrangThai, duDoanThoiGian);
                appState.lastDangerAlertTime = now;
            }
        }

        // ==========================================
        // === 7. LƯU DỮ LIỆU VÀO DB (Gửi 2 nơi)
        // ==========================================
        // ... (Phần còn lại của hàm giữ nguyên) ...

        // 5. Gửi thông báo AI (CHỈ KHI CHẠY LOCAL)
        if (!process.env.DATABASE_URL) {
            if (shouldSendAIStatusNotification(appState.lastSentAIStatus, duDoanTrangThai)) {
                await sendAIStatusNotification(duDoanTrangThai, duDoanThoiGian);
                appState.lastSentAIStatus = duDoanTrangThai;
                if (duDoanTrangThai !== "Nguy hiểm!") appState.lastDangerAlertTime = null;
            }
            
            // CẢNH BÁO NGUY HIỂM ĐỊNH KỲ
            if (duDoanTrangThai === "Nguy hiểm!" && appState.fcmTokens.length > 0) {
                const now = Date.now();
                if (!appState.lastDangerAlertTime || (now - appState.lastDangerAlertTime) > 2 * 60 * 1000) {
                    console.log("🔄 Gửi cảnh báo định kỳ NGUY HIỂM");
                    await sendAIStatusNotification(duDoanTrangThai, duDoanThoiGian);
                    appState.lastDangerAlertTime = now;
                }
            }
        }

        // ==========================================
        // === 7. LƯU DỮ LIỆU VÀO DB (Gửi 2 nơi)
        // ==========================================
        const sql = `INSERT INTO sensor_data 
            (mucNuocA, mucNuocB, luuLuong, trangThai, thongBao, created_at, predicted_trangthai, time_until_a_danger, predicted_time_to_a, is_raining) 
            VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9) RETURNING id, created_at`;

        const values = [
            mucNuocA, mucNuocB, luuLuong,
            trangThaiSimulator, thongBaoSimulator,
            duDoanTrangThai,
            formatCountdown(typeof time_until_a_danger_simulator === 'number' ? time_until_a_danger_simulator : duDoanThoiGian),
            (typeof duDoanThoiGian === 'number' && !isNaN(duDoanThoiGian)) ? duDoanThoiGian : null,
            isRaining
        ];

        const dbTasks = [];
        const logMsg = `[DB Save]: A:${mucNuocA.toFixed(1)}, B:${mucNuocB.toFixed(1)}`;
        
        if (pool) {
            dbTasks.push(
                pool.query(sql, values)
                    .then((dbRes) => {
                        console.log(`[✓] ${process.env.DATABASE_URL ? '[Cloud]' : '[Local]'} ${logMsg}`);
                    })
                    .catch(err => console.error(`❌ Lỗi ${process.env.DATABASE_URL ? '[Cloud]' : '[Local]'} DB Save:`, err.message))
            );
        }

        // CHỈ KHI CHẠY LOCAL (Trạm trung chuyển)
        if (railwayPool) {
            dbTasks.push(
                railwayPool.query(sql, values)
                    .then(() => console.log(`[✓] [Sync->Cloud] ${logMsg}`))
                    .catch(err => console.error("❌ Lỗi [Sync->Cloud] DB Save:", err.message))
            );
        }

        await Promise.all(dbTasks);

        // 8. Cập nhật trạng thái
        appState.lastSensorData = currentSensorData;

        // 9. Phản hồi
        res.status(200).json({
            message: 'Đã lưu và dự đoán thành công.',
            prediction_status: duDoanTrangThai,
            prediction_time: duDoanThoiGian,
            alerts_sent: {
                rapid_rise: appState.sentRapidRiseNotification,
                absolute_rise: appState.lastAbsoluteRiseAlert.value !== null,
                high_water: appState.lastHighWaterAlert.value !== null
            }
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
// ... bên trong file server.js

// [SỬA LẠI TRONG server.js]

// [SỬA LẠI TRONG server.js]

app.get('/api/history_by_date', async (req, res) => {
    const { date } = req.query; // Ví dụ: "2025-11-15"
    
    if (!date) {
        return res.status(400).json({ error: 'Thiếu tham số ngày (date)' });
    }

    try {
        // ✅ SỬA Ở ĐÂY:
        // Đổi "timestamp" thành "created_at" (đúng với CSDL của bạn)
        const sql = `
            SELECT * FROM sensor_data 
            WHERE DATE(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = $1 
            ORDER BY created_at ASC
        `;
        
        const result = await pool.query(sql, [date]);
        res.json(result.rows || []);

    } catch (err) {
        console.error("❌ /api/history_by_date error:", err.message);
        res.status(500).json({ error: 'Lỗi server khi lấy lịch sử' });
    }
});
// API /upload
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    res.json({ filename: req.file.filename, originalname: req.file.originalname });
});

// --------------- START SERVER ----------------
app.listen(SERVER_PORT, () => {
    console.log(`🚀 Server Node.js NÂNG CAO đang chạy tại cổng: ${SERVER_PORT}`);
    console.log(`🧠 Kết nối tới AI Python NÂNG CAO: ${PYTHON_SERVER_URL}`);
    console.log("📱 Sẵn sàng nhận FCM token từ client.");
    console.log("🎯 Hệ thống cảnh báo 3 cấp độ:");
    console.log(`   🌊 Tốc độ dâng: > ${RAPID_RISE_THRESHOLD} cm/s`);
    console.log(`   📈 Tăng tuyệt đối: > ${ABSOLUTE_RISE_THRESHOLD} cm`);
    console.log(`   💧 Mực nước cao: > ${HIGH_WATER_LEVEL_THRESHOLD} cm`);
    
    // (CHỈ CHẠY TRÊN LOCAL: Bắt đầu đồng bộ token)
    if (railwayPool) {
        console.log(`🔄 [FCM Mailbox] Bắt đầu đồng bộ token mỗi ${TOKEN_SYNC_INTERVAL / 1000} giây...`);
        syncTokenFromCloudDB(); // Chạy 1 lần ngay
        setInterval(syncTokenFromCloudDB, TOKEN_SYNC_INTERVAL); // Chạy lặp lại
    }
});