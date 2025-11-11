import pandas as pd
import psycopg2
import joblib
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_squared_error, r2_score
import numpy as np
from datetime import datetime, date

DB_CONFIG = { 
    'user': 'postgres', 
    'password': 'Quan@', 
    'host': 'localhost', 
    'port': '5432', 
    'database': 'flood_alert_db' 
}

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
        if 'phút' in str(time_str) and 'giây' in str(time_str):
            parts = str(time_str).split()
            minutes = 0
            seconds = 0
            
            for i in range(len(parts)):
                if parts[i] == 'phút':
                    minutes = float(parts[i-1])
                elif parts[i] == 'giây':
                    seconds = float(parts[i-1])
            
            return minutes * 60 + seconds
        elif 'giây' in str(time_str):
            parts = str(time_str).split()
            for i in range(len(parts)):
                if parts[i] == 'giây':
                    return float(parts[i-1])
        else:
            return float(time_str)
    except:
        return 0.0

def create_features_from_db(df):
    """
    Tạo đặc trưng NÂNG CAO cho dự đoán thời gian
    """
    print("🔄 Đang tạo đặc trưng NÂNG CAO cho dự đoán thời gian...")
    df = df.sort_values(by='created_at')

    # 🆚 CHUYỂN ĐỔI SỐ
    df['mucnuoca'] = pd.to_numeric(df['mucnuoca'], errors='coerce').fillna(0)
    df['mucnuocb'] = pd.to_numeric(df['mucnuocb'], errors='coerce').fillna(0)
    df['luuluong'] = pd.to_numeric(df['luuluong'], errors='coerce').fillna(0)
    
    # 🎯 QUAN TRỌNG: Chuyển đổi time_until_a_danger
    print("   🔄 Chuyển đổi time_until_a_danger từ string sang số giây...")
    df['time_until_a_danger_seconds'] = df['time_until_a_danger'].apply(convert_time_to_seconds)
    
    # 📊 TÍNH TOÁN ĐẶC TRƯNG NÂNG CAO
    df['time_diff'] = df['created_at'].diff().dt.total_seconds().fillna(0)
    
    # Tốc độ thay đổi
    df['b_rate_of_change'] = df['mucnuocb'].diff() / df['time_diff']
    df['flow_rate_of_change'] = df['luuluong'].diff() / df['time_diff']
    
    # Chênh lệch và tỷ lệ
    df['ab_diff'] = df['mucnuocb'] - df['mucnuoca']
    df['ab_ratio'] = df['mucnuocb'] / (df['mucnuoca'] + 0.001)
    
    # Thay đổi tuyệt đối
    df['b_absolute_change'] = df['mucnuocb'].diff().fillna(0)
    df['b_total_rise'] = df['mucnuocb'] - df['mucnuocb'].iloc[0]
    
    # Chỉ số nguy hiểm tổng hợp
    df['danger_index'] = (
        (df['mucnuocb'] * 0.3) + 
        (df['b_rate_of_change'].abs() * 2.0) + 
        (df['b_absolute_change'].abs() * 0.5) +
        (df['ab_diff'] * 0.2)
    )
    
    # Xu hướng
    df['b_trend'] = df['mucnuocb'].rolling(window=3, min_periods=1).mean()
    
    # 🎯 DÙNG DỮ LIỆU is_raining THỰC TẾ
    df['is_raining_now'] = df['is_raining'].astype(int)
    
    df = df.replace([np.inf, -np.inf], 0).fillna(0)
    
    print(f"   📊 Target range: {df['time_until_a_danger_seconds'].min():.1f} - {df['time_until_a_danger_seconds'].max():.1f} giây")
    print(f"   📊 Mực nước B: {df['mucnuocb'].min():.1f} - {df['mucnuocb'].max():.1f} cm")
    
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

    # Tạo features
    df_features = create_features_from_db(df)
    
    features = [
        'mucnuoca', 'mucnuocb', 'luuluong', 'is_raining_now',
        'b_rate_of_change', 'flow_rate_of_change', 'ab_diff', 
        'ab_ratio', 'b_absolute_change', 'b_total_rise', 'danger_index', 'b_trend'
    ]
    
    X = df_features[features]
    y = df_features['time_until_a_danger_seconds']

    print("🎯 Bắt đầu huấn luyện mô hình ĐẾM NGƯỢC NÂNG CAO...")
    print(f"   📊 Target range: {y.min():.1f} - {y.max():.1f} giây")
    
    # Điều chỉnh cho ít dữ liệu
    if len(df) > 10:
        X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    else:
        X_train, y_train = X, y
        X_test, y_test = X, y
        print("⚠️ Dùng toàn bộ dữ liệu cho training (quá ít mẫu)")
    
    # Điều chỉnh model cho dữ liệu ít
    n_estimators = min(50, len(X_train) // 2)
    max_depth = min(8, max(3, len(X_train) // 3))
    
    model = RandomForestRegressor(
        n_estimators=max(10, n_estimators),
        max_depth=max_depth,
        random_state=42,
        min_samples_split=2,
        min_samples_leaf=1
    )
    
    model.fit(X_train, y_train)
    print("✅ Huấn luyện hoàn tất!")
    
    # Đánh giá model
    predictions = model.predict(X_test)
    rmse = np.sqrt(mean_squared_error(y_test, predictions))
    r2 = r2_score(y_test, predictions)
    
    print("\n📈 KẾT QUẢ MODEL ĐẾM NGƯỢC NÂNG CAO:")
    print(f"   ✅ RMSE: {rmse:.2f} giây")
    print(f"   ✅ R² Score: {r2:.3f}")
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
    
    # Dự đoán thử
    print("\n🎯 DỰ ĐOÁN THỬ TRÊN 5 MẪU GẦN ĐÂY:")
    recent_data = X.tail(5)
    recent_predictions = model.predict(recent_data)
    
    for i, (actual, pred) in enumerate(zip(y.tail(5).values, recent_predictions)):
        print(f"   Mẫu {i+1}: Thực tế {actual:.1f}s -> Dự đoán {pred:.1f}s")
    
    # Lưu model
    model_filename = f'time_model_today.pkl'
    joblib.dump(model, model_filename)
    print(f"💾 Đã lưu model đếm ngược NÂNG CAO vào '{model_filename}'")
    
except Exception as e:
    print(f"❌ Lỗi: {e}")
    import traceback
    traceback.print_exc()