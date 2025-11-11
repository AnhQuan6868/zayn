// =============================================
// SERVER.JS - FLOOD ALERT SYSTEM (FIXED VERSION)
// =============================================

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
// CẤU HÌNH HỆ THỐNG
// =============================
const SERVER_PORT = process.env.PORT || 3000;
const PYTHON_SERVER_URL = process.env.PYTHON_SERVER_URL || "http://localhost:5001";

// NGƯỠNG CẢNH BÁO
const RAPID_RISE_THRESHOLD = 0.3; // cm/giây
const ABSOLUTE_RISE_THRESHOLD = 3; // cm  
const HIGH_WATER_LEVEL_THRESHOLD = 12; // cm
const TOKEN_SYNC_INTERVAL = 30000; // 30 giây

// =============================
// KHỞI TẠO DATABASE
// =============================
let pool;

console.log("🔧 Đang khởi tạo hệ thống...");

try {
    if (process.env.DATABASE_URL) {
        // MÔI TRƯỜNG CLOUD (RAILWAY)
        console.log("✅ Kết nối Cloud Database...");
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
    } else {
        // MÔI TRƯỜNG LOCAL
        console.log("✅ Kết nối Local Database...");
        const DB_CONFIG = {
            user: process.env.DB_USER || 'postgres',
            host: process.env.DB_HOST || 'localhost',
            database: process.env.DB_NAME || 'flood_alert_db',
            password: process.env.DB_PASS || 'Quan@',
            port: parseInt(process.env.DB_PORT) || 5432,
        };
        pool = new Pool(DB_CONFIG);
    }
    console.log("✅ Database kết nối thành công!");
} catch (dbErr) {
    console.error("❌ Lỗi kết nối database:", dbErr.message);
    process.exit(1);
}

// =============================
// KHỞI TẠO FIREBASE
// =============================
try {
    if (process.env.SERVICE_ACCOUNT_JSON) {
        console.log("✅ Khởi tạo Firebase từ biến môi trường...");
        const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } else {
        const localServicePath = path.join(__dirname, 'serviceAccountKey.json');
        if (fs.existsSync(localServicePath)) {
            console.log("✅ Khởi tạo Firebase từ file local...");
            const serviceAccount = require(localServicePath);
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        } else {
            console.warn("⚠️ Firebase chưa khởi tạo - Không tìm thấy service account");
        }
    }
    console.log("✅ Firebase khởi tạo thành công!");
} catch (firebaseErr) {
    console.error("❌ Lỗi khởi tạo Firebase:", firebaseErr.message);
}

// =============================
// TRẠNG THÁI HỆ THỐNG
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
const upload = multer({ dest: path.join(__dirname, 'uploads/') });

// =============================
// HÀM TIỆN ÍCH
// =============================
function formatCountdown(seconds) {
    if (!seconds || seconds < 0) return null;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    return minutes > 0 ? `${minutes} phút ${remainingSeconds} giây` : `${remainingSeconds} giây`;
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
        body += ` Lũ dự kiến đến sau ${formattedTime}.`;
        if (countdown < 300) body += " HÃY DI CHUYỂN ĐẾN NƠI AN TOÀN NGAY!";
    }
    return body;
}

// =============================
// QUẢN LÝ FCM TOKENS - ĐÃ SỬA LỖI
// =============================
async function syncTokensFromDatabase() {
    if (!pool) {
        console.log("❌ Không có kết nối database để đồng bộ token");
        return;
    }
    
    try {
        console.log("🔄 Đang đồng bộ FCM tokens từ database...");
        const result = await pool.query("SELECT token FROM fcm_tokens ORDER BY id DESC");
        
        if (result.rows.length > 0) {
            const dbTokens = result.rows.map(row => row.token);
            
            // Chỉ cập nhật nếu có thay đổi
            if (JSON.stringify(dbTokens) !== JSON.stringify(appState.fcmTokens)) {
                appState.fcmTokens = dbTokens;
                console.log(`✅ Đã đồng bộ ${dbTokens.length} FCM tokens`);
                
                // Debug: hiển thị tokens
                dbTokens.forEach((token, index) => {
                    console.log(`   📱 Token ${index + 1}: ${token.substring(0, 25)}...`);
                });
            }
        } else {
            console.log("ℹ️ Không có FCM tokens trong database");
            appState.fcmTokens = [];
        }
    } catch (error) {
        console.error("❌ Lỗi đồng bộ tokens:", error.message);
    }
}

async function sendPushNotification(title, body) {
    // Kiểm tra Firebase
    if (!admin.apps.length) {
        console.error("❌ Firebase chưa khởi tạo");
        return false;
    }
    
    // Kiểm tra tokens
    if (!appState.fcmTokens || appState.fcmTokens.length === 0) {
        console.error("❌ Không có FCM tokens để gửi");
        return false;
    }
    
    console.log(`📤 Đang gửi thông báo đến ${appState.fcmTokens.length} thiết bị...`);
    
    const message = {
        notification: { title, body },
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
                    alert: { title, body }
                }
            }
        }
    };
    
    try {
        const response = await admin.messaging().sendEachForMulticast(message);
        console.log(`✅ ĐÃ GỬI: ${response.successCount} thành công, ${response.failureCount} thất bại`);
        
        // Xử lý tokens hỏng
        if (response.failureCount > 0) {
            const badTokens = [];
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    const errorCode = resp.error?.code;
                    if (errorCode === 'messaging/registration-token-not-registered' || 
                        errorCode === 'messaging/invalid-registration-token') {
                        badTokens.push(appState.fcmTokens[idx]);
                    }
                }
            });
            
            // Xóa tokens hỏng khỏi database
            if (badTokens.length > 0 && pool) {
                try {
                    await pool.query("DELETE FROM fcm_tokens WHERE token = ANY($1)", [badTokens]);
                    console.log(`🗑️ Đã xóa ${badTokens.length} token hỏng`);
                    
                    // Cập nhật appState
                    appState.fcmTokens = appState.fcmTokens.filter(token => !badTokens.includes(token));
                } catch (deleteError) {
                    console.error("❌ Lỗi xóa token hỏng:", deleteError.message);
                }
            }
        }
        
        return response.successCount > 0;
    } catch (error) {
        console.error("❌ Lỗi gửi FCM:", error.message);
        return false;
    }
}

// =============================
// HÀM CẢNH BÁO
// =============================
async function sendAIStatusNotification(status, countdown) {
    const title = getNotificationTitle(status);
    const body = getNotificationBody(status, countdown);
    await sendPushNotification(title, body);
}

async function sendRapidRiseNotification(rate) {
    const title = "🌊 Cảnh báo: Nước Dâng Nhanh!";
    const body = `Mực nước đang dâng ${rate.toFixed(1)} cm/giây. Theo dõi ngay!`;
    await sendPushNotification(title, body);
}

async function sendAbsoluteRiseNotification(absoluteRise) {
    const title = "📈 Cảnh báo: Mực nước Tăng Mạnh!";
    const body = `Mực nước đã tăng ${absoluteRise.toFixed(1)} cm so với lần trước!`;
    await sendPushNotification(title, body);
}

async function sendHighWaterNotification(waterLevel) {
    const title = "💧 Cảnh báo: Mực nước Cao!";
    const body = `Mực nước đang ở mức ${waterLevel.toFixed(1)} cm. Cảnh giác!`;
    await sendPushNotification(title, body);
}

// =============================
// KHỞI TẠO DATABASE TABLES
// =============================
async function initializeDatabase() {
    if (!pool) {
        console.error("❌ Không thể khởi tạo database tables - pool chưa sẵn sàng");
        return;
    }
    
    const tables = [`
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
    `, `
        CREATE TABLE IF NOT EXISTS fcm_tokens (
            id SERIAL PRIMARY KEY,
            token TEXT NOT NULL UNIQUE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
    `];
    
    try {
        for (const sql of tables) {
            await pool.query(sql);
        }
        console.log("✅ Database tables đã sẵn sàng");
    } catch (error) {
        console.error("❌ Lỗi khởi tạo tables:", error.message);
    }
}

// =============================
// API ENDPOINTS
// =============================

// Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        tokens_registered: appState.fcmTokens.length,
        system: 'Flood Alert System - Fixed Version'
    });
});

// Đăng ký FCM token
app.post('/api/register_fcm_token', async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) {
            return res.status(400).json({ error: 'Thiếu FCM token' });
        }
        
        if (!pool) {
            return res.status(500).json({ error: 'Database chưa sẵn sàng' });
        }
        
        // Lưu token vào database
        await pool.query(
            "INSERT INTO fcm_tokens (token) VALUES ($1) ON CONFLICT (token) DO NOTHING",
            [token]
        );
        
        console.log(`✅ Đã đăng ký FCM token: ${token.substring(0, 25)}...`);
        
        // Đồng bộ lại tokens
        await syncTokensFromDatabase();
        
        res.json({ message: 'Đăng ký token thành công' });
    } catch (error) {
        console.error("❌ Lỗi đăng ký token:", error.message);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// Debug tokens
app.get('/api/debug_tokens', async (req, res) => {
    try {
        let dbTokens = [];
        if (pool) {
            const result = await pool.query("SELECT token, created_at FROM fcm_tokens");
            dbTokens = result.rows;
        }
        
        res.json({
            app_state_tokens: appState.fcmTokens.length,
            database_tokens: dbTokens.length,
            firebase_ready: admin.apps.length > 0,
            database_ready: !!pool
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Nhận dữ liệu từ sensor
app.post('/update', async (req, res) => {
    let aiStatus = "Bình thường";
    let aiCountdown = -1;
    
    try {
        const { mucNuocA, mucNuocB, luuLuong, isRaining, trangThai, thongBao, time_until_a_danger } = req.body;
        
        // Validate dữ liệu
        if (mucNuocA === undefined || mucNuocB === undefined || luuLuong === undefined) {
            return res.status(400).json({ error: 'Thiếu dữ liệu sensor' });
        }
        
        const currentTime = Date.now();
        const mucNuocAVal = parseFloat(mucNuocA);
        const mucNuocBVal = parseFloat(mucNuocB);
        const luuLuongVal = parseFloat(luuLuong);
        const isRainingVal = isRaining === true || isRaining === 'true';
        
        console.log(`📊 Sensor Data: A=${mucNuocAVal}, B=${mucNuocBVal}, Flow=${luuLuongVal}, Rain=${isRainingVal}`);
        
        // Tính toán tốc độ thay đổi
        let rateOfChange = 0;
        let absoluteChange = 0;
        
        if (appState.lastSensorData.timestamp && appState.lastSensorData.mucNuocB !== null) {
            const timeDiff = (currentTime - appState.lastSensorData.timestamp) / 1000;
            if (timeDiff > 0) {
                rateOfChange = (mucNuocBVal - appState.lastSensorData.mucNuocB) / timeDiff;
                absoluteChange = mucNuocBVal - appState.lastSensorData.mucNuocB;
            }
        }
        
        // Khởi tạo tổng mức tăng
        if (appState.b_total_rise_start === null) {
            appState.b_total_rise_start = mucNuocBVal;
        }
        const totalRise = mucNuocBVal - appState.b_total_rise_start;
        
        // CẢNH BÁO THÔNG MINH
        const now = Date.now();
        
        // 1. Cảnh báo tốc độ dâng nhanh
        if (rateOfChange > RAPID_RISE_THRESHOLD) {
            const canSend = !appState.rapidRiseNotificationTime || 
                           (now - appState.rapidRiseNotificationTime) > 600000; // 10 phút
            
            if (!appState.sentRapidRiseNotification || canSend) {
                console.warn(`🌊 CẢNH BÁO: Nước dâng nhanh ${rateOfChange.toFixed(2)} cm/s`);
                await sendRapidRiseNotification(rateOfChange);
                appState.sentRapidRiseNotification = true;
                appState.rapidRiseNotificationTime = now;
            }
        }
        
        // 2. Cảnh báo tăng tuyệt đối
        if (absoluteChange > ABSOLUTE_RISE_THRESHOLD) {
            const canSend = !appState.lastAbsoluteRiseAlert.time || 
                           (now - appState.lastAbsoluteRiseAlert.time) > 900000 || // 15 phút
                           Math.abs(absoluteChange - appState.lastAbsoluteRiseAlert.value) > 2;
            
            if (canSend) {
                console.warn(`📈 CẢNH BÁO: Mực nước tăng ${absoluteChange.toFixed(1)} cm`);
                await sendAbsoluteRiseNotification(absoluteChange);
                appState.lastAbsoluteRiseAlert = { value: absoluteChange, time: now };
            }
        }
        
        // 3. Cảnh báo mực nước cao
        if (mucNuocBVal > HIGH_WATER_LEVEL_THRESHOLD) {
            const canSend = !appState.lastHighWaterAlert.time || 
                           (now - appState.lastHighWaterAlert.time) > 1200000 || // 20 phút
                           Math.abs(mucNuocBVal - appState.lastHighWaterAlert.value) > 3;
            
            if (canSend) {
                console.warn(`💧 CẢNH BÁO: Mực nước cao ${mucNuocBVal} cm`);
                await sendHighWaterNotification(mucNuocBVal);
                appState.lastHighWaterAlert = { value: mucNuocBVal, time: now };
            }
        }
        
        // Reset cảnh báo khi tốc độ giảm
        if (rateOfChange <= RAPID_RISE_THRESHOLD * 0.3) {
            appState.sentRapidRiseNotification = false;
        }
        
        // GỌI AI SERVER (chỉ khi chạy local)
        if (!process.env.DATABASE_URL) {
            try {
                const aiPayload = {
                    mucNuocA: mucNuocAVal,
                    mucNuocB: mucNuocBVal,
                    luuLuong: luuLuongVal,
                    is_raining_now: isRainingVal ? 1 : 0,
                    b_rate_of_change: rateOfChange,
                    flow_rate_of_change: 0,
                    ab_diff: mucNuocBVal - mucNuocAVal,
                    ab_ratio: mucNuocBVal / (mucNuocAVal + 0.001),
                    b_absolute_change: absoluteChange,
                    b_total_rise: totalRise,
                    danger_index: (mucNuocBVal * 0.3) + (Math.abs(rateOfChange) * 2.0) + (Math.abs(absoluteChange) * 0.5),
                    b_trend: mucNuocBVal
                };
                
                const [statusRes, timeRes] = await Promise.all([
                    axios.post(`${PYTHON_SERVER_URL}/predict`, aiPayload, { timeout: 8000 }),
                    axios.post(`${PYTHON_SERVER_URL}/predict_time`, aiPayload, { timeout: 8000 })
                ]);
                
                aiStatus = statusRes?.data?.prediction || aiStatus;
                aiCountdown = parseFloat(timeRes?.data?.predicted_seconds) || aiCountdown;
                
                console.log(`🧠 AI Dự đoán: ${aiStatus}, Thời gian: ${aiCountdown}s`);
                
                // Gửi cảnh báo AI nếu trạng thái thay đổi
                if (appState.lastSentAIStatus !== aiStatus) {
                    await sendAIStatusNotification(aiStatus, aiCountdown);
                    appState.lastSentAIStatus = aiStatus;
                }
                
            } catch (aiError) {
                console.error("❌ Lỗi kết nối AI server:", aiError.message);
            }
        }
        
        // LƯU VÀO DATABASE
        if (pool) {
            const sql = `
                INSERT INTO sensor_data 
                (mucNuocA, mucNuocB, luuLuong, trangThai, thongBao, created_at, predicted_trangthai, time_until_a_danger, predicted_time_to_a, is_raining)
                VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9)
            `;
            
            const values = [
                mucNuocAVal, mucNuocBVal, luuLuongVal,
                trangThai || '', thongBao || '',
                aiStatus,
                formatCountdown(aiCountdown),
                aiCountdown,
                isRainingVal
            ];
            
            await pool.query(sql, values);
            console.log("💾 Đã lưu dữ liệu sensor");
        }
        
        // Cập nhật trạng thái
        appState.lastSensorData = {
            mucNuocB: mucNuocBVal,
            luuLuong: luuLuongVal,
            timestamp: currentTime
        };
        
        res.json({
            message: 'Cập nhật thành công',
            prediction: aiStatus,
            countdown: aiCountdown,
            alerts: {
                rapid_rise: appState.sentRapidRiseNotification,
                absolute_rise: appState.lastAbsoluteRiseAlert.value !== null,
                high_water: appState.lastHighWaterAlert.value !== null
            }
        });
        
    } catch (error) {
        console.error("❌ Lỗi xử lý /update:", error.message);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// Lấy dữ liệu mới nhất
app.get('/data', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'Database chưa sẵn sàng' });
        }
        
        const result = await pool.query(`
            SELECT * FROM sensor_data 
            ORDER BY id DESC LIMIT 1
        `);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Chưa có dữ liệu' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error("❌ Lỗi /data:", error.message);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// Dữ liệu biểu đồ
app.get('/api/chart_data', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'Database chưa sẵn sàng' });
        }
        
        const result = await pool.query(`
            SELECT id, mucnuoca, mucnuocb, luuluong, predicted_trangthai, created_at
            FROM sensor_data 
            ORDER BY id DESC LIMIT 300
        `);
        
        res.json((result.rows || []).reverse());
    } catch (error) {
        console.error("❌ Lỗi /api/chart_data:", error.message);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// Lịch sử theo ngày
app.get('/api/history_by_date', async (req, res) => {
    try {
        const { date } = req.query;
        if (!date) {
            return res.status(400).json({ error: 'Thiếu tham số ngày' });
        }
        
        const result = await pool.query(`
            SELECT * FROM sensor_data 
            WHERE DATE(created_at) = $1 
            ORDER BY id DESC
        `, [date]);
        
        res.json(result.rows || []);
    } catch (error) {
        console.error("❌ Lỗi /api/history_by_date:", error.message);
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// Upload file
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Không có file' });
    }
    res.json({ 
        filename: req.file.filename, 
        originalname: req.file.originalname 
    });
});

// =============================
// KHỞI ĐỘNG SERVER
// =============================
async function startServer() {
    try {
        // Khởi tạo database
        await initializeDatabase();
        
        // Đồng bộ tokens ban đầu
        await syncTokensFromDatabase();
        
        // Lên lịch đồng bộ tokens định kỳ
        setInterval(syncTokensFromDatabase, TOKEN_SYNC_INTERVAL);
        
        // Khởi động server
        app.listen(SERVER_PORT, () => {
            console.log('\n' + '='.repeat(50));
            console.log('🚀 FLOOD ALERT SERVER ĐÃ SẴN SÀNG!');
            console.log('='.repeat(50));
            console.log(`📍 Port: ${SERVER_PORT}`);
            console.log(`🧠 AI Server: ${PYTHON_SERVER_URL}`);
            console.log(`📱 FCM Tokens: ${appState.fcmTokens.length} devices`);
            console.log(`🔄 Token Sync: ${TOKEN_SYNC_INTERVAL / 1000}s`);
            console.log('🎯 Cảnh báo 3 cấp độ:');
            console.log(`   🌊 Tốc độ dâng: > ${RAPID_RISE_THRESHOLD} cm/s`);
            console.log(`   📈 Tăng tuyệt đối: > ${ABSOLUTE_RISE_THRESHOLD} cm`);
            console.log(`   💧 Mực nước cao: > ${HIGH_WATER_LEVEL_THRESHOLD} cm`);
            console.log('='.repeat(50) + '\n');
        });
        
    } catch (error) {
        console.error('❌ Lỗi khởi động server:', error.message);
        process.exit(1);
    }
}

// BẮT ĐẦU!
startServer();