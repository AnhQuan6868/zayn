// =============================
// CẤU HÌNH HỆ THỐNG BÁO ĐỘNG LŨ
// =============================

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// =============================
// KHAI BÁO HẰNG SỐ VÀ BIẾN
// =============================

const CONFIG = {
  PORT: process.env.PORT || 3000,
  PYTHON_SERVER: process.env.PYTHON_SERVER_URL || "http://localhost:5001",
  RAPID_RISE_THRESHOLD: 0.5,
  TOKEN_SYNC_INTERVAL: 30000,
  DANGER_ALERT_INTERVAL: 120000
};

// =============================
// KHỞI TẠO CƠ SỞ DỮ LIỆU
// =============================

class DatabaseManager {
  constructor() {
    this.mainPool = null;
    this.syncPool = null;
    this.init();
  }

  init() {
    try {
      if (process.env.DATABASE_URL) {
        // Môi trường Production (Railway/Cloud)
        console.log("🟢 Đang kết nối CSDL Cloud...");
        this.mainPool = new Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: { rejectUnauthorized: false }
        });
      } else {
        // Môi trường Development (Local)
        console.log("🟡 Đang kết nối CSDL Local...");
        this.mainPool = new Pool({
          user: process.env.DB_USER || 'postgres',
          host: process.env.DB_HOST || 'localhost',
          database: process.env.DB_NAME || 'flood_alert_db',
          password: process.env.DB_PASS || 'Quan@',
          port: parseInt(process.env.DB_PORT) || 5432,
        });

        // Kết nối CSDL Cloud để đồng bộ (nếu có)
        if (process.env.RAILWAY_DB_URL) {
          this.syncPool = new Pool({
            connectionString: process.env.RAILWAY_DB_URL,
            ssl: { rejectUnauthorized: false }
          });
          console.log("🟢 Đã kết nối CSDL Cloud để đồng bộ");
        }
      }
    } catch (error) {
      console.error("🔴 Lỗi khởi tạo CSDL:", error.message);
    }
  }

  getMainPool() {
    return this.mainPool;
  }

  getSyncPool() {
    return this.syncPool;
  }
}

// =============================
// QUẢN LÝ FIREBASE
// =============================

class FirebaseManager {
  constructor() {
    this.isInitialized = false;
    this.init();
  }

  init() {
    try {
      if (process.env.SERVICE_ACCOUNT_JSON) {
        console.log("🟢 Khởi tạo Firebase từ biến môi trường...");
        const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        this.isInitialized = true;
      } else {
        const localPath = path.join(__dirname, 'serviceAccountKey.json');
        if (fs.existsSync(localPath)) {
          console.log("🟡 Khởi tạo Firebase từ file local...");
          admin.initializeApp({ credential: admin.credential.cert(localPath) });
          this.isInitialized = true;
        } else {
          console.warn("🟠 Firebase chưa được khởi tạo");
        }
      }
    } catch (error) {
      console.error("🔴 Lỗi khởi tạo Firebase:", error.message);
    }
  }

  isReady() {
    return this.isInitialized && admin.apps.length > 0;
  }
}

// =============================
// QUẢN LÝ TRẠNG THÁI ỨNG DỤNG
// =============================

class AppState {
  constructor() {
    this.fcmTokens = [];
    this.lastSensorData = { 
      mucNuocB: null, 
      luuLuong: null, 
      timestamp: null 
    };
    this.lastAIStatus = "Bình thường";
    this.sentRapidRiseNotification = false;
    this.lastDangerAlertTime = null;
  }

  updateSensorData(mucNuocB, luuLuong) {
    this.lastSensorData = {
      mucNuocB,
      luuLuong,
      timestamp: Date.now()
    };
  }

  shouldSendAlert(newStatus) {
    if (this.fcmTokens.length === 0) {
      console.log("📱 Chưa có FCM token, bỏ qua thông báo");
      return false;
    }
    return this.lastAIStatus !== newStatus;
  }
}

// =============================
// TIỆN ÍCH HỖ TRỢ
// =============================

class HelperUtils {
  static formatCountdown(seconds) {
    if (!seconds || seconds < 0) return null;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    return minutes > 0 ? 
      `${minutes} phút ${remainingSeconds} giây` : 
      `${remainingSeconds} giây`;
  }

  static getNotificationContent(status, countdown) {
    const contentMap = {
      "Bình thường": {
        title: "✅ Tình hình ổn định",
        body: "Tình hình lũ hiện tại ổn định. Tiếp tục theo dõi."
      },
      "Cảnh báo!": {
        title: "⚠️ Cảnh báo Lũ",
        body: "Mực nước đang tăng. Chuẩn bị sẵn sàng các biện pháp phòng ngừa."
      },
      "Cảnh báo Cao!": {
        title: "🔶 Cảnh báo Lũ Cao",
        body: "Mực nước đang tăng nhanh. Sẵn sàng sơ tán nếu cần thiết."
      },
      "Nguy hiểm!": {
        title: "🚨 BÁO ĐỘNG NGUY HIỂM",
        body: "LŨ ĐANG Ở MỨC NGUY HIỂM! CẦN SƠ TÁN NGAY LẬP TỨC!"
      }
    };

    const content = contentMap[status] || {
      title: `Cảnh báo: ${status}`,
      body: `Trạng thái: ${status}`
    };

    const formattedTime = this.formatCountdown(countdown);
    if (formattedTime && status !== "Bình thường") {
      content.body += ` Lũ dự kiến đến Điểm A sau khoảng ${formattedTime}.`;
      if (countdown < 300) {
        content.body += " HÃY DI CHUYỂN ĐẾN NƠI AN TOÀN NGAY!";
      }
    }

    return content;
  }
}

// =============================
// QUẢN LÝ THÔNG BÁO
// =============================

class NotificationService {
  constructor(firebaseManager) {
    this.firebase = firebaseManager;
  }

  async sendMulticastNotification(title, body) {
    if (!this.firebase.isReady()) {
      console.error("🔴 Firebase chưa sẵn sàng");
      return false;
    }

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
      console.log(`📤 Đã gửi thông báo đến ${response.successCount} thiết bị`);
      
      if (response.failureCount > 0) {
        await this.cleanupFailedTokens(response);
      }
      
      return response.successCount > 0;
    } catch (error) {
      console.error("🔴 Lỗi gửi thông báo:", error.message);
      return false;
    }
  }

  async cleanupFailedTokens(response) {
    const tokensToDelete = [];
    
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        const errorCode = resp.error?.code;
        if (errorCode === 'messaging/registration-token-not-registered' || 
            errorCode === 'messaging/invalid-registration-token') {
          tokensToDelete.push(appState.fcmTokens[idx]);
        }
      }
    });

    if (tokensToDelete.length > 0) {
      await this.removeTokensFromDatabase(tokensToDelete);
    }
  }

  async removeTokensFromDatabase(tokens) {
    const db = database.getMainPool() || database.getSyncPool();
    if (!db) return;

    try {
      await db.query("DELETE FROM fcm_tokens WHERE token = ANY($1::text[])", [tokens]);
      console.log(`🗑️ Đã xóa ${tokens.length} token hỏng`);
    } catch (error) {
      console.error("🔴 Lỗi xóa token:", error.message);
    }
  }

  async sendAIStatusNotification(status, countdown) {
    const content = HelperUtils.getNotificationContent(status, countdown);
    console.log(`📤 Gửi thông báo AI: ${status}`);
    return await this.sendMulticastNotification(content.title, content.body);
  }

  async sendRapidRiseNotification(rate) {
    const title = "🌊 Cảnh báo: Nước Dâng Nhanh!";
    const body = `Phát hiện mực nước B đang dâng nhanh (${rate.toFixed(1)} cm/s).`;
    console.log("📤 Gửi thông báo dâng nhanh");
    return await this.sendMulticastNotification(title, body);
  }
}

// =============================
// DỊCH VỤ AI VÀ XỬ LÝ DỮ LIỆU
// =============================

class AIService {
  constructor() {
    this.baseURL = CONFIG.PYTHON_SERVER;
  }

  async predictFloodStatus(data) {
    try {
      const payload = {
        mucNuocA: data.mucNuocA,
        mucNuocB: data.mucNuocB,
        luuLuong: data.luuLuong,
        is_raining_now: data.isRaining ? 1 : 0,
        b_rate_of_change: data.bRateChange,
        flow_rate_of_change: data.flowRateChange,
        ab_diff: data.mucNuocB - data.mucNuocA
      };

      const [statusRes, timeRes] = await Promise.all([
        axios.post(`${this.baseURL}/predict`, payload, { timeout: 6000 }),
        axios.post(`${this.baseURL}/predict_time`, payload, { timeout: 6000 })
      ]);

      return {
        status: statusRes?.data?.prediction || "Lỗi dự đoán",
        time: parseFloat(timeRes?.data?.predicted_seconds) || -1
      };
    } catch (error) {
      console.error("🔴 Lỗi gọi AI:", error.message);
      return { status: "Lỗi dự đoán", time: -1 };
    }
  }
}

// =============================
// KHỞI TẠO HỆ THỐNG
// =============================

const database = new DatabaseManager();
const firebaseManager = new FirebaseManager();
const notificationService = new NotificationService(firebaseManager);
const aiService = new AIService();
const appState = new AppState();

// =============================
// KHỞI TẠO ỨNG DỤNG EXPRESS
// =============================

const app = express();
app.use(express.json());
app.use(cors());
const upload = multer({ dest: path.join(__dirname, 'uploads/') });

// =============================
// KHỞI TẠO CƠ SỞ DỮ LIỆU
// =============================

async function initializeDatabase() {
  const createTablesSQL = `
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
    
    CREATE TABLE IF NOT EXISTS fcm_tokens (
      id SERIAL PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `;

  try {
    const mainPool = database.getMainPool();
    const syncPool = database.getSyncPool();

    if (mainPool) {
      await mainPool.query(createTablesSQL);
      console.log("🟢 CSDL chính đã sẵn sàng");
    }

    if (syncPool) {
      await syncPool.query(createTablesSQL);
      console.log("🟢 CSDL đồng bộ đã sẵn sàng");
    }
  } catch (error) {
    console.error("🔴 Lỗi khởi tạo bảng:", error.message);
  }
}

// =============================
// ĐỒNG BỘ TOKEN TỪ CLOUD
// =============================

async function syncTokensFromCloud() {
  const syncPool = database.getSyncPool();
  if (!syncPool) return;

  try {
    const result = await syncPool.query("SELECT token FROM fcm_tokens ORDER BY id DESC");
    const cloudTokens = result.rows.map(row => row.token);
    
    if (JSON.stringify(cloudTokens) !== JSON.stringify(appState.fcmTokens)) {
      console.log(`🔄 Đã đồng bộ ${cloudTokens.length} token từ Cloud`);
      appState.fcmTokens = cloudTokens;
    }
  } catch (error) {
    console.error("🔴 Lỗi đồng bộ token:", error.message);
  }
}

// =============================
// ĐỊNH NGHĨA API ENDPOINTS
// =============================

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.DATABASE_URL ? 'production' : 'development'
  });
});

// Đăng ký FCM token
app.post('/api/register_fcm_token', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Thiếu token' });
    }

    const mainPool = database.getMainPool();
    if (!mainPool) {
      return res.status(500).json({ error: 'CSDL chưa sẵn sàng' });
    }

    await mainPool.query(
      "INSERT INTO fcm_tokens (token) VALUES ($1) ON CONFLICT (token) DO NOTHING",
      [token]
    );

    console.log(`✅ Đã đăng ký token: ${token.substring(0, 20)}...`);
    res.json({ message: 'Token đã được lưu' });
  } catch (error) {
    console.error("🔴 Lỗi đăng ký token:", error.message);
    res.status(500).json({ error: 'Lỗi server' });
  }
});

// API cập nhật dữ liệu cảm biến
app.post('/update', async (req, res) => {
  try {
    const { mucNuocA, mucNuocB, luuLuong, isRaining, trangThai, thongBao, time_until_a_danger } = req.body;

    // Validate dữ liệu đầu vào
    const validatedData = this.validateSensorData(req.body);
    if (!validatedData.valid) {
      return res.status(400).json({ error: validatedData.error });
    }

    // Tính toán tốc độ thay đổi
    const rateData = this.calculateRateOfChange(validatedData.data);

    // Xử lý cảnh báo dâng nhanh (chỉ local)
    if (!process.env.DATABASE_URL) {
      await this.handleRapidRiseAlert(rateData.bRateChange);
    }

    // Gọi AI dự đoán (chỉ local)
    let aiPrediction = { status: "Bình thường", time: -1 };
    if (!process.env.DATABASE_URL) {
      aiPrediction = await aiService.predictFloodStatus({
        ...validatedData.data,
        ...rateData
      });
      
      await this.handleAINotification(aiPrediction);
    }

    // Lưu dữ liệu vào CSDL
    await this.saveSensorData(validatedData.data, aiPrediction, {
      trangThai, thongBao, time_until_a_danger
    });

    // Cập nhật trạng thái
    appState.updateSensorData(validatedData.data.mucNuocB, validatedData.data.luuLuong);

    res.json({
      message: 'Dữ liệu đã được cập nhật',
      prediction_status: aiPrediction.status,
      prediction_time: aiPrediction.time
    });

  } catch (error) {
    console.error("🔴 Lỗi xử lý dữ liệu:", error.message);
    res.status(500).json({ error: 'Lỗi server' });
  }
});

// Helper methods cho endpoint /update
const updateEndpointHelpers = {
  validateSensorData(body) {
    const mucNuocA = parseFloat(body.mucNuocA);
    const mucNuocB = parseFloat(body.mucNuocB);
    const luuLuong = parseFloat(body.luuLuong);
    const isRaining = body.isRaining === true || body.isRaining === 'true';

    if (isNaN(mucNuocA) || isNaN(mucNuocB) || isNaN(luuLuong)) {
      return { valid: false, error: 'Dữ liệu cảm biến không hợp lệ' };
    }

    return {
      valid: true,
      data: { mucNuocA, mucNuocB, luuLuong, isRaining }
    };
  },

  calculateRateOfChange(currentData) {
    const { lastSensorData } = appState;
    let bRateChange = 0;
    let flowRateChange = 0;

    if (lastSensorData.timestamp) {
      const timeDiff = (Date.now() - lastSensorData.timestamp) / 1000;
      if (timeDiff > 0) {
        bRateChange = (currentData.mucNuocB - (lastSensorData.mucNuocB || currentData.mucNuocB)) / timeDiff;
        flowRateChange = (currentData.luuLuong - (lastSensorData.luuLuong || currentData.luuLuong)) / timeDiff;
      }
    }

    return { bRateChange, flowRateChange };
  },

  async handleRapidRiseAlert(rate) {
    if (rate > CONFIG.RAPID_RISE_THRESHOLD && !appState.sentRapidRiseNotification) {
      await notificationService.sendRapidRiseNotification(rate);
      appState.sentRapidRiseNotification = true;
    } else if (rate <= 0 && appState.sentRapidRiseNotification) {
      appState.sentRapidRiseNotification = false;
    }
  },

  async handleAINotification(prediction) {
    if (appState.shouldSendAlert(prediction.status)) {
      await notificationService.sendAIStatusNotification(prediction.status, prediction.time);
      appState.lastAIStatus = prediction.status;
      
      // Xử lý cảnh báo nguy hiểm định kỳ
      if (prediction.status === "Nguy hiểm!") {
        await this.handleDangerAlert(prediction);
      } else {
        appState.lastDangerAlertTime = null;
      }
    }
  },

  async handleDangerAlert(prediction) {
    const now = Date.now();
    if (!appState.lastDangerAlertTime || (now - appState.lastDangerAlertTime) > CONFIG.DANGER_ALERT_INTERVAL) {
      await notificationService.sendAIStatusNotification(prediction.status, prediction.time);
      appState.lastDangerAlertTime = now;
    }
  },

  async saveSensorData(sensorData, aiPrediction, additionalData) {
    const sql = `
      INSERT INTO sensor_data 
      (mucNuocA, mucNuocB, luuLuong, trangThai, thongBao, created_at, 
       predicted_trangthai, time_until_a_danger, predicted_time_to_a, is_raining) 
      VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9)
    `;

    const values = [
      sensorData.mucNuocA,
      sensorData.mucNuocB,
      sensorData.luuLuong,
      additionalData.trangThai,
      additionalData.thongBao,
      aiPrediction.status,
      HelperUtils.formatCountdown(additionalData.time_until_a_danger || aiPrediction.time),
      aiPrediction.time >= 0 ? aiPrediction.time : null,
      sensorData.isRaining
    ];

    const savePromises = [];
    const mainPool = database.getMainPool();
    const syncPool = database.getSyncPool();

    if (mainPool) {
      savePromises.push(mainPool.query(sql, values));
    }

    if (syncPool) {
      savePromises.push(syncPool.query(sql, values));
    }

    await Promise.allSettled(savePromises);
    console.log(`💾 Đã lưu dữ liệu cảm biến: B=${sensorData.mucNuocB.toFixed(1)}`);
  }
};

// Gán helpers cho endpoint
Object.assign(app.post('/update', async (req, res) => {
  // ... implementation sẽ sử dụng các helpers above
}), updateEndpointHelpers);

// Lấy dữ liệu mới nhất
app.get('/data', async (req, res) => {
  try {
    const mainPool = database.getMainPool();
    if (!mainPool) {
      return res.status(500).json({ error: 'CSDL chưa sẵn sàng' });
    }

    const result = await mainPool.query(
      'SELECT * FROM sensor_data ORDER BY id DESC LIMIT 1'
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: 'Chưa có dữ liệu' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("🔴 Lỗi lấy dữ liệu:", error.message);
    res.status(500).json({ error: 'Lỗi server' });
  }
});

// Dữ liệu biểu đồ
app.get('/api/chart_data', async (req, res) => {
  try {
    const mainPool = database.getMainPool();
    if (!mainPool) {
      return res.status(500).json({ error: 'CSDL chưa sẵn sàng' });
    }

    const result = await mainPool.query(`
      SELECT id, mucnuoca, mucnuocb, luuluong, predicted_trangthai, created_at
      FROM sensor_data
      ORDER BY id DESC
      LIMIT 300
    `);

    res.json((result.rows || []).reverse());
  } catch (error) {
    console.error("🔴 Lỗi lấy dữ liệu biểu đồ:", error.message);
    res.status(500).json({ error: 'Lỗi server' });
  }
});

// Lịch sử theo ngày
app.get('/api/history_by_date', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Định dạng ngày không hợp lệ (YYYY-MM-DD)' });
    }

    const mainPool = database.getMainPool();
    if (!mainPool) {
      return res.status(500).json({ error: 'CSDL chưa sẵn sàng' });
    }

    const result = await mainPool.query(
      `SELECT * FROM sensor_data 
       WHERE (created_at AT TIME ZONE '+07')::date = $1 
       ORDER BY id DESC`,
      [date]
    );

    res.json(result.rows || []);
  } catch (error) {
    console.error("🔴 Lỗi lấy lịch sử:", error.message);
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
// KHỞI CHẠY MÁY CHỦ
// =============================

async function startServer() {
  // Khởi tạo CSDL
  await initializeDatabase();

  // Khởi chạy server
  app.listen(CONFIG.PORT, () => {
    console.log('\n' + '='.repeat(50));
    console.log(`🚀 MÁY CHỦ BÁO ĐỘNG LŨ ĐÃ KHỞI ĐỘNG`);
    console.log('='.repeat(50));
    console.log(`📍 Port: ${CONFIG.PORT}`);
    console.log(`🧠 Server AI: ${CONFIG.PYTHON_SERVER}`);
    console.log(`🌍 Môi trường: ${process.env.DATABASE_URL ? 'Production' : 'Development'}`);
    console.log(`📱 Firebase: ${firebaseManager.isReady() ? '🟢 Sẵn sàng' : '🟠 Chưa sẵn sàng'}`);
    console.log(`💾 CSDL: ${database.getMainPool() ? '🟢 Đã kết nối' : '🔴 Lỗi kết nối'}`);
    
    // Đồng bộ token nếu chạy local
    if (database.getSyncPool()) {
      console.log(`🔄 Chế độ đồng bộ: Bật (30 giây/lần)`);
      setInterval(syncTokensFromCloud, CONFIG.TOKEN_SYNC_INTERVAL);
      syncTokensFromCloud();
    }
    
    console.log('='.repeat(50) + '\n');
  });
}

// Xử lý lỗi toàn cục
process.on('unhandledRejection', (error) => {
  console.error('🔴 Lỗi không được xử lý:', error.message);
});

process.on('uncaughtException', (error) => {
  console.error('🔴 Lỗi nghiêm trọng:', error.message);
  process.exit(1);
});

// Khởi động hệ thống
startServer().catch(error => {
  console.error('🔴 Lỗi khởi động server:', error.message);
  process.exit(1);
});