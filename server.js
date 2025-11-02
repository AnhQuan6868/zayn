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
require('dotenv').config();
const admin = require('firebase-admin');

// --------------- DEBUG ENV ----------------
console.log("--- BẮT ĐẦU DEBUG BIẾN MÔI TRƯỜNG ---");
console.log("SERVICE_ACCOUNT_JSON:", process.env.SERVICE_ACCOUNT_JSON ? "✅ TỒN TẠI" : "❌ KHÔNG TỒN TẠI");
console.log("DATABASE_URL:", process.env.DATABASE_URL ? "✅ TỒN TẠI" : "❌ KHÔNG TỒN TẠI");
console.log("RAILWAY_DB_URL:", process.env.RAILWAY_DB_URL ? "✅ TỒN TẠI" : "⚠️ KHÔNG TỒN TẠI");
console.log("--- KẾT THÚC DEBUG ---");

// --------------- CONFIG --------------------
const SERVER_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const PYTHON_SERVER_URL = process.env.PYTHON_SERVER_URL || "http://localhost:5001";
const RAPID_RISE_THRESHOLD = process.env.RAPID_RISE_THRESHOLD ? parseFloat(process.env.RAPID_RISE_THRESHOLD) : 0.5;

// --------------- DB POOL -------------------
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
        console.log("⚠️ [DB Config] Đang kết nối CSDL Local...");
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
    console.error("❌ LỖI KHI KHỞI TẠO CSDL POOL:", dbErr.message);
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
    console.error("❌ LỖI KHI KHỞI TẠO FIREBASE ADMIN:", error.message);
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

// --------------- HELPERS -------------------
function formatCountdown(seconds) {
    if (seconds === null || seconds === undefined || isNaN(seconds) || seconds < 0) return null;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    return (minutes > 0) ? `${minutes} phút ${remainingSeconds} giây` : `${remainingSeconds} giây`;
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
        if (countdown < 300) body += " HÃY DI CHUYỂN ĐẾN NƠI AN TOÀN NGAY!";
    }
    return body;
}

function shouldSendAIStatusNotification(lastStatus, currentStatus) {
    if (!appState.fcmToken) {
        console.log("📱 Chưa có FCM token, bỏ qua thông báo!");
        return false;
    }
    if (lastStatus !== currentStatus) {
        console.log(`🔄 Thay đổi trạng thái AI: ${lastStatus} -> ${currentStatus}`);
        return true;
    }
    return false;
}

// --------------- PUSH (FCM) ----------------
async function sendPushNotificationInternal(title, body) {
    if (!admin.apps.length) {
        console.error("❌ Firebase Admin chưa khởi tạo.");
        return false;
    }
    if (!appState.fcmToken) {
        console.warn("sendPushNotificationInternal: fcmToken là null.");
        return false;
    }
    
    const message = {
        notification: { title, body },
        token: appState.fcmToken,
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
                    alert: { title, body }
                }
            }
        }
    };
    
    try {
        await admin.messaging().send(message);
        console.log(`✅ ĐÃ GỬI THÔNG BÁO: ${title}`);
        return true;
    } catch (error) {
        console.error(`❌ Lỗi gửi Push Notification: ${error.message}`);
        if (error.code === 'messaging/registration-token-not-registered' || error.code === 'messaging/invalid-registration-token') {
            console.warn("🗑️ FCM token không hợp lệ. Xóa token.");
            appState.fcmToken = null;
        }
        return false;
    }
}

async function sendAIStatusNotification(status, countdown) {
    const title = getNotificationTitle(status);
    const body = getNotificationBody(status, countdown);
    console.log(`📤 Chuẩn bị gửi thông báo AI: ${status}`);
    await sendPushNotificationInternal(title, body);
}

async function sendRapidRiseNotification(rate) {
    const title = "🌊 Cảnh báo: Nước Dâng Nhanh!";
    const body = `Phát hiện mực nước B đang dâng nhanh (${rate.toFixed(1)} cm/s).`;
    console.log("📤 Chuẩn bị gửi thông báo dâng nhanh");
    await sendPushNotificationInternal(title, body);
}

// --------------- DB INIT -------------------
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
        
        if (railwayPool) {
            await railwayPool.query(createSql);
            console.log("✅ Bảng sensor_data (Cloud Sync) sẵn sàng.");
        }
    } catch (err) {
        console.error("❌ Lỗi tạo bảng sensor_data:", err.message);
    }
}

ensureTables().catch(e => console.error(e));

// --------------- ROUTES ---------------------
app.get('/', (req, res) => {
    res.send({ status: 'OK', now: new Date().toISOString() });
});

app.post('/api/register_fcm_token', (req, res) => {
    try {
        const { token } = req.body;
        if (!token) {
            return res.status(400).json({ error: 'Missing token' });
        }
        appState.fcmToken = token;
        console.log(`✅ Đã nhận FCM token: ${token.substring(0, 10)}...`);
        res.json({ message: 'OK' });
    } catch (err) {
        console.error("❌ /api/register_fcm_token error:", err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/update', async (req, res) => {
    let currentTime;
    let duDoanTrangThai = "Lỗi dự đoán";
    let duDoanThoiGian = -1;
    let b_rate_of_change = 0;
    let flow_rate_of_change = 0;
    
    try {
        const body = req.body || {};
        const { 
            mucNuocA: mA, 
            mucNuocB: mB, 
            luuLuong: lL, 
            isRaining: iR, 
            trangThai: tS, 
            thongBao: tBS, 
            time_until_a_danger: tUAD 
        } = body;

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

        // Tính tốc độ thay đổi
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

        // Cảnh báo dâng nhanh
        if (b_rate_of_change > RAPID_RISE_THRESHOLD && !appState.sentRapidRiseNotification) {
            console.warn(`🌊 Nước dâng nhanh! Tốc độ B: ${b_rate_of_change.toFixed(2)} cm/s`);
            await sendRapidRiseNotification(b_rate_of_change);
            appState.sentRapidRiseNotification = true;
        } else if (b_rate_of_change <= 0 && appState.sentRapidRiseNotification) {
            console.info("💧 Nước ngừng dâng nhanh.");
            appState.sentRapidRiseNotification = false;
        }

        // Gọi AI
        if (!process.env.DATABASE_URL || process.env.CLOUD_AI === 'true') {
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
                console.error("❌ Lỗi gọi API dự đoán (Python):", ai_err.message);
            }
        }

        // Gửi thông báo
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

        // Lưu dữ liệu vào DB
        const sql = `INSERT INTO sensor_data 
            (mucNuocA, mucNuocB, luuLuong, trangThai, thongBao, created_at, predicted_trangthai, time_until_a_danger, predicted_time_to_a, is_raining) 
            VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9) RETURNING id, created_at`;

        const values = [
            mucNuocA,
            mucNuocB,
            luuLuong,
            trangThaiSimulator,
            thongBaoSimulator,
            duDoanTrangThai,
            formatCountdown(typeof time_until_a_danger_simulator !== 'undefined' && time_until_a_danger_simulator !== null ? time_until_a_danger_simulator : duDoanThoiGian),
            (typeof duDoanThoiGian === 'number' && !isNaN(duDoanThoiGian)) ? duDoanThoiGian : null,
            isRaining
        ];

        const dbTasks = [];
        const logMsg = `[DB Save]: A:${mucNuocA.toFixed(1)}, B:${mucNuocB.toFixed(1)}`;

        if (pool) {
            dbTasks.push(
                pool.query(sql, values)
                    .then(() => {
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
        appState.lastSensorData = currentSensorData;

        res.status(200).json({
            message: 'Đã lưu và dự đoán thành công.',
            prediction_status: duDoanTrangThai,
            prediction_time: duDoanThoiGian
        });

    } catch (err) {
        console.error("❌ Lỗi /update:", err.message);
        
        if (currentTime) {
            const body = req.body || {};
            appState.lastSensorData = {
                mucNuocB: parseFloat(body.mucNuocB) || appState.lastSensorData.mucNuocB || 0,
                luuLuong: parseFloat(body.luuLuong) || appState.lastSensorData.luuLuong || 0,
                timestamp: currentTime
            };
        }
        
        res.status(500).json({ 
            error: 'Lỗi server khi xử lý dữ liệu', 
            details: err.message 
        });
    }
});

app.get('/data', async (req, res) => {
    if (!pool) {
        return res.status(500).json({ error: 'CSDL chưa sẵn sàng' });
    }
    
    try {
        const sql = 'SELECT * FROM sensor_data ORDER BY id DESC LIMIT 1';
        const result = await pool.query(sql);
        
        if (!result.rows || result.rows.length === 0) {
            return res.status(404).json({ message: 'Chưa có dữ liệu.' });
        }
        
        res.json(result.rows[0]);
    } catch (err) {
        console.error("❌ /data error:", err.message);
        res.status(500).json({ error: 'Lỗi server khi lấy dữ liệu' });
    }
});

app.get('/api/chart_data', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'CSDL chưa sẵn sàng' });
        }
        
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
        console.error("❌ /api/chart_data error:", err.message);
        res.status(500).json({ error: 'Lỗi server khi lấy dữ liệu biểu đồ' });
    }
});

app.get('/api/history_by_date', async (req, res) => {
    if (!pool) {
        return res.status(500).json({ error: 'CSDL chưa sẵn sàng' });
    }
    
    try {
        const { date } = req.query;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'Thiếu hoặc sai định dạng tham số ngày (YYYY-MM-DD)' });
        }
        
        const sql = `SELECT * FROM sensor_data WHERE (created_at AT TIME ZONE '+07')::date = $1 ORDER BY id DESC;`;
        const result = await pool.query(sql, [date]);
        res.json(result.rows || []);
    } catch (err) {
        console.error("❌ /api/history_by_date error:", err.message);
        res.status(500).json({ error: 'Lỗi server khi lấy lịch sử' });
    }
});

// --------------- START SERVER ----------------
app.listen(SERVER_PORT, () => {
    console.log(`🚀 Server Node.js đang chạy tại cổng: ${SERVER_PORT}`);
    console.log(`🧠 Kết nối tới AI Python: ${PYTHON_SERVER_URL}`);
    console.log("📱 Sẵn sàng nhận FCM token từ client.");
});