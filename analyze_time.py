import pandas as pd
import psycopg2
import joblib
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_squared_error
import numpy as np

DB_CONFIG = { 'user': 'postgres', 'password': 'Quan@', 'host': 'localhost', 'port': '5432', 'database': 'flood_alert_db' }

# ===== SỬA 1: HÀM TẠO 7 ĐẶC TRƯNG =====
# (Copy y hệt file analyze.py)
def create_features_from_db(df):
    print("Đang tạo 7 đặc trưng thông minh (Rain ON/OFF)...")
    df = df.sort_values(by='created_at')
    df['time_diff'] = df['created_at'].diff().dt.total_seconds().fillna(0)
    df['b_rate_of_change'] = df['mucnuocb'].diff() / df['time_diff']
    df['flow_rate_of_change'] = df['luuluong'].diff() / df['time_diff']
    df['ab_diff'] = df['mucnuocb'] - df['mucnuoca']
    df['is_raining_now'] = df['time_until_a_danger'].apply(lambda x: 1 if pd.notnull(x) and x > 0 else 0)
    df = df.replace([np.inf, -np.inf], 0)
    df = df.fillna(0)
    return df
# =====================================

print("Đang kết nối tới PostgreSQL...")
try:
    conn = psycopg2.connect(**DB_CONFIG)
    query = "SELECT * FROM public.sensor_data;" # Lấy hết CSDL
    df = pd.read_sql_query(query, conn)
    conn.close()

    if len(df) < 50: print(f"❌ Lỗi: Cần ít nhất 50 hàng. Mới có {len(df)} hàng.")
    else:
        print(f"✅ Lấy dữ liệu thành công! Bắt đầu học trên {len(df)} hàng.")

        df_features = create_features_from_db(df)

        # ===== SỬA 2: ĐẦU VÀO LÀ 7 ĐẶC TRƯNG =====
        features = [
            'mucnuoca',
            'mucnuocb',
            'luuluong',
            'is_raining_now',        # <-- THÊM MỚI
            'b_rate_of_change',
            'flow_rate_of_change',
            'ab_diff'
        ]
        X = df_features[features]
        target = 'time_until_a_danger'
        y = df_features[target].fillna(0) # Target vẫn là countdown

        print("Bắt đầu huấn luyện mô hình ĐẾM NGƯỢC (7-features)...")
        X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
        model = RandomForestRegressor(n_estimators=200, max_depth=10, random_state=42)
        model.fit(X_train, y_train)
        print("✅ Huấn luyện hoàn tất!")
        predictions = model.predict(X_test)
        rmse = np.sqrt(mean_squared_error(y_test, predictions))
        print(f"📊 Độ chính xác (RMSE): {rmse:.2f} giây")
        joblib.dump(model, 'time_model.pkl')
        print("✅ Đã lưu mô hình đếm ngược vào file 'time_model.pkl'.")
except Exception as e: print(f"❌ Lỗi: {e}")