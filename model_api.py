from flask import Flask, request, jsonify
import joblib
import pandas as pd

app = Flask(__name__)

# ===== SỬA 1: ĐỊNH NGHĨA 7 ĐẶC TRƯNG MỚI =====
MODEL_FEATURES = [
    'mucnuoca',
    'mucnuocb',
    'luuluong',
    'is_raining_now',        # <-- THÊM MỚI (0 hoặc 1)
    'b_rate_of_change',
    'flow_rate_of_change',
    'ab_diff'
]
# ========================================

# (Load model - Giữ nguyên)
try: class_model = joblib.load('flood_model.pkl'); print("✅ Load Class Model OK")
except Exception as e: print(f"❌ Lỗi load Class Model: {e}"); class_model = None
try: time_model = joblib.load('time_model.pkl'); print("✅ Load Time Model OK")
except Exception as e: print(f"❌ Lỗi load Time Model: {e}"); time_model = None

# API CẢNH BÁO
@app.route('/predict', methods=['POST'])
def predict():
    if class_model is None: return jsonify({'error': 'Class model chưa load'}), 500
    try:
        data = request.json
        # ===== SỬA 2: LẤY 7 GIÁ TRỊ TỪ PAYLOAD =====
        input_values = [
            data['mucNuocA'],
            data['mucNuocB'],
            data['luuLuong'],
            data['is_raining_now'],        # <-- THÊM MỚI
            data['b_rate_of_change'],
            data['flow_rate_of_change'],
            data['ab_diff']
        ]
        # ======================================

        input_df = pd.DataFrame([input_values], columns=MODEL_FEATURES)
        prediction = class_model.predict(input_df)
        return jsonify({'prediction': prediction[0]})
    except Exception as e: return jsonify({'error': str(e)}), 400

# API ĐẾM NGƯỢC
@app.route('/predict_time', methods=['POST'])
def predict_time():
    if time_model is None: return jsonify({'error': 'Time model chưa load'}), 500
    try:
        data = request.json
        # ===== SỬA 3: LẤY 7 GIÁ TRỊ TỪ PAYLOAD =====
        input_values = [
            data['mucNuocA'],
            data['mucNuocB'],
            data['luuLuong'],
            data['is_raining_now'],        # <-- THÊM MỚI
            data['b_rate_of_change'],
            data['flow_rate_of_change'],
            data['ab_diff']
        ]
        # ======================================

        input_df = pd.DataFrame([input_values], columns=MODEL_FEATURES)
        time_prediction = time_model.predict(input_df)
        predicted_seconds = max(0, float(time_prediction[0]))
        return jsonify({'predicted_seconds': predicted_seconds})
    except Exception as e: return jsonify({'error': str(e)}), 400

if __name__ == '__main__':
    print("🚀 API dự đoán AI (7-features, Rain ON/OFF) đang chạy tại http://localhost:5001")
    app.run(port=5001)