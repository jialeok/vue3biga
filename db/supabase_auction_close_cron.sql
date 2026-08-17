-- ============================================================================
-- auction-close-fetch 时间表（pg_cron）— 在 Supabase Dashboard → SQL Editor 执行
-- 收盘自动抓取当天「最近多板」成分股涨幅并覆盖 market_metrics.change_pct。
--
-- 前提：先在 Dashboard → Extensions 启用 pg_cron 与 pg_net（免费版通常可启用）。
-- 时区说明：Supabase 数据库默认时区为 UTC。
--   北京时间 16:00 = UTC 08:00，故 cron 表达式写为 '0 8'。
--   先 `show timezone;` 确认你库时区；若改成了 Asia/Shanghai，则把下面 '0 8' 改成 '0 16'。
--
-- 占位符替换：
--   <PROJECT_REF>  = 你的项目 ref（xxxxx.supabase.co 中的 xxxxx）
--   <TOKEN>        = 与 Edge Function auction-close-fetch 里 FETCH_TOKEN 一致的令牌
--
-- 查看 / 清理：
--   select jobid, jobname, schedule, active from cron.job;
--   select cron.unschedule('auction-close-fetch-daily');
-- ============================================================================

-- 1) 启用扩展（仅需一次；若 bidding-a 已启用可跳过）
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2) 北京时间 16:00（UTC 08:00）触发，周一至周五（工作日 1-5）
select cron.schedule('auction-close-fetch-daily', '0 8 * * 1-5', $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/auction-close-fetch/fetch?token=<TOKEN>',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
