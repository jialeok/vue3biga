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

-- ============================================================================
-- ⑤ 历史回补：把「20 个交易日」补齐（★ 一次性，用 Edge Function 的 ?date= 参数）
--
-- 背景（2026-10-22 实测）：stock_range20_pct 最早一行是 2026-10-12 ⇒ 表里只有 9 个交易日，
--   而「20日涨幅前五 / 总龙一~五」的补位池要翻 20 个交易日 ⇒ 前 11 天是空的，
--   断点直接体现为「宁波东力只有 2 天 / 三峡新材只有 1 天 / 冰山冷热 6 天」。
--   ⚠️ 注意区分两件事（用户问过）：
--     · 「20日涨幅的【数值】」来自同花顺 K 线（一次拉 100 个自然日）⇒ 一直是准的，与表里有几天无关；
--     · 「表里的【记录】」是缓存 + 补位池 ⇒ 它只有 9 天。
--   所以「数字对得上同花顺」和「表里只有 9 天」并不矛盾，缺的是【历史深度】，不是【算法】。
--
-- 20 个交易日窗口（10-22 往前数）：
--   已有：10-12 10-13 10-14 10-15 10-16 10-19 10-20 10-21 10-22   （9 天）
--   待补：10-09 10-08 09-30 09-29 09-28 09-25 09-24 09-23 09-22 09-21 09-18 （11 天）
--
-- ★ 纪律：必须【由旧到新】逐日跑（补位池取的是 date < 目标日 的榜日，前序没数据池就是空的）；
--         每天一条命令，⛔ 不要并发（上游同花顺会限流，实测 43 秒内必熔断）。
--         数据源是同花顺 K 线（经 fuyao-proxy）⇒ **零猫抓额度**。
--
-- 先干跑看目标对不对（不打上游，&dry=1）：
--   curl -X POST '<URL>/functions/v1/range20-precompute?token=range20-cron-2026&date=2026-09-18&dry=1'
-- 再逐日真跑（把 <URL> 换成 https://tonqfgeyxnnwicjopshn.supabase.co）：
--   curl -X POST '...&date=2026-09-18'
--   curl -X POST '...&date=2026-09-21'
--   curl -X POST '...&date=2026-09-22'
--   curl -X POST '...&date=2026-09-23'
--   curl -X POST '...&date=2026-09-24'
--   curl -X POST '...&date=2026-09-25'
--   curl -X POST '...&date=2026-09-28'
--   curl -X POST '...&date=2026-09-29'
--   curl -X POST '...&date=2026-09-30'
--   curl -X POST '...&date=2026-10-08'
--   curl -X POST '...&date=2026-10-09'
--
-- 回补完成后自查（应看到 20 天、每天 close 行数 ≈ 当天名单只数）：
--   select date, count(*) filter (where leg='close') as close_rows,
--          count(*) filter (where leg='auc')   as auc_rows
--     from stock_range20_pct
--    where date >= '2026-09-18'
--    group by date order by date;
--
-- 补位票「每天都有数据」自查（把 新华传媒 换成任意补位票名；应连续 20 行）：
--   select date, leg, pct, days from stock_range20_pct
--    where stock = '新华传媒' and date >= '2026-09-18' order by date;
--
-- 哪几天还缺（返回的行就是要补的日期）：
--   with d as (select distinct date from stock_range20_pct where date >= '2026-09-18')
--   select g::date as missing
--     from generate_series('2026-09-18'::date, '2026-10-22'::date, '1 day') g
--    where extract(isodow from g) < 6
--      and g::date::text not in (select date from d);
-- ============================================================================

