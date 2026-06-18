-- 展台监测系统 — 模拟测试数据（可重复执行）
-- 在 schema.sql 执行完毕后执行此文件

-- ============================================================
-- 0. 默认账号密码（已存在则忽略）
-- ============================================================
INSERT INTO users (username, password) VALUES
  ('admin', 'admin123')
ON CONFLICT (username) DO NOTHING;

-- 默认 oneNET 配置（已存在则忽略）
INSERT INTO profiles (username, product_id, device_name, access_key, onenet_user_id) VALUES
  ('admin', 'Hc8y9729b1', '展台监测器-01', 'uQcBe/tDHbF3hzMnaxENoXUhXzHbr6Fzn6k5r6Mtk1E=', '516969')
ON CONFLICT (username) DO NOTHING;

-- ============================================================
-- 1. 注册测试设备（已存在则忽略）
-- ============================================================
INSERT INTO devices (id, product_id, device_name, location) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'Hc8y9729b1', '展台监测器-01', '主展台A区')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 2. 初始化设备状态（已存在则覆盖）
-- ============================================================
INSERT INTO device_state (device_id, beep_enabled, sensor_armed) VALUES
  ('d0000000-0000-0000-0000-000000000001', TRUE, TRUE)
ON CONFLICT (device_id) DO UPDATE SET beep_enabled = TRUE, sensor_armed = TRUE, updated_at = NOW();

-- ============================================================
-- 3. 生成 24 小时遥测数据（仅首次插入）
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM telemetry WHERE device_id = 'd0000000-0000-0000-0000-000000000001' LIMIT 1) THEN
    INSERT INTO telemetry (device_id, temperature, humidity, ambient_light, alarm_status, reported_at)
    SELECT
      'd0000000-0000-0000-0000-000000000001',
      22 + 3 * SIN(EXTRACT(HOUR FROM ts) * PI() / 12) + random() * 3,
      55 - 5 * SIN(EXTRACT(HOUR FROM ts) * PI() / 12) + random() * 10,
      CASE
        WHEN EXTRACT(HOUR FROM ts) BETWEEN 6 AND 20 THEN 200 + random() * 1800
        ELSE random() * 5
      END,
      FALSE,
      ts
    FROM generate_series(NOW() - INTERVAL '24 hours', NOW(), INTERVAL '15 minutes') AS ts;
  END IF;
END $$;

-- 最近一条设为温度过高报警
UPDATE telemetry
SET temperature = 37.5, alarm_status = TRUE
WHERE id = (
  SELECT id FROM telemetry
  WHERE device_id = 'd0000000-0000-0000-0000-000000000001'
  ORDER BY reported_at DESC LIMIT 1
);

-- ============================================================
-- 4. 报警事件（仅首次插入）
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM alarm_events WHERE device_id = 'd0000000-0000-0000-0000-000000000001' LIMIT 1) THEN
    INSERT INTO alarm_events (device_id, alarm_code, created_at) VALUES
      ('d0000000-0000-0000-0000-000000000001', 1, NOW() - INTERVAL '20 hours'),
      ('d0000000-0000-0000-0000-000000000001', 0, NOW() - INTERVAL '19 hours'),
      ('d0000000-0000-0000-0000-000000000001', 3, NOW() - INTERVAL '5 hours'),
      ('d0000000-0000-0000-0000-000000000001', 0, NOW() - INTERVAL '4 hours'),
      ('d0000000-0000-0000-0000-000000000001', 1, NOW());
  END IF;
END $$;
