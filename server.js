/**
 * index.js
 *
 * Single-file complete server:
 * - Express + PostgreSQL (local/cloud)
 * - Firebase Admin (local file or SERVICE_ACCOUNT_JSON env)
 * - AI calls to PYTHON_SERVER_URL
 * - /update, /data, /api/chart_data, /api/history_by_date, /api/register_fcm_token
 * - Offline queue (unsynced_data.json) + auto sync to RAILWAY_SYNC_URL
 *
 * Required env (example):
 * PORT=3000
 * PYTHON_SERVER_URL=http://localhost:5001
 * RAILWAY_SYNC_URL=https://your-railway-app.up.railway.app/update
 * DATABASE_URL=postgres://...
 * SERVICE_ACCOUNT_JSON=... (JSON string) OR have serviceAccountKey.json file locally
 *
 * Install deps:
 * npm i express pg cors axios dotenv firebase-admin multer
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const admin = require('firebase-admin');
const multer = require('multer');

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
console.log("--- KẾT THÚC DEBUG ---");

// --------------- CONFIG --------------------
const SERVER_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const PYTHON_SERVER_URL = process.env.PYTHON_SERVER_URL || "http://localhost:5001";
const RAPID_RISE_THRESHOLD = process.env.RAPID_RISE_THRESHOLD ? parseFloat(process.env.RAPID_RISE_THRESHOLD) : 0.5; // cm/s
const RAILWAY_SYNC_URL = process.env.RAILWAY_SYNC_URL || null;
const UNSYNCED_FILE = path.join(__dirname, 'unsynced_data.json');
const SYNC_INTERVAL_MS = process.env.SYNC_INTERVAL_MS ? parseInt(process.env.SYNC_INTERVAL_MS, 10) : 30000; // 30s

// --------------- DB POOL -------------------
let pool;
try {
    if (process.env.DATABASE_URL) {
        console.log("✅ [DB Config] Đang kết nối CSDL Cloud (sử dụng DATABASE_URL)...");
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: {
                rejectUnauthorized: false
            }
        });
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
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase Admin SDK đã khởi tạo từ BIẾN MÔI TRƯỜNG (Cloud).");
    } else {
        // fallback to local file
        const localServicePath = path.join(__dirname, 'serviceAccountKey.json');
        if (fs.existsSync(localServicePath)) {
            console.log("⚠️ [Firebase] Khởi tạo từ file 'serviceAccountKey.json' (Local)");
            const serviceAccount = require(localServicePath);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log("✅ Firebase Admin SDK đã khởi tạo từ FILE (Local).");
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

// for file upload (if needed in future)
const upload = multer({ dest: path.join(__dirname, 'uploads/') });

// --------------- HELPERS -------------------
function formatCountdown(seconds) {
    if (seconds === null || seconds === undefined || isNaN(seconds) || seconds < 0) return null;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    if (minutes > 0) return `${minutes} phút ${remainingSeconds} giây`;
    return `${remainingSeconds} giây`;
}

function getNotificationTitle(status) {
    const titleMap = {
        "Bình thường": "✅ Tình hình ổn định",
        "Cảnh báo!": "⚠️ Cảnh báo Lũ",
        "Cảnh báo Cao!": "🔶 Cảnh báo Lũ Cao",
        "Nguy hiểm!": "🚨 BÁO ĐỘNG NGUY HIỂM"
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
        if (countdown < 300 && status !== "Bình thường") {
            body += " HÃY DI CHUYỂN ĐẾN NƠI AN TOÀN NGAY!";
        }
    }
    return body;
}

function shouldSendAIStatusNotification(lastStatus, currentStatus) {
    if (!appState.fcmToken) {
        console.log("📱 Chưa có FCM token, bỏ qua gửi thông báo AI.");
        return false;
    }
    if (lastStatus !== currentStatus) {
        console.log(`🔄 Trạng thái AI thay đổi: ${lastStatus} -> ${currentStatus}`);
        return true;
    }
    return false;
}

// --------------- PUSH (FCM) ----------------
async function sendPushNotificationInternal(title, body) {
    if (!admin.apps.length) { 
        console.error("❌ Firebase Admin chưa khởi tạo, không thể gửi thông báo."); 
        return false; 
    }
    if (!appState.fcmToken) {
        console.warn("sendPushNotificationInternal: fcmToken là null.");
        return false;
    }

    const message = {
        notification: { title, body },
        token: appState.fcmToken,
        android: { priority: 'high', notification: { sound: 'default', channelId: 'FloodWarningChannel' } },
        apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default', alert: { title, body } } } }
    };

    try {
        await admin.messaging().send(message);
        console.log(`✅ ĐÃ GỬI THÔNG BÁO: ${title}`);
        return true;
    } catch (error) {
        console.error("❌ Lỗi khi gửi FCM:", error && error.message ? error.message : error);
        if (error && (error.code === 'messaging/registration-token-not-registered' || error.code === 'messaging/invalid-registration-token')) {
            console.warn("🗑️ FCM token không hợp lệ. Xóa token.");
            appState.fcmToken = null;
        }
        return false;
    }
}

async function sendAIStatusNotification(status, countdown) {
    if (!admin.apps.length) { 
        console.error("❌ Firebase Admin chưa khởi tạo, không gửi được thông báo AI."); 
        return; 
    }
    const title = getNotificationTitle(status);
    const body = getNotificationBody(status, countdown);
    console.log(`📤 Gửi thông báo AI: ${title} - ${body}`);
    await sendPushNotificationInternal(title, body);
}

async function sendRapidRiseNotification(rate) {
    if (!admin.apps.length) { 
        console.error("❌ Firebase Admin chưa khởi tạo, không gửi được thông báo dâng nhanh."); 
        return; 
    }
    const title = "🌊 Cảnh báo: Nước Dâng Nhanh!";
    const body = `Phát hiện mực nước B đang dâng nhanh (${rate.toFixed(2)} cm/s).`;
    await sendPushNotificationInternal(title, body);
}

// --------------- OFFLINE QUEUE ----------------
function saveUnsyncedData(payload) {
    try {
        let existing = [];
        if (fs.existsSync(UNSYNCED_FILE)) {
            existing = JSON.parse(fs.readFileSync(UNSYNCED_FILE, 'utf8') || '[]');
        }
        existing.push({ payload, ts: Date.now() });
        fs.writeFileSync(UNSYNCED_FILE, JSON.stringify(existing, null, 2));
        console.log("💾 Lưu tạm dữ liệu offline vào unsynced_data.json");
    } catch (err) {
        console.error("❌ Lỗi lưu unsynced data:", err && err.message ? err.message : err);
    }
}

async function syncPendingData() {
    if (!RAILWAY_SYNC_URL) return; // nothing to sync if not configured
    if (!fs.existsSync(UNSYNCED_FILE)) return;
    try {
        const raw = fs.readFileSync(UNSYNCED_FILE, 'utf8') || '[]';
        const pending = JSON.parse(raw);
        if (!Array.isArray(pending) || pending.length === 0) return;

        console.log(`🔁 Đang cố đồng bộ ${pending.length} bản ghi lên Railway...`);
        const failed = [];
        for (const entry of pending) {
            try {
                await axios.post(RAILWAY_SYNC_URL, entry.payload, { timeout: 8000 });
                console.log("✅ Đồng bộ 1 mẫu thành công");
            } catch (err) {
                console.warn("⚠️ Gửi 1 mẫu thất bại, sẽ giữ lại:", err && err.message ? err.message : err);
                failed.push(entry);
            }
        }
        if (failed.length === 0) {
            fs.unlinkSync(UNSYNCED_FILE);
            console.log("🗑️ Đã gửi hết pending, xóa unsynced_data.json");
        } else {
            fs.writeFileSync(UNSYNCED_FILE, JSON.stringify(failed, null, 2));
            console.log(`⚠️ Còn lại ${failed.length} mẫu chưa gửi được, giữ lại.`);
        }
    } catch (err) {
        console.error("❌ Lỗi trong syncPendingData:", err && err.message ? err.message : err);
    }
}
setInterval(syncPendingData, SYNC_INTERVAL_MS);

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
        console.log("✅ Bảng sensor_data sẵn sàng.");
    } catch (err) {
        console.error("❌ Lỗi tạo bảng sensor_data:", err && err.message ? err.message : err);
    }
}
ensureTables().catch(e=>console.error(e));

// --------------- ROUTES ---------------------

// Health
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

// Main update endpoint - receives from fake_sensor
app.post('/update', async (req, res) => {
    let duDoanTrangThai = "Lỗi dự đoán";
    let duDoanThoiGian = -1;
    let b_rate_of_change = 0;
    let flow_rate_of_change = 0;
    let currentTime;
    try {
        const body = req.body || {};
        const mucNuocA = parseFloat(body.mucNuocA);
        const mucNuocB = parseFloat(body.mucNuocB);
        const luuLuong = parseFloat(body.luuLuong);
        const isRaining = body.isRaining === true || body.isRaining === 'true';
        const trangThaiSimulator = body.trangThai || '';
        const thongBaoSimulator = body.thongBao || '';
        const time_until_a_danger_simulator = body.time_until_a_danger;

        if (isNaN(mucNuocA) || isNaN(mucNuocB) || isNaN(luuLuong) || typeof body.isRaining === 'undefined') {
            console.warn("⚠️ /update thiếu dữ liệu hoặc sai định dạng.");
            return res.status(400).json({ error: 'Thiếu dữ liệu hoặc sai định dạng số' });
        }

        currentTime = Date.now();

        // calculate rate
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

        // rapid rise alert
        if (b_rate_of_change > RAPID_RISE_THRESHOLD && !appState.sentRapidRiseNotification) {
            console.warn(`🌊 Nước dâng nhanh: ${b_rate_of_change.toFixed(2)} cm/s`);
            await sendRapidRiseNotification(b_rate_of_change);
            appState.sentRapidRiseNotification = true;
        } else if (b_rate_of_change <= 0 && appState.sentRapidRiseNotification) {
            console.info("💧 Nước ngừng dâng nhanh.");
            appState.sentRapidRiseNotification = false;
        }

        // call AI (python server)
        const ab_diff = mucNuocB - mucNuocA;
        const is_raining_now = isRaining ? 1 : 0;
        const ai_payload = { mucNuocA, mucNuocB, luuLuong, is_raining_now, b_rate_of_change, flow_rate_of_change, ab_diff };
        try {
            const [statusRes, timeRes] = await Promise.allSettled([
                axios.post(`${PYTHON_SERVER_URL}/predict`, ai_payload, { timeout: 6000 }),
                axios.post(`${PYTHON_SERVER_URL}/predict_time`, ai_payload, { timeout: 6000 })
            ]);

            if (statusRes.status === 'fulfilled' && statusRes.value && statusRes.value.data && statusRes.value.data.prediction) {
                duDoanTrangThai = statusRes.value.data.prediction;
            }
            if (timeRes.status === 'fulfilled' && timeRes.value && timeRes.value.data && !isNaN(parseFloat(timeRes.value.data.predicted_seconds))) {
                duDoanThoiGian = parseFloat(timeRes.value.data.predicted_seconds);
            }
            console.log(`[AI] ${duDoanTrangThai}, time: ${duDoanThoiGian}s`);
            // send AI status notification if changed
            if (shouldSendAIStatusNotification(appState.lastSentAIStatus, duDoanTrangThai)) {
                await sendAIStatusNotification(duDoanTrangThai, duDoanThoiGian);
                appState.lastSentAIStatus = duDoanTrangThai;
                if (duDoanTrangThai !== "Nguy hiểm!") appState.lastDangerAlertTime = null;
            }

            if (duDoanTrangThai === "Nguy hiểm!" && appState.fcmToken) {
                const now = Date.now();
                if (!appState.lastDangerAlertTime || (now - appState.lastDangerAlertTime) > 2 * 60 * 1000) {
                    await sendAIStatusNotification(duDoanTrangThai, duDoanThoiGian);
                    appState.lastDangerAlertTime = now;
                }
            }

        } catch (ai_err) {
            console.error("❌ Lỗi gọi AI:", ai_err && ai_err.message ? ai_err.message : ai_err);
        }

        // Save to DB
        const sql = `INSERT INTO sensor_data 
            (mucNuocA, mucNuocB, luuLuong, trangThai, thongBao, created_at, predicted_trangthai, time_until_a_danger, predicted_time_to_a, is_raining) 
            VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9) RETURNING id, created_at`;
        const values = [
            mucNuocA, mucNuocB, luuLuong, trangThaiSimulator, thongBaoSimulator,
            duDoanTrangThai,
            formatCountdown(typeof time_until_a_danger_simulator !== 'undefined' && time_until_a_danger_simulator !== null ? time_until_a_danger_simulator : duDoanThoiGian),
            duDoanThoiGian,
            isRaining
        ];
        let savedRecord = null;
        if (pool) {
            try {
                const dbRes = await pool.query(sql, values);
                savedRecord = dbRes.rows && dbRes.rows[0] ? dbRes.rows[0] : null;
                console.log(`💾 DB Save: A:${mucNuocA}, B:${mucNuocB}, id:${savedRecord ? savedRecord.id : 'n/a'}`);
            } catch (db_err) {
                console.error("❌ Lỗi lưu DB:", db_err && db_err.message ? db_err.message : db_err);
            }
        } else {
            console.warn("⚠️ Bỏ qua lưu vào DB: pool chưa khởi tạo.");
        }

        // attempt to sync to Railway (if configured)
        if (RAILWAY_SYNC_URL) {
            try {
                const payloadToCloud = {
                    mucNuocA, mucNuocB, luuLuong, isRaining,
                    trangThai: trangThaiSimulator, thongBao: thongBaoSimulator,
                    time_until_a_danger: duDoanThoiGian,
                    predicted_trangthai: duDoanTrangThai,
                    created_at: savedRecord && savedRecord.created_at ? savedRecord.created_at : new Date().toISOString()
                };
                await axios.post(RAILWAY_SYNC_URL, payloadToCloud, { timeout: 7000 });
                console.log("☁️ Đồng bộ lên Railway thành công.");
            } catch (syncErr) {
                console.warn("⚠️ Không thể đồng bộ lên Railway (lưu vào queue):", syncErr && syncErr.message ? syncErr.message : syncErr);
                // save unsynced
                saveUnsyncedData({
                    mucNuocA, mucNuocB, luuLuong, isRaining,
                    trangThai: trangThaiSimulator, thongBao: thongBaoSimulator,
                    time_until_a_danger: duDoanThoiGian,
                    predicted_trangthai: duDoanTrangThai,
                    created_at: savedRecord && savedRecord.created_at ? savedRecord.created_at : new Date().toISOString()
                });
            }
        }

        // update state
        appState.lastSensorData = currentSensorData;

        // respond
        res.json({
            message: 'Đã xử lý và lưu dữ liệu',
            prediction_status: duDoanTrangThai,
            prediction_time: duDoanThoiGian
        });

    } catch (err) {
        console.error("❌ Lỗi /update:", err && err.message ? err.message : err);
        // attempt to update state even on error
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
        const sql = `SELECT * FROM sensor_data WHERE created_at::date = $1 ORDER BY id DESC;`;
        const result = await pool.query(sql, [date]);
        res.json(result.rows || []);
    } catch (err) {
        console.error("❌ /api/history_by_date error:", err && err.message ? err.message : err);
        res.status(500).json({ error: 'Lỗi server khi lấy lịch sử' });
    }
});

// Optional: Endpoint to force sync pending data (debug)
app.post('/admin/force_sync', async (req, res) => {
    try {
        await syncPendingData();
        res.json({ message: 'Attempted sync' });
    } catch (err) {
        console.error("❌ /admin/force_sync error:", err && err.message ? err.message : err);
        res.status(500).json({ error: 'Error during sync' });
    }
});

// Example upload endpoint (kept minimal, in case you want images later)
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    res.json({ filename: req.file.filename, originalname: req.file.originalname });
});

// --------------- START SERVER ----------------
app.listen(SERVER_PORT, () => {
    console.log(`🚀 Server Node.js đang chạy tại cổng: ${SERVER_PORT}`);
    console.log(`🧠 Kết nối tới AI Python: ${PYTHON_SERVER_URL}`);
    if (RAILWAY_SYNC_URL) console.log(`🔁 Đồng bộ Railway: ${RAILWAY_SYNC_URL}`);
    console.log("📱 Sẵn sàng nhận FCM token từ client.");
});
