import pandas as pd
import psycopg2
import joblib
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score
import numpy as np

DB_CONFIG = { 'user': 'postgres', 'password': 'Quan@', 'host': 'localhost', 'port': '5432', 'database': 'flood_alert_db' }

# (Logic tạo nhãn Cảnh báo - Giữ nguyên)
def create_target_labels(df):
    countdown = df['time_until_a_danger'].fillna(0); mucnuoca = df['mucnuoca'].fillna(0)
    conditions = [(countdown > 0)&(countdown <= 30), (countdown > 0)&(countdown <= 60), (countdown > 60), (countdown == 0)&(mucnuoca > 28), (countdown == 0)&(mucnuoca > 25), (countdown == 0)&(mucnuoca > 20)]
    choices = ['Nguy hiểm!', 'Cảnh báo Cao!', 'Cảnh báo!', 'Nguy hiểm!', 'Cảnh báo Cao!', 'Cảnh báo!']
    return np.select(conditions, choices, default='Bình thường')

# ===== SỬA 1: HÀM TẠO 7 ĐẶC TRƯNG =====
def create_features_from_db(df):
    print("Đang tạo 7 đặc trưng thông minh (Rain ON/OFF)...")
    df = df.sort_values(by='created_at')

    df['time_diff'] = df['created_at'].diff().dt.total_seconds().fillna(0)
    df['b_rate_of_change'] = df['mucnuocb'].diff() / df['time_diff']
    df['flow_rate_of_change'] = df['luuluong'].diff() / df['time_diff']
    df['ab_diff'] = df['mucnuocb'] - df['mucnuoca']

    # Tạo is_raining_now: Nếu countdown > 0 thì đang có lũ (=> đang mưa)
    # (Đây là cách suy luận ngược vì chúng ta không lưu isRaining vào DB)
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
    print(f"✅ Lấy dữ liệu thành công! Tổng cộng {len(df)} hàng.")

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
    y = create_target_labels(df_features) # Target vẫn giữ nguyên
    unique_labels = np.unique(y)

    if len(unique_labels) < 2: print(f"❌ Lỗi: Chỉ có 1 lớp '{unique_labels[0]}'.")
    else:
        print(f"✅ Dữ liệu có {len(unique_labels)} lớp: {unique_labels}")
        print("Bắt đầu huấn luyện mô hình CẢNH BÁO (7-features)...")
        X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)
        model = RandomForestClassifier(n_estimators=100, random_state=42, max_depth=10)
        model.fit(X_train, y_train)
        print("✅ Huấn luyện hoàn tất!")
        predictions = model.predict(X_test)
        accuracy = accuracy_score(y_test, predictions)
        print(f"📊 Độ chính xác của mô hình Cảnh báo: {accuracy * 100:.2f}%")
        joblib.dump(model, 'flood_model.pkl')
        print("✅ Đã lưu mô hình Cảnh báo vào file 'flood_model.pkl'.")
except Exception as e: print(f"❌ Lỗi: {e}")