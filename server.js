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
require('dotenv').config();
const admin = require('firebase-admin');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// =============================
// CẤU HÌNH HỆ THỐNG - TẬP TRUNG THƯỢNG NGUỒN
// =============================
const SERVER_PORT = process.env.PORT || 3000;
const PYTHON_SERVER_URL = process.env.PYTHON_SERVER_URL || "http://localhost:5001";

// NGƯỠNG CẢNH BÁO CHO THƯỢNG NGUỒN (ĐIỂM B)
const RAPID_RISE_THRESHOLD = 0.1;    // Tốc độ dâng bất thường: 0.1 cm/s
const DANGER_RISE_THRESHOLD = 0.25;  // Tốc độ dâng nguy hiểm: 0.25 cm/s  
const CRITICAL_LEVEL_B = 28.0;       // Mực nước B nguy hiểm: 28cm
const WARNING_LEVEL_B = 25.0;        // Mực nước B cảnh báo: 25cm

const TOKEN_SYNC_INTERVAL = 30000;

// =============================
// KHỞI TẠO CSDL (DATABASE)
// =============================
let pool;
let railwayPool;

try {
    if (process.env.DATABASE_URL) {
        console.log("✅ [DB Config] Đang kết nối CSDL Cloud (sử dụng DATABASE_URL)...");
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
        railwayPool = null;
    } else {
        console.log("⚠️ [DB Config] Đang kết nối CSDL Local (sử dụng DB_CONFIG)...");
        const DB_CONFIG = {
            user: process.env.DB_USER || 'postgres',
            host: process.env.DB_HOST || 'localhost',
            database: process.env.DB_NAME || 'flood_alert_db',
            password: process.env.DB_PASS || 'Quan@',
            port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
        };
        pool = new Pool(DB_CONFIG);

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
// TRẠNG THÁI MÁY CHỦ (State) - TẬP TRUNG THƯỢNG NGUỒN
// =============================
const appState = {
    fcmTokens: [],
    lastSensorData: { 
        mucNuocA: null, 
        mucNuocB: null, 
        luuLuong: null, 
        timestamp: null 
    },
    lastSentAIStatus: "Bình thường",
    
    // TRẠNG THÁI CẢNH BÁO THƯỢNG NGUỒN
    sentRapidRiseNotification: false,
    lastRiseAlertTime: null,
    lastRiseRate: 0,
    consecutiveRiseCount: 0,
    
    // TRẠNG THÁI MỰC NƯỚC CAO
    sentHighWaterNotification: false,
    lastHighWaterAlertTime: null,
    
    lastDangerAlertTime: null
};

// =============================
// KHỞI TẠO ỨNG DỤNG
// =============================
const app = express();
app.use(express.json());
app.use(cors());
const upload = multer({ dest: path.join(__dirname, 'uploads/') });

// =============================
// HÀM HỖ TRỢ (Helpers) - CẢI TIẾN CHO THƯỢNG NGUỒN
// =============================
function formatCountdown(seconds) {
    if (seconds === null || seconds === undefined || isNaN(seconds) || seconds < 0) return null;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    return (minutes > 0) ? `${minutes} phút ${remainingSeconds} giây` : `${remainingSeconds} giây`;
}

function getNotificationTitle(status) {
    const titleMap = {
        "Bình thường": "✅ Tình hình ổn định", 
        "Cảnh báo!": "⚠️ Cảnh báo Lũ từ thượng nguồn",
        "Cảnh báo Cao!": "🔶 Cảnh báo Lũ Cao từ thượng nguồn", 
        "Nguy hiểm!": "🚨 BÁO ĐỘNG NGUY HIỂM từ thượng nguồn"
    };
    return titleMap[status] || `Cảnh báo: ${status}`;
}

function getNotificationBody(status, countdown, mucNuocB = null) {
    const baseMessages = {
        "Bình thường": "Tình hình lũ hiện tại ổn định. Tiếp tục theo dõi.",
        "Cảnh báo!": "Mực nước thượng nguồn đang tăng. Chuẩn bị sẵn sàng các biện pháp phòng ngừa.",
        "Cảnh báo Cao!": "Mực nước thượng nguồn đang tăng nhanh. Sẵn sàng sơ tán nếu cần thiết.",
        "Nguy hiểm!": "LŨ TỪ THƯỢNG NGUỒN ĐANG Ở MỨC NGUY HIỂM! CẦN SƠ TÁN NGAY LẬP TỨC!"
    };
    
    let body = baseMessages[status] || `Trạng thái: ${status}`;
    
    // THÊM THÔNG TIN MỰC NƯỚC THƯỢNG NGUỒN
    if (mucNuocB !== null) {
        body += ` Mực nước thượng nguồn: ${mucNuocB.toFixed(1)}cm.`;
    }
    
    const formattedTime = formatCountdown(countdown);
    if (formattedTime && status !== "Bình thường") {
        body += ` Lũ dự kiến đến hạ lưu sau khoảng ${formattedTime}.`;
        if (countdown < 300) body += " HÃY DI CHUYỂN ĐẾN NƠI AN TOÀN NGAY!";
    }
    
    return body;
}

function shouldSendAIStatusNotification(lastStatus, currentStatus) {
    if (!appState.fcmTokens || appState.fcmTokens.length === 0) { 
        console.log("📱 Chưa có FCM token, bỏ qua thông báo!"); 
        return false; 
    }
    if (lastStatus !== currentStatus) { 
        console.log(`🔄 Thay đổi trạng thái AI: ${lastStatus} -> ${currentStatus}`); 
        return true; 
    }
    return false;
}

// =============================
// HÀM GỬI THÔNG BÁO PUSH - TẬP TRUNG THƯỢNG NGUỒN
// =============================
async function sendPushNotificationInternal(title, body) {
    if (!admin.apps.length) { 
        console.error("❌ Firebase Admin chưa khởi tạo."); 
        return false; 
    }
    if (!appState.fcmTokens || appState.fcmTokens.length === 0) { 
        console.warn("sendPushNotificationInternal: Bỏ qua vì danh sách fcmTokens rỗng."); 
        return false; 
    }
    
    const message = {
        notification: { title: title, body: body }, 
        tokens: appState.fcmTokens,
        android: { 
            priority: 'high', 
            notification: { 
                sound: 'default', 
                channelId: 'FloodWarningChannel', 
                icon: 'ic_warning', 
                color: '#FF0000' 
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

// HÀM CẢNH BÁO DÂNG NHANH THƯỢNG NGUỒN
async function sendRapidRiseNotification(rate, level, mucNuocB) {
    const titleMap = {
        "CẢNH BÁO": "🌊 Cảnh báo: Nước Thượng Nguồn Đang Dâng!",
        "NGUY HIỂM": "🚨 NGUY HIỂM: Nước Thượng Nguồn Dâng Rất Nhanh!"
    };
    
    const bodyMap = {
        "CẢNH BÁO": `Mực nước thượng nguồn đang dâng (${rate.toFixed(2)} cm/s). Mực nước: ${mucNuocB.toFixed(1)}cm. Theo dõi sát!`,
        "NGUY HIỂM": `Mực nước thượng nguồn đang dâng RẤT NHANH (${rate.toFixed(2)} cm/s). Mực nước: ${mucNuocB.toFixed(1)}cm. NGUY CƠ LŨ LỤT CAO!`
    };
    
    const title = titleMap[level] || "🌊 Cảnh báo thượng nguồn";
    const body = bodyMap[level] || `Tốc độ dâng: ${rate.toFixed(2)} cm/s, Mực nước: ${mucNuocB.toFixed(1)}cm`;
    
    console.log(`📤 Gửi cảnh báo dâng nhanh thượng nguồn: ${level} - ${rate.toFixed(3)} cm/s`);
    await sendPushNotificationInternal(title, body);
}

// HÀM CẢNH BÁO MỰC NƯỚC CAO THƯỢNG NGUỒN
async function sendHighWaterNotification(mucNuocB, level) {
    const title = `🌧️ ${level}: Mực Nước Thượng Nguồn Cao!`;
    const body = `Mực nước thượng nguồn: ${mucNuocB.toFixed(1)}cm. ${level === "NGUY HIỂM" ? "NGUY CƠ LŨ LỤT RẤT CAO!" : "Theo dõi sát tình hình!"}`;
    
    console.log(`📤 Gửi cảnh báo mực nước cao thượng nguồn: ${level} - ${mucNuocB.toFixed(1)}cm`);
    await sendPushNotificationInternal(title, body);
}

async function sendAIStatusNotification(status, countdown, mucNuocB = null) {
    const title = getNotificationTitle(status); 
    const body = getNotificationBody(status, countdown, mucNuocB);
    console.log(`📤 Chuẩn bị gửi thông báo AI: ${status}`);
    await sendPushNotificationInternal(title, body);
}

// =============================
// KHỞI TẠO BẢNG CSDL
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
// ĐỒNG BỘ TOKEN
// =============================
async function syncTokenFromCloudDB() {
    if (!railwayPool) return;
    
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

app.post('/api/register_fcm_token', async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ error: 'Missing token' });

        if (pool) {
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

// =============================
// ROUTE CHÍNH: XỬ LÝ DỮ LIỆU THƯỢNG NGUỒN
// =============================
app.post('/update', async (req, res) => {
    let duDoanTrangThai = "Lỗi dự đoán";
    let duDoanThoiGian = -1;
    let b_rate_of_change = 0;
    let flow_rate_of_change = 0;
    let currentTime;
    
    try {
        const body = req.body || {};
        const { mucNuocA: mA, mucNuocB: mB, luuLuong: lL, isRaining: iR, trangThai: tS, thongBao: tBS, time_until_a_danger: tUAD } = body;

        const mucNuocA = parseFloat(mA); 
        const mucNuocB = parseFloat(mB); 
        const luuLuong = parseFloat(lL);
        const isRaining = iR === true || iR === 'true';
        const trangThaiSimulator = tS || '';
        const thongBaoSimulator = tBS || ''; 
        const time_until_a_danger_simulator = tUAD;

        if (isNaN(mucNuocA) || isNaN(mucNuocB) || isNaN(luuLuong) || typeof body.isRaining === 'undefined') {
            console.warn("⚠️ Yêu cầu /update thiếu dữ liệu.");
            return res.status(400).json({ error: 'Thiếu dữ liệu hoặc sai định dạng' });
        }

        currentTime = Date.now();

        // TÍNH TỐC ĐỘ THAY ĐỔI MỰC NƯỚC THƯỢNG NGUỒN (B)
        if (appState.lastSensorData.timestamp !== null && appState.lastSensorData.mucNuocB !== null) {
            const timeDiffSeconds = (currentTime - appState.lastSensorData.timestamp) / 1000;
            if (timeDiffSeconds > 0) {
                const lastB = appState.lastSensorData.mucNuocB;
                const lastFlow = appState.lastSensorData.luuLuong !== null ? appState.lastSensorData.luuLuong : luuLuong;
                b_rate_of_change = (mucNuocB - lastB) / timeDiffSeconds;
                flow_rate_of_change = (luuLuong - lastFlow) / timeDiffSeconds;
            }
        }

        const currentSensorData = { 
            mucNuocA, 
            mucNuocB, 
            luuLuong, 
            timestamp: currentTime 
        };

        // ==========================================
        // CẢNH BÁO THƯỢNG NGUỒN - TRỌNG TÂM CHÍNH
        // ==========================================
        if (!process.env.DATABASE_URL) {
            console.log(`📊 [THƯỢNG NGUỒN] Mực nước B: ${mucNuocB.toFixed(2)}cm, Tốc độ: ${b_rate_of_change.toFixed(4)}cm/s`);
            
            const now = Date.now();
            
            // 1. CẢNH BÁO DÂNG NHANH THƯỢNG NGUỒN
            if (b_rate_of_change > RAPID_RISE_THRESHOLD) {
                const timeSinceLastAlert = appState.lastRiseAlertTime ? (now - appState.lastRiseAlertTime) : Infinity;
                
                // PHÂN LOẠI MỨC ĐỘ DÂNG NHANH
                let warningLevel = "CẢNH BÁO";
                if (b_rate_of_change > DANGER_RISE_THRESHOLD) {
                    warningLevel = "NGUY HIỂM";
                }
                
                // CHỈ GỬI KHI CẦN THIẾT
                const shouldSendAlert = 
                    !appState.sentRapidRiseNotification || 
                    timeSinceLastAlert > 2 * 60 * 1000 ||
                    (warningLevel === "NGUY HIỂM" && appState.lastRiseRate <= DANGER_RISE_THRESHOLD);
                
                if (shouldSendAlert) {
                    console.log(`🚨 [DÂNG NHANH] Thượng nguồn ${warningLevel}! Tốc độ: ${b_rate_of_change.toFixed(3)}cm/s`);
                    
                    await sendRapidRiseNotification(b_rate_of_change, warningLevel, mucNuocB);
                    appState.sentRapidRiseNotification = true;
                    appState.lastRiseAlertTime = now;
                    appState.consecutiveRiseCount++;
                }
                
                appState.lastRiseRate = b_rate_of_change;
                
            } else if (b_rate_of_change <= 0.02) {
                // RESET KHI NƯỚC ỔN ĐỊNH
                if (appState.sentRapidRiseNotification) {
                    console.info("💧 Mực nước thượng nguồn đã ổn định.");
                    appState.sentRapidRiseNotification = false;
                    appState.consecutiveRiseCount = 0;
                }
                appState.lastRiseRate = 0;
            }

            // 2. CẢNH BÁO MỰC NƯỚC CAO THƯỢNG NGUỒN
            if (mucNuocB >= CRITICAL_LEVEL_B) {
                const timeSinceLastAlert = appState.lastHighWaterAlertTime ? (now - appState.lastHighWaterAlertTime) : Infinity;
                
                if (!appState.sentHighWaterNotification || timeSinceLastAlert > 5 * 60 * 1000) {
                    console.log(`🌧️ [MỰC NƯỚC CAO] Thượng nguồn NGUY HIỂM: ${mucNuocB.toFixed(1)}cm`);
                    await sendHighWaterNotification(mucNuocB, "NGUY HIỂM");
                    appState.sentHighWaterNotification = true;
                    appState.lastHighWaterAlertTime = now;
                }
            } else if (mucNuocB >= WARNING_LEVEL_B) {
                const timeSinceLastAlert = appState.lastHighWaterAlertTime ? (now - appState.lastHighWaterAlertTime) : Infinity;
                
                if (!appState.sentHighWaterNotification || timeSinceLastAlert > 10 * 60 * 1000) {
                    console.log(`🌧️ [MỰC NƯỚC CAO] Thượng nguồn CẢNH BÁO: ${mucNuocB.toFixed(1)}cm`);
                    await sendHighWaterNotification(mucNuocB, "CẢNH BÁO");
                    appState.sentHighWaterNotification = true;
                    appState.lastHighWaterAlertTime = now;
                }
            } else if (mucNuocB < WARNING_LEVEL_B - 2) {
                // RESET KHI MỰC NƯỚC GIẢM XUỐNG AN TOÀN
                if (appState.sentHighWaterNotification) {
                    console.info("✅ Mực nước thượng nguồn đã trở về mức an toàn.");
                    appState.sentHighWaterNotification = false;
                }
            }
        }

        // 3. GỌI AI DỰ ĐOÁN (DỰA TRÊN THƯỢNG NGUỒN)
        if (!process.env.DATABASE_URL) {
            try {
                const ai_payload = { 
                    mucNuocA, 
                    mucNuocB, 
                    luuLuong, 
                    is_raining_now: isRaining ? 1 : 0, 
                    b_rate_of_change, 
                    flow_rate_of_change, 
                    ab_diff: mucNuocB - mucNuocA 
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

        // 4. GỬI THÔNG BÁO AI (TẬP TRUNG THƯỢNG NGUỒN)
        if (!process.env.DATABASE_URL) {
            if (shouldSendAIStatusNotification(appState.lastSentAIStatus, duDoanTrangThai)) {
                await sendAIStatusNotification(duDoanTrangThai, duDoanThoiGian, mucNuocB);
                appState.lastSentAIStatus = duDoanTrangThai;
                if (duDoanTrangThai !== "Nguy hiểm!") appState.lastDangerAlertTime = null;
            }
            
            // CẢNH BÁO ĐỊNH KỲ KHI NGUY HIỂM
            if (duDoanTrangThai === "Nguy hiểm!" && appState.fcmTokens.length > 0) {
                const now = Date.now();
                if (!appState.lastDangerAlertTime || (now - appState.lastDangerAlertTime) > 3 * 60 * 1000) {
                    console.log("🔄 Gửi cảnh báo định kỳ NGUY HIỂM từ thượng nguồn");
                    await sendAIStatusNotification(duDoanTrangThai, duDoanThoiGian, mucNuocB);
                    appState.lastDangerAlertTime = now;
                }
            }
        }

        // ==========================================
        // LƯU DỮ LIỆU VÀO DB
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
        const logMsg = `[DB Save]: Thượng nguồn(B):${mucNuocB.toFixed(1)}cm, Tốc độ:${b_rate_of_change.toFixed(3)}cm/s`;
        
        if (pool) {
            dbTasks.push(
                pool.query(sql, values)
                    .then((dbRes) => {
                        console.log(`[✓] ${process.env.DATABASE_URL ? '[Cloud]' : '[Local]'} ${logMsg}`);
                    })
                    .catch(err => console.error(`❌ Lỗi ${process.env.DATABASE_URL ? '[Cloud]' : '[Local]'} DB Save:`, err.message))
            );
        }

        if (railwayPool) {
            dbTasks.push(
                railwayPool.query(sql, values)
                    .then(() => console.log(`[✓] [Sync->Cloud] ${logMsg}`))
                    .catch(err => console.error("❌ Lỗi [Sync->Cloud] DB Save:", err.message))
            );
        }

        await Promise.all(dbTasks);

        // CẬP NHẬT TRẠNG THÁI
        appState.lastSensorData = currentSensorData;

        // PHẢN HỒI
        res.status(200).json({
            message: 'Đã lưu và dự đoán thành công.',
            prediction_status: duDoanTrangThai,
            prediction_time: duDoanThoiGian,
            thượng_nguồn: {
                mực_nước: mucNuocB,
                tốc_độ_dâng: b_rate_of_change
            }
        });

    } catch (err) {
        console.error("❌ Lỗi /update:", err && err.message ? err.message : err);
        if (currentTime) {
            const body = req.body || {};
            appState.lastSensorData = {
                mucNuocA: parseFloat(body.mucNuocA) || appState.lastSensorData.mucNuocA || 0,
                mucNuocB: parseFloat(body.mucNuocB) || appState.lastSensorData.mucNuocB || 0,
                luuLuong: parseFloat(body.luuLuong) || appState.lastSensorData.luuLuong || 0,
                timestamp: currentTime
            };
        }
        res.status(500).json({ error: 'Lỗi server khi xử lý dữ liệu', details: err && err.message ? err.message : err });
    }
});

// CÁC ENDPOINTS KHÁC GIỮ NGUYÊN...
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

app.get('/api/history_by_date', async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'CSDL chưa sẵn sàng' });
    try {
        const { date } = req.query;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'Thiếu hoặc sai định dạng tham số ngày (YYYY-MM-DD)' });
        }
        const sql = `SELECT * FROM sensor_data WHERE (created_at AT TIME ZONE '+07')::date = $1 ORDER BY id DESC;`;
        const result = await pool.query(sql, [date]);
        res.json(result.rows || []);
    } catch (err) {
        console.error("❌ /api/history_by_date error:", err && err.message ? err.message : err);
        res.status(500).json({ error: 'Lỗi server khi lấy lịch sử' });
    }
});

app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    res.json({ filename: req.file.filename, originalname: req.file.originalname });
});

// --------------- START SERVER ----------------
app.listen(SERVER_PORT, () => {
    console.log(`🚀 Server Node.js đang chạy tại cổng: ${SERVER_PORT}`);
    console.log(`🧠 Kết nối tới AI Python: ${PYTHON_SERVER_URL}`);
    console.log("📱 Sẵn sàng nhận FCM token từ client.");
    console.log(`🌊 HỆ THỐNG CẢNH BÁO THƯỢNG NGUỒN:`);
    console.log(`   📈 Ngưỡng dâng nhanh: ${RAPID_RISE_THRESHOLD} cm/s`);
    console.log(`   🚨 Ngưỡng dâng nguy hiểm: ${DANGER_RISE_THRESHOLD} cm/s`);
    console.log(`   ⚠️ Mực nước cảnh báo: ${WARNING_LEVEL_B} cm`);
    console.log(`   🚨 Mực nước nguy hiểm: ${CRITICAL_LEVEL_B} cm`);
    
    if (railwayPool) {
        console.log(`🔄 [FCM Mailbox] Bắt đầu đồng bộ token mỗi ${TOKEN_SYNC_INTERVAL / 1000} giây...`);
        syncTokenFromCloudDB();
        setInterval(syncTokenFromCloudDB, TOKEN_SYNC_INTERVAL);
    }
});