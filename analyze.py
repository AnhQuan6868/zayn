import pandas as pd
import psycopg2
import joblib
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report
import numpy as np
from datetime import datetime, date

DB_CONFIG = { 
    'user': 'postgres', 
    'password': 'Quan@', 
    'host': 'localhost', 
    'port': '5432', 
    'database': 'flood_alert_db' 
}

def create_target_labels(df):
    """
    Tạo nhãn cảnh báo THÔNG MINH HƠN - Nhạy cảm với nước dâng mạnh
    """
    # 🆚 CHUYỂN ĐỔI SANG SỐ
    countdown = pd.to_numeric(df['time_until_a_danger'], errors='coerce').fillna(0)
    mucnuoca = pd.to_numeric(df['mucnuoca'], errors='coerce').fillna(0)
    mucnuocb = pd.to_numeric(df['mucnuocb'], errors='coerce').fillna(0)
    
    # 🎯 TÍNH TOÁN THAY ĐỔI THEO THỜI GIAN
    df_sorted = df.sort_values(by='created_at')
    df_sorted['mucnuocb_prev'] = df_sorted['mucnuocb'].shift(1)
    df_sorted['mucnuocb_change'] = df_sorted['mucnuocb'] - df_sorted['mucnuocb_prev']
    df_sorted['mucnuocb_change'] = df_sorted['mucnuocb_change'].fillna(0)
    
    # 🚨 ĐIỀU KIỆN CẢNH BÁO MỚI - NHẠY CẢM HƠN
    conditions = [
        # 🚨 NGUY HIỂM: Countdown ngắn HOẶC mực nước cao HOẶC thay đổi lớn
        (countdown > 0) & (countdown <= 30),
        (countdown == 0) & (mucnuoca > 25),
        (mucnuocb > 15),  # Mực nước B cao
        (df_sorted['mucnuocb_change'] > 8),  # Tăng đột biến 8cm
        (mucnuocb - mucnuoca > 10),  # Chênh lệch lớn giữa B và A
        
        # 🔶 CẢNH BÁO CAO: Countdown trung bình HOẶC mực nước trung bình HOẶC thay đổi trung bình
        (countdown > 30) & (countdown <= 90),
        (countdown == 0) & (mucnuoca > 20) & (mucnuoca <= 25),
        (mucnuocb > 12) & (mucnuocb <= 15),
        (df_sorted['mucnuocb_change'] > 4) & (df_sorted['mucnuocb_change'] <= 8),
        (mucnuocb - mucnuoca > 6) & (mucnuocb - mucnuoca <= 10),
        
        # ⚠️ CẢNH BÁO: Countdown dài HOẶC mực nước thấp HOẶC thay đổi nhỏ
        (countdown > 90) & (countdown <= 180),
        (countdown == 0) & (mucnuoca > 15) & (mucnuoca <= 20),
        (mucnuocb > 8) & (mucnuocb <= 12),
        (df_sorted['mucnuocb_change'] > 2) & (df_sorted['mucnuocb_change'] <= 4),
        (mucnuocb - mucnuoca > 3) & (mucnuocb - mucnuoca <= 6)
    ]
    
    choices = [
        'Nguy hiểm!', 'Nguy hiểm!', 'Nguy hiểm!', 'Nguy hiểm!', 'Nguy hiểm!',
        'Cảnh báo Cao!', 'Cảnh báo Cao!', 'Cảnh báo Cao!', 'Cảnh báo Cao!', 'Cảnh báo Cao!',
        'Cảnh báo!', 'Cảnh báo!', 'Cảnh báo!', 'Cảnh báo!', 'Cảnh báo!'
    ]
    
    return np.select(conditions, choices, default='Bình thường')

def create_features_from_db(df):
    """
    Tạo đặc trưng NÂNG CAO với nhiều chỉ số nguy hiểm
    """
    print("🔄 Đang tạo đặc trưng NÂNG CAO từ dữ liệu NGÀY HÔM NAY...")
    df = df.sort_values(by='created_at')

    # 🆚 CHUYỂN ĐỔI SỐ
    df['mucnuoca'] = pd.to_numeric(df['mucnuoca'], errors='coerce').fillna(0)
    df['mucnuocb'] = pd.to_numeric(df['mucnuocb'], errors='coerce').fillna(0)
    df['luuluong'] = pd.to_numeric(df['luuluong'], errors='coerce').fillna(0)
    df['time_until_a_danger'] = pd.to_numeric(df['time_until_a_danger'], errors='coerce').fillna(0)

    # 📊 TÍNH TOÁN ĐẶC TRƯNG NÂNG CAO
    df['time_diff'] = df['created_at'].diff().dt.total_seconds().fillna(0)
    
    # Tốc độ thay đổi
    df['b_rate_of_change'] = df['mucnuocb'].diff() / df['time_diff']
    df['flow_rate_of_change'] = df['luuluong'].diff() / df['time_diff']
    
    # Chênh lệch
    df['ab_diff'] = df['mucnuocb'] - df['mucnuoca']
    df['ab_ratio'] = df['mucnuocb'] / (df['mucnuoca'] + 0.001)  # Tránh chia 0
    
    # Thay đổi tuyệt đối
    df['b_absolute_change'] = df['mucnuocb'].diff().fillna(0)
    df['b_total_rise'] = df['mucnuocb'] - df['mucnuocb'].iloc[0]  # Tổng mức tăng từ đầu
    
    # Chỉ số nguy hiểm tổng hợp
    df['danger_index'] = (
        (df['mucnuocb'] * 0.3) + 
        (df['b_rate_of_change'].abs() * 2.0) + 
        (df['b_absolute_change'].abs() * 0.5) +
        (df['ab_diff'] * 0.2)
    )
    
    # 🎯 DÙNG DỮ LIỆU is_raining THỰC TẾ
    df['is_raining_now'] = df['is_raining'].astype(int)
    
    # Xử lý giá trị vô cùng và NaN
    df = df.replace([np.inf, -np.inf], 0).fillna(0)
    
    print(f"   📊 Mực nước B: {df['mucnuocb'].min():.1f} - {df['mucnuocb'].max():.1f} cm")
    print(f"   📊 Chỉ số nguy hiểm: {df['danger_index'].min():.1f} - {df['danger_index'].max():.1f}")
    
    return df

print("🌐 Đang kết nối tới PostgreSQL...")
try:
    conn = psycopg2.connect(**DB_CONFIG)
    
    # 🎯 CHỈ LẤY DỮ LIỆU NGÀY HÔM NAY
    today = date.today().strftime('%Y-%m-%d')
    query = f"SELECT * FROM public.sensor_data WHERE DATE(created_at) = '{today}';"
    
    df = pd.read_sql_query(query, conn)
    conn.close()
    
    print(f"✅ Lấy dữ liệu NGÀY {today} thành công! Tổng cộng {len(df)} hàng.")

    if len(df) < 5:
        print(f"❌ Quá ít dữ liệu ({len(df)} hàng). Cần ít nhất 5 hàng để huấn luyện.")
        exit()

    # Tạo features và labels
    df_features = create_features_from_db(df)
    features = [
        'mucnuoca', 'mucnuocb', 'luuluong', 'is_raining_now',
        'b_rate_of_change', 'flow_rate_of_change', 'ab_diff', 
        'ab_ratio', 'b_absolute_change', 'b_total_rise', 'danger_index'
    ]
    
    X = df_features[features]
    y = create_target_labels(df_features)
    
    # Phân tích dữ liệu
    unique_labels, label_counts = np.unique(y, return_counts=True)
    print(f"📊 Phân phối labels NGÀY HÔM NAY:")
    for label, count in zip(unique_labels, label_counts):
        print(f"   {label}: {count} samples")

    if len(unique_labels) < 2:
        print("⚠️ Cảnh báo: Dữ liệu chỉ có 1 lớp, model có thể không hiệu quả")
    
    # Huấn luyện model với điều chỉnh cho dữ liệu nhỏ
    test_size = min(0.3, 0.1 if len(df) < 20 else 0.2)
    
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=test_size, random_state=42, stratify=y if len(unique_labels) > 1 else None
    )
    
    # Điều chỉnh hyperparameters cho dữ liệu nhỏ
    n_estimators = min(50, len(X_train) // 2)
    max_depth = min(10, max(3, len(X_train) // 5))
    
    model = RandomForestClassifier(
        n_estimators=max(10, n_estimators),
        max_depth=max_depth,
        random_state=42,
        min_samples_split=2,
        min_samples_leaf=1
    )
    
    print(f"🎯 Training model với {n_estimators} trees, max_depth={max_depth}...")
    model.fit(X_train, y_train)
    
    # Đánh giá model
    predictions = model.predict(X_test)
    accuracy = accuracy_score(y_test, predictions)
    
    print("\n📈 KẾT QUẢ MODEL PHÂN LOẠI NÂNG CAO:")
    print(f"   ✅ Độ chính xác: {accuracy * 100:.2f}%")
    print(f"   📊 Số mẫu training: {len(X_train)}")
    print(f"   📊 Số mẫu testing: {len(X_test)}")
    
    # Phân tích feature importance
    feature_importance = pd.DataFrame({
        'feature': features,
        'importance': model.feature_importances_
    }).sort_values('importance', ascending=False)
    
    print("\n🔍 Feature Importance:")
    for _, row in feature_importance.head(5).iterrows():
        print(f"   {row['feature']}: {row['importance']:.3f}")
    
    # Lưu model
    model_filename = f'flood_model_today.pkl'
    joblib.dump(model, model_filename)
    print(f"💾 Đã lưu model phân loại NÂNG CAO vào '{model_filename}'")
    
    # Hiển thị chi tiết phân loại
    if len(unique_labels) > 1:
        print("\n🔍 Báo cáo chi tiết:")
        print(classification_report(y_test, predictions))
    
    # Dự đoán thử trên dữ liệu gần đây
    print("\n🎯 DỰ ĐOÁN THỬ TRÊN 5 MẪU GẦN ĐÂY:")
    recent_data = X.tail(5)
    recent_predictions = model.predict(recent_data)
    recent_proba = model.predict_proba(recent_data)
    
    for i, (pred, proba) in enumerate(zip(recent_predictions, recent_proba)):
        prob_dict = dict(zip(model.classes_, proba))
        print(f"   Mẫu {i+1}: {pred} (Xác suất: {prob_dict})")
        
except Exception as e:
    print(f"❌ Lỗi: {e}")
    import traceback
    traceback.print_exc()