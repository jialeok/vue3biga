-- ============================================================================
-- 收盘涨幅自动覆盖时间表（pg_cron）— 在 Supabase Dashboard → SQL Editor 执行
-- 北京时间 16:00 调用 bidding-a Edge Function 的 point=auction-close，
-- 自动抓取当天「最近多板」成分股涨幅并覆盖 market_metrics.change_pct。
--
-- 说明：
--   - 功能已合并进 bidding-a（不新建函数），URL 指向 bidding-a/fetch。
--   - headers 带 apikey + Authorization（anon key = 有效 JWT）：
--     这样无论函数 Verify JWT 开关是开是关，平台鉴权都能通过，
--     进入代码后用 ?token= 校验（与 bidding-a 现有 ?token 鉴权一致）。
--
-- 时区：Supabase 数据库默认 UTC；北京时间 16:00 = UTC 08:00 → '0 8'。
--       若库时区已改为 Asia/Shanghai，则把 '0 8' 改成 '0 16'。
--
-- 查看 / 清理：
--   select jobid, jobname, schedule, active from cron.job;
--   select cron.unschedule('auction-close-fetch-daily');
-- ============================================================================

-- 1) 启用扩展（仅需一次；bidding-a 已启用则跳过）
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2) 北京时间 16:00（UTC 08:00）触发，周一至周五（工作日 1-5）
select cron.schedule('auction-close-fetch-daily', '0 8 * * 1-5', $$
  select net.http_post(
    url     := 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/bidding-a/fetch?point=auction-close&token=123456',
    headers := '{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg"}'::jsonb,
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
