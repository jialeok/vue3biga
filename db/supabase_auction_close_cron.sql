-- ============================================================================
-- 收盘涨幅自动覆盖时间表（pg_cron）— 在 Supabase Dashboard → SQL Editor 执行
-- 北京时间 16:00 调用 bidding-a Edge Function 的 point=auction-close，
-- 自动抓取当天「最近多板」成分股涨幅并覆盖 market_metrics.change_pct。
--
-- 说明：该功能已合并进 bidding-a（不新建函数），故 URL 指向 bidding-a/fetch。
-- 前提：bidding-a 已部署合并版代码（含 runAuctionCloseFetch）。
-- 时区：Supabase 数据库默认 UTC；北京时间 16:00 = UTC 08:00 → '0 8'。
--       若库时区已改为 Asia/Shanghai，则把 '0 8' 改成 '0 16'。
--
-- 占位符替换：
--   <PROJECT_REF>  = 你的项目 ref（xxxxx.supabase.co 中的 xxxxx）
--   <TOKEN>        = 与 bidding-a 里 FETCH_TOKEN 一致的令牌
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
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/bidding-a/fetch?point=auction-close&token=<TOKEN>',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
