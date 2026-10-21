-- create_range20_cron.sql — 「20日涨幅 9:25 预计算」定时触发（pg_cron + pg_net）
-- ============================================================
-- 配套 Edge Function：range20-precompute（见 db/edge/range20-precompute/index.ts）
-- 触发时间：UTC 01:25 = 北京 09:25（周一~周五；节假日靠函数内「名单等待超时」自然空转，无副作用）
--
-- ⚠️ 执行前把下面 <ANON_KEY> 替换成你项目的 anon public key：
--    Dashboard → Project Settings → API → Project API Keys → anon public
--    （anon key 本来就是公开的前端钥匙，写进 cron 无泄密风险）

-- ① 启用扩展（Supabase 默认都支持）
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ② 删旧任务（本脚本可重复执行）
do $$
begin
  perform cron.unschedule('range20-auc-precompute');
exception when others then null;
end $$;

-- ③ 建任务
select cron.schedule(
  'range20-auc-precompute',
  '25 1 * * 1-5',  -- UTC 01:25 周一~周五 = 北京 09:25
  $job$
  select net.http_post(
    url := 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/range20-precompute?token=range20-cron-2026',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <ANON_KEY>'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
  $job$
);

-- ============ 部署后自检（在 SQL Editor 里逐条跑）============
-- 任务是否已登记：
--   select jobname, schedule, active from cron.job;
-- 最近触发记录（status 应为 succeeded）：
--   select runid, job_pid, status, start_time from cron.job_run_details order by start_time desc limit 5;
-- 函数的 HTTP 响应（ok=true / written=N）：
--   select created, response from net._http_response order by created desc limit 5;
-- 当天结果行数（正常 ≈ 名单只数）：
--   select count(*), min(days), max(days) from stock_range20_pct where date = (now() at time zone 'Asia/Shanghai')::date and leg = 'auc';
