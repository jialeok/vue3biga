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
-- ★★ [R20-METRICS 2026-10-23] 同一个函数现在还顺带写 market_metrics（补位票的当日行情）：
--     · 09:25 那轮写：volume(竞价量，万股) / yest_volume(昨日成交量，万股) /
--                     auc_pct_chg(竞价涨幅) / auc_vol_ratio(竞价量比) / change_pct(=竞价涨幅)
--     · 15:05 那轮覆盖：change_pct 改成【收盘涨幅】（用户口径「收盘后再覆盖涨幅」）
--     目的：前端展开「补位票」趋势图时【0 上游请求】，直接读表就有当天数据。
--     为什么必须落库而不能让前端现补：前端现补要现场打同花顺，而 15:05 这轮 cron 刚把
--     上游配额烧完 ⇒ 实测前端补缺直接吃 `429 Global request rate limit exceeded`
--     ⇒ 补位票当天五条线全空。落库后前端只读，彻底与配额脱钩。
--     自检：select source, count(*) from market_metrics
--            where date = (now() at time zone 'Asia/Shanghai')::date and source = 'range20' group by 1;
--
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
-- ⑤ 历史回补：把「20 个交易日」补齐（★ 幂等，可随时重跑）
--
-- 背景（2026-10-22 实测）：stock_range20_pct 最早一行是 2026-10-12 ⇒ 表里只有 9 个交易日，
--   而「20日涨幅前五 / 总龙一~五」的补位池、第二十八条「20 个交易日内是否首次上榜」都要翻 20 天
--   ⇒ 前 11 天是空的，断点直接体现为「宁波东力只有 2 天 / 三峡新材只有 1 天 / 冰山冷热 6 天」，
--   规则文案也只能如实写「实际覆盖 8/20 天」。
--   ⚠️ 必须区分两件事（用户问过「为什么数字对得上同花顺，你却说只有几天」）：
--     · 「20日涨幅的【数值】」来自同花顺 K 线（一次拉 100 个自然日）⇒ 一直是准的，与表里有几天无关；
--     · 「表里的【记录】」是缓存 + 补位池 ⇒ 当时只有 9 天。
--   所以「数字准」和「表里只有 9 天」并不矛盾，缺的是【历史深度】，不是【算法】。
--
-- ★ 正确窗口（⛔ 别再手抄日期）：前端 ensureTop5History 是「展示日往前推 20 个交易日」，
--   用 isTradingDay 跳过周末 + trading_day_overrides 里 is_holiday=true 的假期。
--   ⇒ 对 2026-10-22：09-16 ~ 10-21（20 天），再单独加 10-22 当天。
--   ⚠️ 2026-09-25 是中秋休市（云端 trading_day_overrides 已标 is_holiday=true），不在这 20 天里；
--      ⛔ 不要手工把它塞进窗口，否则前端永远只能覆盖 19/20 天。
--
-- ★ 首选做法：跑本地脚本（一只票只请求一次 K 线，20 天一起算，请求数 ~250 而不是 ~5000）
--   node db/scripts/backfill-range20.mjs                      # 干跑：报每天已有行数 / 待补
--   node db/scripts/backfill-range20.mjs --run                # 真跑
--   node db/scripts/backfill-range20.mjs --run --date=2026-10-22
--   特点：只写「缺失的 (date, stock)」⇒ 幂等、重跑零漂移；当天停牌 ⇒ 不写（§10 宁缺勿错）；
--        数据源是同花顺 K 线经 fuyao-proxy ⇒ **零猫抓额度**。
--
-- ○ 备选做法：用 Edge Function 的 ?date= 逐日补（必须【由旧到新】，⛔ 不要并发，上游会限流熔断）
--   先干跑看目标对不对（&dry=1 不打上游）：
--     curl -X POST '<URL>/functions/v1/range20-precompute?token=range20-cron-2026&date=2026-09-16&dry=1'
--   再逐日真跑（<URL> = https://tonqfgeyxnnwicjopshn.supabase.co）：
--     09-16 09-17 09-18 09-21 09-22 09-23 09-24 09-28 09-29 09-30
--     10-08 10-09 10-12 10-13 10-14 10-15 10-16 10-19 10-20 10-21 10-22
--   （09-25 中秋休市，跳过）
--
-- 回补完成后自查（应看到 21 行，每天 close 行数 236~250，且 auc 只在当天有值）：
--   select date, count(*) filter (where leg='close') as close_rows,
--          count(*) filter (where leg='auc')   as auc_rows
--     from stock_range20_pct
--    where date >= '2026-09-16'
--    group by date order by date;
--
-- 补位票「每天都有数据」自查（应连续 20 行；停牌日会缺，属正常）：
--   select date, leg, pct, days from stock_range20_pct
--    where stock = '冰山冷热' and date >= '2026-09-16' order by date;
--
-- 哪几天还缺（返回的行就是要补的日期；09-25 是假期所以要排除）：
--   with d as (select distinct date from stock_range20_pct where date >= '2026-09-16'),
--        hol as (select date from trading_day_overrides where is_holiday = true)
--   select g::date as missing
--     from generate_series('2026-09-16'::date, '2026-10-21'::date, '1 day') g
--    where extract(isodow from g) < 6
--      and g::date::text not in (select date from d)
--      and g::date::text not in (select date from hol);
-- ============================================================================
