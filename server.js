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
const RAPID_RISE_THRESHOLD = 0.3; // cm/giây
const ABSOLUTE_RISE_THRESHOLD = 3; // cm
const HIGH_WATER_LEVEL_THRESHOLD = 12; // cm
const TOKEN_SYNC_INTERVAL = 30000; // 30 giây

// =============================
// KHỞI TẠO CSDL (DATABASE)
// =============================
let pool; // Đây là CSDL chính (Local hoặc Cloud)
let railwayPool; // Đây là CSDL Cloud (dùng cho trạm trung chuyển nếu local)

async function initializeDatabase() {
    try {
        if (process.env.DATABASE_URL) {
            // MÔI TRƯỜNG CLOUD (RAILWAY)
            console.log("✅ [DB Config] Đang kết nối CSDL Cloud (sử dụng DATABASE_URL)...");
            pool = new Pool({
                connectionString: process.env.DATABASE_URL,
                ssl: { rejectUnauthorized: false }
            });
            await pool.query('SELECT 1'); // Test kết nối
            console.log("✅ [DB] Kết nối Cloud thành công.");
            railwayPool = null; // Không cần trên cloud
        } else {
            // MÔI TRƯỜNG LOCAL
            console.log("⚠️ [DB Config] Đang kết nối CSDL Local...");
            const DB_CONFIG = {
                user: process.env.DB_USER || 'postgres',
                host: process.env.DB_HOST || 'localhost',
                database: process.env.DB_NAME || 'flood_alert_db',
                password: process.env.DB_PASS || 'Quan@',
                port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
            };
            pool = new Pool(DB_CONFIG);
            await pool.query('SELECT 1'); // Test kết nối
            console.log("✅ [DB] Kết nối Local thành công.");

            // Trạm trung chuyển cho Cloud
            if (process.env.RAILWAY_DB_URL) {
                railwayPool = new Pool({
                    connectionString: process.env.RAILWAY_DB_URL,
                    ssl: { rejectUnauthorized: false }
                });
                await railwayPool.query('SELECT 1');
                console.log("✅ [DB Sync] Đã kết nối CSDL Cloud (Railway).");
            } else {
                console.warn("⚠️ [DB Sync] Không tìm thấy RAILWAY_DB_URL.");
                railwayPool = null;
            }
        }
    } catch (dbErr) {
        console.error("❌ LỖI NGHIÊM TRỌNG KHI KHỞI TẠO CSDL:", dbErr.message);
        process.exit(1); // Dừng app nếu DB fail
    }
}

// =============================
// KHỞI TẠO FIREBASE ADMIN
// =============================
function initializeFirebase() {
    try {
        if (process.env.SERVICE_ACCOUNT_JSON) {
            console.log("✅ [Firebase] Khởi tạo từ BIẾN MÔI TRƯỜNG (Cloud)...");
            const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            console.log("✅ Firebase Admin SDK đã khởi tạo (Cloud).");
        } else if (!process.env.DATABASE_URL) { // Chỉ local nếu không có env
            const localServicePath = path.join(__dirname, 'serviceAccountKey.json');
            if (fs.existsSync(localServicePath)) {
                console.log("⚠️ [Firebase] Khởi tạo từ file local...");
                const serviceAccount = require(localServicePath);
                admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
                console.log("✅ Firebase Admin SDK đã khởi tạo (Local).");
            } else {
                console.warn("⚠️ Firebase chưa khởi tạo: Không tìm thấy file local.");
            }
        } else {
            console.warn("⚠️ Firebase chưa khởi tạo: Không có SERVICE_ACCOUNT_JSON trên Cloud.");
        }
    } catch (error) {
        console.error("❌ LỖI KHỞI TẠO FIREBASE:", error.message);
    }
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
    lastHighWaterAlert: { value: null, time: null },
    lastDangerAlertTime: null,
    b_total_rise_start: null
};

// =============================
// KHỞI TẠO ỨNG DỤNG
// =============================
const app = express();
app.use(express.json());
app.use(cors());
const upload = multer({ dest: process.env.UPLOAD_DIR || path.join(__dirname, 'uploads/') }); // Sử dụng env cho volume nếu cần

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
        console.log("📱 Chưa có FCM token, bỏ qua thông báo!"); 
        return false; 
    }
    if (lastStatus !== currentStatus) { console.log(`🔄 Thay đổi trạng thái AI: ${lastStatus} -> ${currentStatus}`); return true; }
    return false;
}

// =============================
// HÀM GỬI THÔNG BÁO PUSH
// =============================
async function sendPushNotificationInternal(title, body) {
    if (!admin.apps.length) { console.error("❌ Firebase chưa khởi tạo."); return false; }
    if (!appState.fcmTokens.length) { 
        console.warn("Bỏ qua vì fcmTokens rỗng."); 
        return false; 
    }
    
    const message = {
        notification: { title, body }, 
        tokens: appState.fcmTokens,
        android: { priority: 'high', notification: { sound: 'default', channelId: 'FloodWarningChannel', icon: 'ic_warning', color: '#FF0000' } },
        apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default', alert: { title, body } } } }
    };
    
    try {
        const response = await admin.messaging().sendEachForMulticast(message);
        console.log(`✅ Gửi thành công: ${response.successCount}, Thất bại: ${response.failureCount}.`);
        
        if (response.failureCount > 0) {
            const tokensToDelete = [];
            response.responses.forEach((resp, idx) => {
                if (!resp.success && resp.error.code.includes('registration-token')) {
                    tokensToDelete.push(appState.fcmTokens[idx]);
                }
            });
            if (tokensToDelete.length && pool) {
                await pool.query("DELETE FROM fcm_tokens WHERE token = ANY($1::text[])", [tokensToDelete]);
                console.log(`🗑️ Xóa ${tokensToDelete.length} token hỏng.`);
            }
        }
        return true;
    } catch (error) {
        console.error(`❌ Lỗi gửi Push: ${error.message}`);
        return false;
    }
}
async function sendAIStatusNotification(status, countdown) {
    const title = getNotificationTitle(status); const body = getNotificationBody(status, countdown);
    await sendPushNotificationInternal(title, body);
}
async function sendRapidRiseNotification(rate) {
    const title = "🌊 Cảnh báo: Nước Dâng Nhanh!"; 
    const body = `Mực nước B dâng nhanh (${rate.toFixed(1)} cm/s). Theo dõi chặt chẽ!`;
    await sendPushNotificationInternal(title, body);
}
async function sendAbsoluteRiseNotification(absoluteRise) {
    const title = "📈 Cảnh báo: Mực nước Tăng Mạnh!"; 
    const body = `Mực nước B tăng ${absoluteRise.toFixed(1)} cm. Cảnh giác!`;
    await sendPushNotificationInternal(title, body);
}
async function sendHighWaterNotification(waterLevel) {
    const title = "💧 Cảnh báo: Mực nước Cao!"; 
    const body = `Mực nước B ở mức ${waterLevel.toFixed(1)} cm. Theo dõi sát!`;
    await sendPushNotificationInternal(title, body);
}

// =============================
// KHỞI TẠO BẢNG CSDL
// =============================
async function ensureTables(dbPool, dbType) {
    if (!dbPool) return;
    const createSensor = `
    CREATE TABLE IF NOT EXISTS sensor_data (
        id SERIAL PRIMARY KEY,
        mucNuocA REAL, mucNuocB REAL, luuLuong REAL,
        trangThai VARCHAR(255), thongBao TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        predicted_trangthai VARCHAR(255),
        time_until_a_danger VARCHAR(255),
        predicted_time_to_a REAL, 
        is_raining BOOLEAN
    );`;
    const createFcm = `
    CREATE TABLE IF NOT EXISTS fcm_tokens (
        id SERIAL PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );`;
    try {
        await dbPool.query(createSensor);
        await dbPool.query(createFcm);
        console.log(`✅ Bảng sẵn sàng (${dbType}).`);
    } catch (err) {
        console.error(`❌ Lỗi tạo bảng (${dbType}):`, err.message);
    }
}

// =============================
// ĐỒNG BỘ FCM TOKENS
// =============================
async function loadFcmTokens() {
    const db = railwayPool || pool;
    if (!db) return;
    try {
        const res = await db.query("SELECT token FROM fcm_tokens ORDER BY id DESC");
        appState.fcmTokens = res.rows.map(row => row.token);
        console.log(`🔄 Đồng bộ ${appState.fcmTokens.length} FCM tokens.`);
    } catch (err) {
        console.error("❌ Lỗi đồng bộ FCM:", err.message);
    }
}

// =============================
// API ENDPOINTS
// =============================
app.get('/', (req, res) => res.send({ status: 'OK', now: new Date().toISOString() }));

app.post('/api/register_fcm_token', async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ error: 'Missing token' });
        const db = pool; // Trên cloud dùng pool
        if (!db) return res.status(500).json({ error: 'DB not ready' });
        await db.query("INSERT INTO fcm_tokens (token) VALUES ($1) ON CONFLICT (token) DO NOTHING;", [token]);
        await loadFcmTokens(); // Đồng bộ ngay
        console.log(`✅ Lưu token: ${token.substring(0,10)}...`);
        res.json({ message: 'Token saved' });
    } catch (err) {
        console.error("❌ /register_fcm_token:", err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/update', async (req, res) => {
    let duDoanTrangThai = "Lỗi dự đoán";
    let duDoanThoiGian = -1;
    let b_rate_of_change = 0;
    let flow_rate_of_change = 0;
    let b_absolute_change = 0;
    let currentTime;
    
    try {
        const body = req.body || {};
        const { mucNuocA: mA, mucNuocB: mB, luuLuong: lL, isRaining: iR, trangThai: tS, thongBao: tBS, time_until_a_danger: tUAD } = body;

        const mucNuocA = parseFloat(mA); const mucNuocB = parseFloat(mB); const luuLuong = parseFloat(lL);
        const isRaining = iR === true || iR === 'true';
        const trangThaiSimulator = tS || '';
        const thongBaoSimulator = tBS || ''; const time_until_a_danger_simulator = tUAD;

        if (isNaN(mucNuocA) || isNaN(mucNuocB) || isNaN(luuLuong) || typeof body.isRaining === 'undefined') {
            return res.status(400).json({ error: 'Thiếu dữ liệu' });
        }

        currentTime = Date.now();

        // Tính tốc độ thay đổi
        let absoluteRise = 0;
        if (appState.lastSensorData.timestamp && appState.lastSensorData.mucNuocB !== null) {
            const timeDiffSeconds = (currentTime - appState.lastSensorData.timestamp) / 1000;
            if (timeDiffSeconds > 0) {
                const lastB = appState.lastSensorData.mucNuocB;
                const lastFlow = appState.lastSensorData.luuLuong ?? luuLuong;
                b_rate_of_change = (mucNuocB - lastB) / timeDiffSeconds;
                flow_rate_of_change = (luuLuong - lastFlow) / timeDiffSeconds;
                absoluteRise = mucNuocB - lastB;
                b_absolute_change = absoluteRise;
            }
        }

        if (appState.b_total_rise_start === null) {
            appState.b_total_rise_start = mucNuocB;
        }
        const b_total_rise = mucNuocB - appState.b_total_rise_start;

        appState.lastSensorData = { mucNuocB, luuLuong, timestamp: currentTime };

        console.log(`📊 Tốc độ dâng: ${b_rate_of_change.toFixed(3)} cm/s, Tăng tuyệt đối: ${absoluteRise.toFixed(1)} cm, Mực B: ${mucNuocB} cm, Tổng tăng: ${b_total_rise.toFixed(1)} cm`);

        const now = Date.now();
        
        // Cảnh báo dâng nhanh
        if (b_rate_of_change > RAPID_RISE_THRESHOLD) {
            const canSend = !appState.rapidRiseNotificationTime || (now - appState.rapidRiseNotificationTime) > 600000;
            if (canSend) {
                await sendRapidRiseNotification(b_rate_of_change);
                appState.rapidRiseNotificationTime = now;
                appState.sentRapidRiseNotification = true;
            }
        } 
        
        // Cảnh báo tăng mạnh
        if (absoluteRise > ABSOLUTE_RISE_THRESHOLD) {
            const canSend = !appState.lastAbsoluteRiseAlert.time || (now - appState.lastAbsoluteRiseAlert.time) > 900000 || Math.abs(absoluteRise - appState.lastAbsoluteRiseAlert.value) > 2;
            if (canSend) {
                await sendAbsoluteRiseNotification(absoluteRise);
                appState.lastAbsoluteRiseAlert = { value: absoluteRise, time: now };
            }
        }

        // Cảnh báo mực nước cao
        if (mucNuocB > HIGH_WATER_LEVEL_THRESHOLD) {
            const canSend = !appState.lastHighWaterAlert.time || (now - appState.lastHighWaterAlert.time) > 1200000 || Math.abs(mucNuocB - appState.lastHighWaterAlert.value) > 3;
            if (canSend) {
                await sendHighWaterNotification(mucNuocB);
                appState.lastHighWaterAlert = { value: mucNuocB, time: now };
            }
        }
        
        // Reset dâng nhanh
        if (b_rate_of_change <= RAPID_RISE_THRESHOLD * 0.3) {
            appState.sentRapidRiseNotification = false;
        }

        // Gọi AI (luôn gọi nếu có PYTHON_SERVER_URL)
        if (PYTHON_SERVER_URL) {
            try {
                const ab_diff = mucNuocB - mucNuocA;
                const ab_ratio = mucNuocB / (mucNuocA + 0.001);
                const danger_index = (mucNuocB * 0.3) + (Math.abs(b_rate_of_change) * 2.0) + (Math.abs(b_absolute_change) * 0.5) + (ab_diff * 0.2);
                const b_trend = mucNuocB;

                const ai_payload = { 
                    mucNuocA, mucNuocB, luuLuong, 
                    is_raining_now: isRaining ? 1 : 0, 
                    b_rate_of_change, 
                    flow_rate_of_change, 
                    ab_diff,
                    ab_ratio,
                    b_absolute_change,
                    b_total_rise,
                    danger_index,
                    b_trend
                };

                const [statusRes, timeRes] = await Promise.all([
                    axios.post(`${PYTHON_SERVER_URL}/predict`, ai_payload, { timeout: 8000 }),
                    axios.post(`${PYTHON_SERVER_URL}/predict_time`, ai_payload, { timeout: 8000 })
                ]);
                
                duDoanTrangThai = statusRes?.data?.prediction || duDoanTrangThai;
                duDoanThoiGian = parseFloat(timeRes?.data?.predicted_seconds) || -1;
                
                const dangerAnalysis = statusRes?.data?.danger_analysis;
                if (dangerAnalysis) {
                    console.log(`🔍 AI Analysis: Mực nước: ${dangerAnalysis.mucnuocb_level}, Tốc độ: ${dangerAnalysis.rate_of_change_level}, Thay đổi: ${dangerAnalysis.absolute_change_level}, Chỉ số: ${dangerAnalysis.danger_index.toFixed(1)}`);
                }
                
                console.log(`🧠 AI: ${duDoanTrangThai}, Countdown: ${duDoanThoiGian >= 0 ? duDoanThoiGian.toFixed(2) + 's' : 'N/A'}`);
            } catch (ai_err) {
                console.error("❌ Lỗi AI:", ai_err.message);
            }
        }

        // Gửi thông báo AI
        if (shouldSendAIStatusNotification(appState.lastSentAIStatus, duDoanTrangThai)) {
            await sendAIStatusNotification(duDoanTrangThai, duDoanThoiGian);
            appState.lastSentAIStatus = duDoanTrangThai;
            if (duDoanTrangThai !== "Nguy hiểm!") appState.lastDangerAlertTime = null;
        }
        
        if (duDoanTrangThai === "Nguy hiểm!" && appState.fcmTokens.length > 0) {
            const now = Date.now();
            if (!appState.lastDangerAlertTime || (now - appState.lastDangerAlertTime) > 120000) {
                await sendAIStatusNotification(duDoanTrangThai, duDoanThoiGian);
                appState.lastDangerAlertTime = now;
            }
        }

        // Lưu dữ liệu vào DB
        const sql = `INSERT INTO sensor_data 
            (mucNuocA, mucNuocB, luuLuong, trangThai, thongBao, created_at, predicted_trangthai, time_until_a_danger, predicted_time_to_a, is_raining) 
            VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9) RETURNING id, created_at`;

        const values = [
            mucNuocA, mucNuocB, luuLuong,
            trangThaiSimulator, thongBaoSimulator,
            duDoanTrangThai,
            formatCountdown(typeof time_until_a_danger_simulator === 'number' ? time_until_a_danger_simulator : duDoanThoiGian),
            isNaN(duDoanThoiGian) ? null : duDoanThoiGian,
            isRaining
        ];

        const dbTasks = [];
        if (pool) dbTasks.push(pool.query(sql, values).then(() => console.log(`✓ Lưu Cloud/Local: A:${mucNuocA.toFixed(1)}, B:${mucNuocB.toFixed(1)}`)).catch(err => console.error("❌ Lưu Cloud/Local:", err.message)));
        if (railwayPool) dbTasks.push(railwayPool.query(sql, values).then(() => console.log(`✓ Sync Cloud: A:${mucNuocA.toFixed(1)}, B:${mucNuocB.toFixed(1)}`)).catch(err => console.error("❌ Sync Cloud:", err.message)));

        await Promise.all(dbTasks);

        res.status(200).json({
            message: 'Lưu và dự đoán thành công.',
            prediction_status: duDoanTrangThai,
            prediction_time: duDoanThoiGian,
            alerts_sent: {
                rapid_rise: appState.sentRapidRiseNotification,
                absolute_rise: appState.lastAbsoluteRiseAlert.value !== null,
                high_water: appState.lastHighWaterAlert.value !== null
            }
        });
    } catch (err) {
        console.error("❌ /update:", err.message);
        res.status(500).json({ error: 'Lỗi server', details: err.message });
    }
});

app.get('/data', async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'DB chưa sẵn' });
    try {
        const result = await pool.query('SELECT * FROM sensor_data ORDER BY id DESC LIMIT 1');
        if (result.rows.length === 0) return res.status(404).json({ message: 'Chưa có dữ liệu' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error("❌ /data:", err.message);
        res.status(500).json({ error: 'Lỗi lấy dữ liệu' });
    }
});

app.get('/api/chart_data', async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'DB chưa sẵn' });
    try {
        const result = await pool.query(`
            SELECT id, mucnuoca, mucnuocb, luuluong, predicted_trangthai, created_at
            FROM sensor_data ORDER BY id DESC LIMIT 300;
        `);
        res.json(result.rows.reverse());
    } catch (err) {
        console.error("❌ /chart_data:", err.message);
        res.status(500).json({ error: 'Lỗi lấy biểu đồ' });
    }
});

app.get('/api/history_by_date', async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'DB chưa sẵn' });
    try {
        const { date } = req.query;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Sai định dạng ngày' });
        const result = await pool.query(`SELECT * FROM sensor_data WHERE (created_at AT TIME ZONE '+07')::date = $1 ORDER BY id DESC;`, [date]);
        res.json(result.rows);
    } catch (err) {
        console.error("❌ /history_by_date:", err.message);
        res.status(500).json({ error: 'Lỗi lấy lịch sử' });
    }
});

app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    console.warn("⚠️ File upload trên Railway là tạm thời, sử dụng volume nếu cần lưu lâu dài.");
    res.json({ filename: req.file.filename, originalname: req.file.originalname });
});

// Khởi động app
(async () => {
    await initializeDatabase();
    initializeFirebase();
    await ensureTables(pool, process.env.DATABASE_URL ? 'Cloud' : 'Local');
    if (railwayPool) await ensureTables(railwayPool, 'Cloud Sync');
    await loadFcmTokens();
    setInterval(loadFcmTokens, TOKEN_SYNC_INTERVAL);

    app.listen(SERVER_PORT, () => {
        console.log(`🚀 Server chạy tại cổng: ${SERVER_PORT}`);
        console.log(`🧠 AI Python: ${PYTHON_SERVER_URL}`);
        console.log("📱 Sẵn sàng nhận FCM token.");
        console.log(`🎯 Cảnh báo: Tốc độ > ${RAPID_RISE_THRESHOLD} cm/s, Tăng > ${ABSOLUTE_RISE_THRESHOLD} cm, Mực cao > ${HIGH_WATER_LEVEL_THRESHOLD} cm`);
    });
})();