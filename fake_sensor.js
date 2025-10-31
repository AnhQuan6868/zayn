// ======================================
//  GIẢ LẬP CẢM BIĚN (Phiên bản 3.6)
//  (Dùng Cảm biến Mưa Bật/Tắt - Đã khôi phục log A/B)
// ======================================
const axios = require('axios');
const SERVER_URL = 'http://localhost:3000/update';

// ----- CÁC THAM SỐ (Giữ nguyên) -----
const BASE_MUC_NUOC_A = 5;  // cm
const BASE_MUC_NUOC_B = 4;  // cm
const BASE_LUU_LUONG = 2;  // m³/s
const PEAK_MUC_NUOC_A = 30; // cm
const PEAK_MUC_NUOC_B = 28; // cm
const PEAK_LUU_LUONG = 15; // m³/s
const DANGER_LEVEL_A = 28.0;
const DANGER_LEVEL_B = 25.0;
const DANGER_LEVEL_B_PEAK = 28.0;
const RAIN_DURATION_STEPS = 10; // 20s
const FLOOD_RISE_TIME = 30; // 60s
const FLOOD_PEAK_TIME = 15; // 30s
const FLOOD_FALL_TIME = 30; // 60s
const A_LAG_TIME_STEPS = 15; // 30s
const UPDATE_INTERVAL_MS = 2000;
// ------------------------------------------

// --- TÍNH TOÁN TRƯỚC (Giữ nguyên) ---
const B_RISE_PER_STEP = (PEAK_MUC_NUOC_B - BASE_MUC_NUOC_B) / FLOOD_RISE_TIME;
const B_STEPS_TO_DANGER = (DANGER_LEVEL_B - BASE_MUC_NUOC_B) / B_RISE_PER_STEP;
const A_TOTAL_STEPS_TO_DANGER = RAIN_DURATION_STEPS + B_STEPS_TO_DANGER + A_LAG_TIME_STEPS;

// Biến trạng thái
let currentState = 'NORMAL';
let dangerCountdown = 0;
let stateStepCounter = 0;
let currentA = BASE_MUC_NUOC_A;
let currentB = BASE_MUC_NUOC_B;
let currentLuuLuong = BASE_LUU_LUONG;
let isRaining = false;
let b_history_queue = [];
let lastLoggedAState = 'Bình thường';
let lastLoggedBState = 'Bình thường'; // Khôi phục biến này

const args = process.argv.slice(2);
if (args.includes('--flood')) {
    currentState = 'RAINING';
    isRaining = true;
    stateStepCounter = 0;
    dangerCountdown = A_TOTAL_STEPS_TO_DANGER;
    console.warn(`\n🌧️ BẮT ĐẦU MƯA! (A sẽ nguy hiểm sau ${dangerCountdown.toFixed(0)} bước)\n`);
}

function generateRealisticData() {

    // --- BỘ MÁY TRẠNG THÁI (Giữ nguyên) ---
    if (currentState === 'NORMAL' && Math.random() < 0.001) {
        currentState = 'RAINING'; isRaining = true; stateStepCounter = 0;
        dangerCountdown = A_TOTAL_STEPS_TO_DANGER;
        console.warn(`\n🌧️ CÓ MƯA NGẪU NHIÊN! (A sẽ nguy hiểm sau ${dangerCountdown.toFixed(0)} bước)\n`);
    }

    switch (currentState) {
        case 'RAINING':
            if (++stateStepCounter >= RAIN_DURATION_STEPS) {
                 currentState = 'RISING'; stateStepCounter = 0;
                 console.warn(`\n🌊 NƯỚC BẮT ĐẦU DÂNG! (Vẫn đang mưa...)\n`);
            }
            break;
        case 'RISING':
            let rise_remaining = FLOOD_RISE_TIME - stateStepCounter;
            if (rise_remaining > 0) {
                currentB += (PEAK_MUC_NUOC_B - currentB) / rise_remaining;
                currentLuuLuong += (PEAK_LUU_LUONG - currentLuuLuong) / rise_remaining;
            }
            if (++stateStepCounter >= FLOOD_RISE_TIME) { currentState = 'PEAK'; stateStepCounter = 0; }
            break;
        case 'PEAK':
            currentB = PEAK_MUC_NUOC_B + (Math.random() - 0.5) * 2;
            currentLuuLuong = PEAK_LUU_LUONG + (Math.random() - 0.5) * 3;
             if (++stateStepCounter >= FLOOD_PEAK_TIME) { currentState = 'FALLING'; stateStepCounter = 0; }
            break;
        case 'FALLING':
            let fall_remaining = FLOOD_FALL_TIME - stateStepCounter;
            if (fall_remaining > 0) {
                currentB -= (currentB - BASE_MUC_NUOC_B) / fall_remaining;
                currentLuuLuong -= (currentLuuLuong - BASE_LUU_LUONG) / fall_remaining;
            } else { isRaining = false; } // Tắt mưa khi nước gần rút xong
            if (++stateStepCounter >= FLOOD_FALL_TIME) {
                 currentState = 'NORMAL'; stateStepCounter = 0;
                 dangerCountdown = 0; isRaining = false;
            }
            break;
        default: // NORMAL
            currentA += (Math.random() - 0.5) * 0.5; currentA -= (currentA - BASE_MUC_NUOC_A) * 0.1;
            currentB += (Math.random() - 0.5) * 0.5; currentLuuLuong += (Math.random() - 0.5) * 0.2;
            currentB -= (currentB - BASE_MUC_NUOC_B) * 0.1; currentLuuLuong -= (currentLuuLuong - BASE_LUU_LUONG) * 0.1;
            isRaining = false;
            break;
    }

    // --- LOGIC A (Giữ nguyên) ---
    b_history_queue.push(currentB);
    if (b_history_queue.length > A_LAG_TIME_STEPS) { currentA = b_history_queue.shift(); }
    else { currentA += (Math.random() - 0.5) * 0.5; currentA -= (currentA - BASE_MUC_NUOC_A) * 0.1; }

    // --- Countdown (Giữ nguyên) ---
    let thoiGianConLai = null;
    if (currentState !== 'NORMAL') { dangerCountdown--; thoiGianConLai = Math.max(0, dangerCountdown * (UPDATE_INTERVAL_MS / 1000)); }

    // --- Cảnh báo App (Dựa trên A - Giữ nguyên) ---
    let trangThai = 'Bình thường'; let thongBao = 'An toàn';
    if (currentA > DANGER_LEVEL_A) { trangThai = 'Nguy hiểm!'; thongBao = `Mực nước A VƯỢT NGƯỠNG ${DANGER_LEVEL_A}cm!`;}
    else if (currentA > 25) { trangThai = 'Cảnh báo Cao!'; thongBao = 'Mực nước A trên 25cm!'; }
    else if (currentA > 20) { trangThai = 'Cảnh báo!'; thongBao = 'Mực nước A trên 20cm!'; }

    // --- LOG TRẠNG THÁI A (KHÔI PHỤC TỪ V3.4) ---
    if (trangThai !== lastLoggedAState) {
        if (trangThai === 'Cảnh báo!') console.warn(`\n🟠 CẢNH BÁO A: ${thongBao} (Mức ${currentA.toFixed(1)}cm)\n`);
        else if (trangThai === 'Cảnh báo Cao!') console.warn(`\n🟧 CẢNH BÁO A: ${thongBao} (Mức ${currentA.toFixed(1)}cm)\n`);
        else if (trangThai === 'Nguy hiểm!') console.error(`\n🟥 NGUY HIỂM A: ${thongBao} (Mức ${currentA.toFixed(1)}cm)\n`);
        // Chỉ log "An Toàn" khi nó vừa chuyển từ trạng thái khác về
        else if (trangThai === 'Bình thường' && lastLoggedAState !== 'Bình thường') console.info(`\n✅ AN TOÀN A: Mực nước A đã rút về ${currentA.toFixed(1)}cm\n`);
        lastLoggedAState = trangThai; // Cập nhật trạng thái đã log
    }
    // ===========================================

    // --- LOG 3 MỨC CHO B (KHÔI PHỤC TỪ V3.4) ---
    let trangThaiB = 'Bình thường';
    if (currentB >= DANGER_LEVEL_B_PEAK) { // >= 28
        trangThaiB = 'Nguy hiểm!';
    } else if (currentB > DANGER_LEVEL_B) { // > 25
        trangThaiB = 'Cảnh báo Cao!';
    } else if (currentB > 20) { // > 20
        trangThaiB = 'Cảnh báo!';
    }

    if (trangThaiB !== lastLoggedBState) {
        if (trangThaiB === 'Cảnh báo!') console.warn(`\n🟡 CẢNH BÁO B: Mực nước B trên 20cm! (Mức ${currentB.toFixed(1)}cm)\n`);
        else if (trangThaiB === 'Cảnh báo Cao!') console.warn(`\n🟠 CẢNH BÁO B: Mực nước B trên 25cm! (Mức ${currentB.toFixed(1)}cm)\n`);
        else if (trangThaiB === 'Nguy hiểm!') console.error(`\n🔴 NGUY HIỂM B: Mực nước B đạt đỉnh ${DANGER_LEVEL_B_PEAK}cm! (Mức ${currentB.toFixed(1)}cm)\n`);
         // Chỉ log "An Toàn" khi nó vừa chuyển từ trạng thái khác về
        else if (trangThaiB === 'Bình thường' && lastLoggedBState !== 'Bình thường') console.info(`\n\n🟢 AN TOÀN B: Mực nước B đã rút.\n`);
        lastLoggedBState = trangThaiB; // Cập nhật trạng thái đã log
    }
    // =============================================

    // Đảm bảo không âm và không vượt đỉnh
    currentA = Math.min(PEAK_MUC_NUOC_A, Math.max(0, currentA));
    currentB = Math.min(PEAK_MUC_NUOC_B, Math.max(0, currentB));

    return {
        mucNuocA: currentA.toFixed(1),
        mucNuocB: currentB.toFixed(1),
        luuLuong: currentLuuLuong.toFixed(2),
        isRaining: isRaining, // Dữ liệu mưa Bật/Tắt
        trangThai: trangThai,
        thongBao: thongBao,
        time_until_a_danger: thoiGianConLai
    };
}

// --- LOG CONSOLE (Thêm Trạng thái Mưa) ---
setInterval(async () => {
    const data = generateRealisticData();
    try {
        await axios.post(SERVER_URL, data);
        const countdownLog = data.time_until_a_danger === null ? 'N/A' : data.time_until_a_danger.toFixed(0) + 's';
        console.log(`✅ Gửi (A: ${data.mucNuocA}, B: ${data.mucNuocB}, Mưa: ${data.isRaining ? 'CÓ':'KO'}, Flow: ${data.luuLuong}, Countdown: ${countdownLog})`);
    } catch (err) {
        console.error(`❌ Lỗi khi gửi dữ liệu:`, err.message);
    }
}, UPDATE_INTERVAL_MS);