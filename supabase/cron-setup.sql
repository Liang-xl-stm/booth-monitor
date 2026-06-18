-- ============================================================
--  Supabase 定时任务：每 30 秒触发桥接轮询
--  在 SQL Editor 中执行此文件（仅需一次）
-- ============================================================

-- 1. 启用扩展
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2. 创建定时任务
-- 每 30 秒调用 booth-bridge Edge Function
SELECT cron.schedule(
  'booth-poll',
  '*/30 * * * * *',  -- 每 30 秒
  $$
  SELECT net.http_post(
    url := 'https://injxopkhbbwgegsmyvlw.supabase.co/functions/v1/booth-bridge',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer sb_publishable_nZMQN_eTGwnUPIzK1YNn6Q_Rgno_PV0"}'::jsonb,
    body := '{"action": "poll"}'::jsonb
  );
  $$
);

-- 3. 验证
SELECT * FROM cron.job WHERE jobname = 'booth-poll';
