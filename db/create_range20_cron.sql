-- create_range20_cron.sql — 「20日涨幅 双腿预计算」定时触发（pg_cron + pg_net）
-- ============================================================
-- 配套 Edge Function：range20-precompute（见 db/edge/range20-precompute/index.ts）
-- 函数按【运行时刻】自动选腿，两条 cron 共用同一个函数 URL：
--   · UTC 01:25 = 北京 09:25 → 写 leg='auc'（竞价口径）⇒ 竞价期间打开秒开
--   · UTC 07:05 = 北京 15:05 → 写 leg='close'（收盘口径）⇒ 收盘后第一次打开秒开
--     （收盘价 15:00 定格，15:05 当天 K 线 bar 已是最终收盘价）
-- 均为周一~五；节假日靠函数内「名单等待超时」自然空转，无副作用。
-- 即便某条 cron 早/晚触发串了腿也无害：写错腿的行按 (date,stock) 主键会被
-- 正确腿的行 / 前端收盘重算覆盖，且前端按 leg 过滤不会读错。
--
-- ⚠️ 执行前把下面两处 <ANON_KEY> 替换成你项目的 anon public key：
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
do $$
begin
  perform cron.unschedule('range20-close-precompute');
exception when others then null;
end $$;

-- ③ 建任务一：竞价腿（北京 09:25）
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

-- ④ 建任务二：收盘腿（北京 15:05）
select cron.schedule(
  'range20-close-precompute',
  '5 7 * * 1-5',  -- UTC 07:05 周一~周五 = 北京 15:05
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
-- 两条任务是否已登记（应看到 range20-auc-precompute 与 range20-close-precompute）：
--   select jobname, schedule, active from cron.job;
-- 最近触发记录（status 应为 succeeded）：
--   select runid, job_pid, status, start_time from cron.job_run_details order by start_time desc limit 5;
-- 函数的 HTTP 响应（ok=true / leg=auc|close / written=N）：
--   select created, response from net._http_response order by created desc limit 5;
-- 当天两腿结果行数（auc 与 close 各 ≈ 名单只数）：
--   select leg, count(*), min(days), max(days) from stock_range20_pct
--    where date = (now() at time zone 'Asia/Shanghai')::date group by leg;
