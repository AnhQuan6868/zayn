from flask import Flask, request, jsonify
import joblib
import pandas as pd
import os
import numpy as np
from datetime import datetime, date

app = Flask(__name__)

# 🎯 MODEL FEATURES NÂNG CAO (12 features)
MODEL_FEATURES = [
    'mucnuoca', 'mucnuocb', 'luuluong', 'is_raining_now',
    'b_rate_of_change', 'flow_rate_of_change', 'ab_diff', 
    'ab_ratio', 'b_absolute_change', 'b_total_rise', 'danger_index', 'b_trend'
]

def convert_time_to_seconds(time_str):
    """
    Chuyển đổi chuỗi thời gian 'X phút Y giây' thành số giây
    """
    if pd.isna(time_str) or time_str == '' or time_str is None:
        return 0.0
    
    try:
        return float(time_str)
    except:
        pass
    
    try:
        time_str = str(time_str).strip()
        if 'phút' in time_str and 'giây' in time_str:
            parts = time_str.split()
            minutes = 0
            seconds = 0
            
            for i in range(len(parts)):
                if parts[i] == 'phút':
                    minutes = float(parts[i-1])
                elif parts[i] == 'giây':
                    seconds = float(parts[i-1])
            
            return minutes * 60 + seconds
        elif 'giây' in time_str:
            parts = time_str.split()
            for i in range(len(parts)):
                if parts[i] == 'giây':
                    return float(parts[i-1])
        else:
            return float(time_str)
    except:
        return 0.0

def format_seconds_to_time(seconds):
    """
    Định dạng số giây thành chuỗi 'X phút Y giây'
    """
    seconds = max(0, float(seconds))
    minutes = int(seconds // 60)
    remaining_seconds = int(seconds % 60)
    
    if minutes > 0:
        return f"{minutes} phút {remaining_seconds} giây"
    else:
        return f"{remaining_seconds} giây"

def calculate_danger_index(mucNuocA, mucNuocB, b_rate_of_change, b_absolute_change, ab_diff):
    """
    Tính chỉ số nguy hiểm tổng hợp
    """
    return (
        (mucNuocB * 0.3) + 
        (abs(b_rate_of_change) * 2.0) + 
        (abs(b_absolute_change) * 0.5) +
        (ab_diff * 0.2)
    )

def safe_float(value, default=0.0):
    """Chuyển đổi an toàn sang float"""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default

def safe_int(value, default=0):
    """Chuyển đổi an toàn sang int"""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default

def load_today_models():
    """
    Load model mới nhất được train trên dữ liệu ngày hôm nay
    """
    try:
        class_model = None
        time_model = None
        
        # Ưu tiên load model today, nếu không có thì load model mới nhất
        model_files = {
            'classification': ['flood_model_today.pkl', 'flood_model.pkl'],
            'regression': ['time_model_today.pkl', 'time_model.pkl']
        }
        
        # Load classification model
        for model_file in model_files['classification']:
            if os.path.exists(model_file):
                class_model = joblib.load(model_file)
                print(f"✅ Load classification model: {model_file}")
                break
        
        # Load regression model  
        for model_file in model_files['regression']:
            if os.path.exists(model_file):
                time_model = joblib.load(model_file)
                print(f"✅ Load regression model: {model_file}")
                break
        
        if class_model is None:
            print("❌ Không tìm thấy classification model")
        if time_model is None:
            print("❌ Không tìm thấy regression model")
            
        return class_model, time_model
        
    except Exception as e:
        print(f"❌ Lỗi load model: {e}")
        return None, None

# Load model khi khởi động
class_model, time_model = load_today_models()
today_date = date.today().strftime('%Y-%m-%d')

print(f"🚀 API dự đoán AI NÂNG CAO (MODEL NGÀY {today_date}) đang chạy...")
print(f"🔧 Model features: {MODEL_FEATURES}")
print(f"🔧 Classification model: {'✅ Loaded' if class_model else '❌ Not loaded'}")
print(f"🔧 Regression model: {'✅ Loaded' if time_model else '❌ Not loaded'}")

@app.route('/')
def home():
    """Trang chủ API"""
    return jsonify({
        'message': 'Flood Prediction API - Enhanced Model',
        'version': '2.0',
        'model_date': today_date,
        'features': '12 đặc trưng nâng cao',
        'status': 'ready' if (class_model and time_model) else 'models_missing',
        'endpoints': {
            'POST /predict': 'Dự đoán trạng thái cảnh báo',
            'POST /predict_time': 'Dự đoán thời gian lũ về',
            'GET /model_info': 'Thông tin model',
            'POST /reload_models': 'Reload model mới',
            'GET /health': 'Health check'
        }
    })

@app.route('/predict', methods=['POST'])
def predict():
    """Dự đoán trạng thái cảnh báo với model NÂNG CAO"""
    if class_model is None:
        return jsonify({'error': 'Classification model chưa load'}), 500
        
    try:
        data = request.json
        
        # DEBUG: Log dữ liệu nhận được
        print(f"📥 [PREDICT] Received data keys: {list(data.keys()) if data else 'No data'}")
        
        # 🎯 XỬ LÝ FEATURES VỚI GIÁ TRỊ MẶC ĐỊNH AN TOÀN
        # Features cơ bản (bắt buộc từ server.js)
        mucNuocA = safe_float(data.get('mucNuocA'), 0)
        mucNuocB = safe_float(data.get('mucNuocB'), 0)
        luuLuong = safe_float(data.get('luuLuong'), 0)
        is_raining_now = safe_int(data.get('is_raining_now'), 0)
        b_rate_of_change = safe_float(data.get('b_rate_of_change'), 0)
        flow_rate_of_change = safe_float(data.get('flow_rate_of_change'), 0)
        ab_diff = safe_float(data.get('ab_diff'), 0)
        b_absolute_change = safe_float(data.get('b_absolute_change'), 0)
        
        # 🎯 TÍNH TOÁN FEATURES NÂNG CAO
        ab_ratio = mucNuocB / (mucNuocA + 0.001)  # Tránh chia cho 0
        b_total_rise = mucNuocB  # Trong thực tế nên tính từ lịch sử
        danger_index = calculate_danger_index(mucNuocA, mucNuocB, b_rate_of_change, b_absolute_change, ab_diff)
        b_trend = mucNuocB  # Đơn giản, có thể cải tiến
        
        # 🎯 CHUẨN BỊ INPUT VALUES CHO MODEL
        input_values = [
            mucNuocA,
            mucNuocB,
            luuLuong,
            is_raining_now,
            b_rate_of_change,
            flow_rate_of_change,
            ab_diff,
            ab_ratio,
            b_absolute_change,
            b_total_rise,
            danger_index,
            b_trend
        ]
        
        print(f"🔧 [PREDICT] Prepared features: {[f'{x:.3f}' for x in input_values]}")
        
        # 🎯 TẠO DATAFRAME VÀ DỰ ĐOÁN
        input_df = pd.DataFrame([input_values], columns=MODEL_FEATURES)
        
        # Kiểm tra số lượng features
        if len(input_values) != class_model.n_features_in_:
            print(f"⚠️ [PREDICT] Số lượng features không khớp: Model cần {class_model.n_features_in_}, nhận được {len(input_values)}")
            # Cố gắng điều chỉnh nếu có thể
            if len(input_values) > class_model.n_features_in_:
                input_values = input_values[:class_model.n_features_in_]
                input_df = pd.DataFrame([input_values], columns=MODEL_FEATURES[:class_model.n_features_in_])
        
        prediction = class_model.predict(input_df)[0]
        prediction_proba = class_model.predict_proba(input_df)[0]
        
        # Lấy xác suất cho từng lớp
        classes = class_model.classes_
        proba_dict = {str(cls): float(prob) for cls, prob in zip(classes, prediction_proba)}
        
        # 🎯 PHÂN TÍCH NGUY HIỂM CHI TIẾT
        danger_analysis = {
            'mucnuocb_level': 'CAO' if mucNuocB > 15 else 'TRUNG BÌNH' if mucNuocB > 10 else 'THẤP',
            'rate_of_change_level': 'CAO' if abs(b_rate_of_change) > 0.3 else 'TRUNG BÌNH' if abs(b_rate_of_change) > 0.1 else 'THẤP',
            'absolute_change_level': 'LỚN' if abs(b_absolute_change) > 5 else 'TRUNG BÌNH' if abs(b_absolute_change) > 2 else 'NHỎ',
            'ab_diff_level': 'LỚN' if ab_diff > 10 else 'TRUNG BÌNH' if ab_diff > 5 else 'NHỎ',
            'danger_index': float(danger_index),
            'risk_assessment': 'RẤT NGUY HIỂM' if danger_index > 20 else 'NGUY HIỂM' if danger_index > 15 else 'CẢNH BÁO' if danger_index > 10 else 'THEO DÕI' if danger_index > 5 else 'AN TOÀN'
        }
        
        # 🎯 LOG KẾT QUẢ
        print(f"✅ [PREDICT] Prediction: {prediction}, Confidence: {max(prediction_proba):.3f}")
        print(f"🔍 [PREDICT] Danger Analysis: {danger_analysis}")
        
        return jsonify({
            'prediction': prediction,
            'confidence': proba_dict,
            'danger_analysis': danger_analysis,
            'model_type': 'ENHANCED_MODEL',
            'model_date': today_date,
            'features_used': MODEL_FEATURES[:len(input_values)],
            'input_summary': {
                'mucNuocA': mucNuocA,
                'mucNuocB': mucNuocB,
                'luuLuong': luuLuong,
                'b_rate_of_change': b_rate_of_change,
                'b_absolute_change': b_absolute_change,
                'ab_diff': ab_diff
            },
            'message': f'Dự đoán từ model NÂNG CAO - {danger_analysis["risk_assessment"]}'
        })
        
    except Exception as e:
        error_msg = f'Lỗi dự đoán: {str(e)}'
        print(f"❌ [PREDICT] {error_msg}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': error_msg}), 400

@app.route('/predict_time', methods=['POST'])
def predict_time():
    """Dự đoán thời gian lũ về với model NÂNG CAO"""
    if time_model is None:
        return jsonify({'error': 'Time prediction model chưa load'}), 500
        
    try:
        data = request.json
        
        # DEBUG: Log dữ liệu nhận được
        print(f"📥 [PREDICT_TIME] Received data keys: {list(data.keys()) if data else 'No data'}")
        
        # 🎯 XỬ LÝ FEATURES VỚI GIÁ TRỊ MẶC ĐỊNH AN TOÀN
        mucNuocA = safe_float(data.get('mucNuocA'), 0)
        mucNuocB = safe_float(data.get('mucNuocB'), 0)
        luuLuong = safe_float(data.get('luuLuong'), 0)
        is_raining_now = safe_int(data.get('is_raining_now'), 0)
        b_rate_of_change = safe_float(data.get('b_rate_of_change'), 0)
        flow_rate_of_change = safe_float(data.get('flow_rate_of_change'), 0)
        ab_diff = safe_float(data.get('ab_diff'), 0)
        b_absolute_change = safe_float(data.get('b_absolute_change'), 0)
        
        # 🎯 TÍNH TOÁN FEATURES NÂNG CAO
        ab_ratio = mucNuocB / (mucNuocA + 0.001)
        b_total_rise = mucNuocB
        danger_index = calculate_danger_index(mucNuocA, mucNuocB, b_rate_of_change, b_absolute_change, ab_diff)
        b_trend = mucNuocB
        
        # 🎯 CHUẨN BỊ INPUT VALUES
        input_values = [
            mucNuocA,
            mucNuocB,
            luuLuong,
            is_raining_now,
            b_rate_of_change,
            flow_rate_of_change,
            ab_diff,
            ab_ratio,
            b_absolute_change,
            b_total_rise,
            danger_index,
            b_trend
        ]
        
        print(f"🔧 [PREDICT_TIME] Prepared features: {[f'{x:.3f}' for x in input_values]}")
        
        # 🎯 TẠO DATAFRAME VÀ DỰ ĐOÁN
        input_df = pd.DataFrame([input_values], columns=MODEL_FEATURES)
        
        # Kiểm tra số lượng features
        if len(input_values) != time_model.n_features_in_:
            print(f"⚠️ [PREDICT_TIME] Số lượng features không khớp: Model cần {time_model.n_features_in_}, nhận được {len(input_values)}")
            if len(input_values) > time_model.n_features_in_:
                input_values = input_values[:time_model.n_features_in_]
                input_df = pd.DataFrame([input_values], columns=MODEL_FEATURES[:time_model.n_features_in_])
        
        time_prediction = time_model.predict(input_df)
        predicted_seconds = max(0, float(time_prediction[0]))
        
        # Format kết quả
        formatted_time = format_seconds_to_time(predicted_seconds)
        
        # 🎯 ĐÁNH GIÁ MỨC ĐỘ CẢNH BÁO
        warning_level = "Bình thường"
        warning_color = "green"
        if predicted_seconds <= 30:
            warning_level = "NGUY HIỂM"
            warning_color = "red"
        elif predicted_seconds <= 60:
            warning_level = "Cảnh báo cao"
            warning_color = "orange"
        elif predicted_seconds <= 120:
            warning_level = "Cảnh báo"
            warning_color = "yellow"
        
        # 🎯 LOG KẾT QUẢ
        print(f"✅ [PREDICT_TIME] Predicted: {predicted_seconds:.1f}s -> {formatted_time} ({warning_level})")
        
        return jsonify({
            'predicted_seconds': predicted_seconds,
            'formatted_time': formatted_time,
            'warning_level': warning_level,
            'warning_color': warning_color,
            'danger_index': float(danger_index),
            'model_type': 'ENHANCED_MODEL',
            'model_date': today_date,
            'features_used': MODEL_FEATURES[:len(input_values)],
            'input_summary': {
                'mucNuocB': mucNuocB,
                'b_rate_of_change': b_rate_of_change,
                'b_absolute_change': b_absolute_change
            },
            'message': f'Dự đoán thời gian: {formatted_time} - {warning_level}'
        })
        
    except Exception as e:
        error_msg = f'Lỗi dự đoán thời gian: {str(e)}'
        print(f"❌ [PREDICT_TIME] {error_msg}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': error_msg}), 400

@app.route('/batch_predict', methods=['POST'])
def batch_predict():
    """Dự đoán hàng loạt - cả classification và regression"""
    if class_model is None or time_model is None:
        return jsonify({'error': 'Model chưa load đầy đủ'}), 500
        
    try:
        data = request.json
        
        if 'samples' not in data:
            return jsonify({'error': 'Thiếu key "samples" trong request'}), 400
        
        results = []
        
        for i, sample in enumerate(data['samples']):
            try:
                # Xử lý features với giá trị mặc định
                mucNuocA = safe_float(sample.get('mucNuocA'), 0)
                mucNuocB = safe_float(sample.get('mucNuocB'), 0)
                luuLuong = safe_float(sample.get('luuLuong'), 0)
                is_raining_now = safe_int(sample.get('is_raining_now'), 0)
                b_rate_of_change = safe_float(sample.get('b_rate_of_change'), 0)
                flow_rate_of_change = safe_float(sample.get('flow_rate_of_change'), 0)
                ab_diff = safe_float(sample.get('ab_diff'), 0)
                b_absolute_change = safe_float(sample.get('b_absolute_change'), 0)
                
                # Tính features nâng cao
                ab_ratio = mucNuocB / (mucNuocA + 0.001)
                b_total_rise = mucNuocB
                danger_index = calculate_danger_index(mucNuocA, mucNuocB, b_rate_of_change, b_absolute_change, ab_diff)
                b_trend = mucNuocB
                
                input_values = [
                    mucNuocA, mucNuocB, luuLuong, is_raining_now,
                    b_rate_of_change, flow_rate_of_change, ab_diff,
                    ab_ratio, b_absolute_change, b_total_rise, danger_index, b_trend
                ]
                
                # Điều chỉnh số lượng features nếu cần
                if len(input_values) > class_model.n_features_in_:
                    input_values = input_values[:class_model.n_features_in_]
                
                input_df = pd.DataFrame([input_values], columns=MODEL_FEATURES[:len(input_values)])
                
                # Dự đoán cả hai model
                class_prediction = class_model.predict(input_df)[0]
                time_prediction = time_model.predict(input_df)[0]
                predicted_seconds = max(0, float(time_prediction))
                formatted_time = format_seconds_to_time(predicted_seconds)
                
                results.append({
                    'sample_id': i,
                    'status_prediction': class_prediction,
                    'time_prediction_seconds': predicted_seconds,
                    'formatted_time': formatted_time,
                    'danger_index': float(danger_index),
                    'success': True
                })
                
            except Exception as e:
                results.append({
                    'sample_id': i,
                    'success': False,
                    'error': str(e)
                })
        
        return jsonify({
            'results': results,
            'total_samples': len(data['samples']),
            'successful_predictions': len([r for r in results if r['success']]),
            'model_date': today_date
        })
        
    except Exception as e:
        return jsonify({'error': f'Lỗi batch prediction: {str(e)}'}), 400

@app.route('/model_info', methods=['GET'])
def model_info():
    """Thông tin về model hiện tại"""
    class_model_info = {
        'loaded': class_model is not None,
        'type': 'Classification - Enhanced',
        'classes': class_model.classes_.tolist() if class_model else None,
        'n_features': class_model.n_features_in_ if class_model else None,
        'features_expected': MODEL_FEATURES,
        'features_actual': MODEL_FEATURES[:class_model.n_features_in_] if class_model else None
    }
    
    time_model_info = {
        'loaded': time_model is not None,
        'type': 'Regression - Enhanced',
        'n_features': time_model.n_features_in_ if time_model else None,
        'features_expected': MODEL_FEATURES,
        'features_actual': MODEL_FEATURES[:time_model.n_features_in_] if time_model else None
    }
    
    return jsonify({
        'model_type': 'ENHANCED_MODEL',
        'training_date': today_date,
        'features_count_expected': len(MODEL_FEATURES),
        'features_count_actual_classification': class_model.n_features_in_ if class_model else 0,
        'features_count_actual_regression': time_model.n_features_in_ if time_model else 0,
        'classification_model': class_model_info,
        'regression_model': time_model_info,
        'status': 'active' if (class_model and time_model) else 'inactive'
    })

@app.route('/reload_models', methods=['POST'])
def reload_models():
    """Reload model mới nhất"""
    global class_model, time_model
    class_model, time_model = load_today_models()
    
    return jsonify({
        'message': 'Đã reload model',
        'classification_loaded': class_model is not None,
        'regression_loaded': time_model is not None,
        'model_date': today_date
    })

@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    models_loaded = {
        'classification': class_model is not None,
        'regression': time_model is not None
    }
    
    status = 'healthy' if all(models_loaded.values()) else 'degraded' if any(models_loaded.values()) else 'unhealthy'
    
    return jsonify({
        'status': status,
        'timestamp': datetime.now().isoformat(),
        'models_loaded': models_loaded,
        'details': {
            'classification_features': class_model.n_features_in_ if class_model else 0,
            'regression_features': time_model.n_features_in_ if time_model else 0
        }
    })

if __name__ == '__main__':
    print(f"📍 Endpoints:")
    print("   GET  /              - Trang chủ API")
    print("   POST /predict       - Dự đoán trạng thái cảnh báo NÂNG CAO")
    print("   POST /predict_time  - Dự đoán thời gian lũ về NÂNG CAO")
    print("   POST /batch_predict - Dự đoán hàng loạt")
    print("   GET  /model_info    - Thông tin model")
    print("   POST /reload_models - Reload model mới")
    print("   GET  /health        - Health check")
    print("\n🔥 API NÂNG CAO đã sẵn sàng nhận requests!")
    
    app.run(host='0.0.0.0', port=5001, debug=False)