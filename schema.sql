-- 展台监测系统 — Supabase 数据库建表 DDL
-- 在 Supabase SQL Editor 中完整执行此文件

-- ============================================================
-- 1. 扩展
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 2. 建表
-- ============================================================

-- 设备注册表
CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  location TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 遥测时序数据
CREATE TABLE IF NOT EXISTS telemetry (
  id BIGSERIAL PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  temperature FLOAT8,
  humidity FLOAT8,
  ambient_light FLOAT8,
  alarm_status BOOLEAN DEFAULT FALSE,
  reported_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_device_time
  ON telemetry(device_id, reported_at DESC);

-- 报警事件日志
CREATE TABLE IF NOT EXISTS alarm_events (
  id BIGSERIAL PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  alarm_code INT2 NOT NULL CHECK (alarm_code BETWEEN 0 AND 3),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alarm_events_device_time
  ON alarm_events(device_id, created_at DESC);

-- 设备当前可写状态（最新值）
CREATE TABLE IF NOT EXISTS device_state (
  device_id UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  beep_enabled BOOLEAN DEFAULT TRUE,
  sensor_armed BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 指令下发队列
CREATE TABLE IF NOT EXISTS device_commands (
  id BIGSERIAL PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  command TEXT NOT NULL CHECK (command IN ('arm', 'disarm', 'toggle_beep')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'done', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_commands_pending
  ON device_commands(device_id, status) WHERE status = 'pending';

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 用户 oneNET 配置表
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE REFERENCES users(username) ON DELETE CASCADE,
  product_id TEXT NOT NULL DEFAULT 'Hc8y9729b1',
  device_name TEXT NOT NULL DEFAULT '展台监测器-01',
  access_key TEXT NOT NULL DEFAULT '',
  onenet_user_id TEXT NOT NULL DEFAULT '516969',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 3. RLS 策略（公开访问，通过前端密码验证保护）
-- ============================================================

DO $$ BEGIN
  ALTER TABLE devices        ENABLE ROW LEVEL SECURITY;
  ALTER TABLE telemetry      ENABLE ROW LEVEL SECURITY;
  ALTER TABLE alarm_events   ENABLE ROW LEVEL SECURITY;
  ALTER TABLE device_state   ENABLE ROW LEVEL SECURITY;
  ALTER TABLE device_commands ENABLE ROW LEVEL SECURITY;
  ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN others THEN NULL;
END $$;

-- 删除旧策略（允许重复执行）
DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'public_%'
  LOOP EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.policyname, r.tablename); END LOOP;
END $$;

CREATE POLICY "public_read_devices"    ON devices         FOR SELECT TO anon USING (true);
CREATE POLICY "public_read_telemetry"  ON telemetry       FOR SELECT TO anon USING (true);
CREATE POLICY "public_read_alarms"     ON alarm_events    FOR SELECT TO anon USING (true);
CREATE POLICY "public_read_state"      ON device_state    FOR SELECT TO anon USING (true);
CREATE POLICY "public_read_commands"   ON device_commands FOR SELECT TO anon USING (true);
CREATE POLICY "public_read_users"      ON users           FOR SELECT TO anon USING (true);
CREATE POLICY "public_insert_users"    ON users           FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "public_read_profiles"   ON profiles        FOR SELECT TO anon USING (true);
CREATE POLICY "public_insert_profiles" ON profiles        FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "public_update_profiles" ON profiles        FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "public_insert_commands"  ON device_commands FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "public_update_commands"  ON device_commands FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "public_insert_telemetry" ON telemetry       FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "public_insert_alarms"    ON alarm_events    FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "public_upsert_state"     ON device_state    FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "public_update_state"     ON device_state    FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- ============================================================
-- 4. Realtime 订阅
-- ============================================================

ALTER TABLE telemetry       REPLICA IDENTITY FULL;
ALTER TABLE alarm_events    REPLICA IDENTITY FULL;
ALTER TABLE device_state    REPLICA IDENTITY FULL;
ALTER TABLE device_commands REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'telemetry'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE telemetry;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'alarm_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE alarm_events;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'device_state'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE device_state;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'device_commands'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE device_commands;
  END IF;
END $$;
