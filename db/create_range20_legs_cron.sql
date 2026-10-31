-- create_range20_legs_cron.sql — 「逐日腿」云端自愈定时任务（pg_cron + pg_net）
-- ============================================================
-- 配套 Edge Function：range20-precompute 的 `?healOnly=1` 入口
-- （见 db/edge/range20-precompute/index.ts 的 healDailyLegsFromMetrics）
--
-- ══════════════════════════════════════════════════════════════════════════════
-- 一、这张表为什么必须每天补齐
--
--   20 日涨幅靠 `stock_daily_pct`（每只票每个交易日的收盘涨幅，一行一根「腿」）。
--   次日算 20 日窗口时缺一天，compound20 会把它当成【停牌】静默跳过 —— 不报错、不显示，
--   但窗口少算一天，20 日涨幅直接偏小。这是最难查的一类错。
--
--   而「今天这根腿」原先**只有一个写入点**：15:05 收盘轮，且**唯一依赖同花顺 K 线**。
--   2026-10-30 同花顺整条挂掉（150s 不返回 / HTTP 546 / 502）⇒ 那天只写了 0 行，
--   表里仅剩 42 行历史兜底，而正常交易日是 411 行。
--
-- 二、现在的自愈链路（纯本库，零上游依赖）
--
--   09:25 竞价轮  → 先 heal 再算今天（历史腿补齐才敢算）
--   15:05 收盘轮  → 写今天那根腿（同花顺可用就写 src='kline'，最真）
--   16:00 worker  → 把 market_metrics.change_pct 覆盖成【收盘涨幅】，
--                   并写入 updated_by='auto-fetch-worker-close'、updated_at=16:00
--   16:30 本任务  → heal：拿 16:00 那批带 '-close' 标记的行补腿 ✅ 当天就齐
--   08:50 本任务  → heal：早盘前的保险（万一 16:30 那次抖动 / 函数超时）
--   次日 09:25    → heal 再跑一次（三重保险，且是幂等的，补过就 skip）
--
--   安全闸（写在函数里，⛔ 不要改）：
--     · 只补缺的 (date,stock)，已有行一律不碰（尤其 src='kline' 真值）⇒ 纯加法、幂等；
--     · 必须有「收盘轮写过」的证据：updated_by 含 'close' 且 updated_at >= 当日北京 15:00；
--       ⛔ 没证据的一条都不写（宁可缺，也不拿竞价涨幅冒充收盘涨幅）；
--     · 停牌 / 无值 ⇒ 跳过，⛔ 绝不写 0%；
--     · 落库标 src='metrics_close'，不冒充 kline。
--
--   实测覆盖（2026-10-30，48 只名单）：新闸门 48/48 全可写；
--   旧闸门（用「change_pct == auc_pct_chg 就跳过」）只有 42/48 ——
--   误杀了 5 只竞价即封板的一字板（上海沪工/东贝集团/凯众股份/赛福天/青岛食品）
--   和 1 只低波动巧合票（福莱新材）。这正是 2026-11-01 修掉的那个 bug。
--
-- 三、这一轮还顺带补两张【结果表】（腿补完，0 上游请求就能算）
--
--   16:30 / 08:50 的 healOnly 入口在 heal 之后会连着跑两个补算（都只补缺的、幂等、可反复重跑）：
--
--     backfillRange20FromLegs → stock_range20_pct（20 日涨幅，leg='close'）
--       为什么：15:05 收盘轮算 close 口径时 canFast=false（只对 auc 开快路径）⇒ **一律走同花顺**。
--       同花顺一断那一轮只写得出几十行。实测 2026-10-30 close 只有 50 行，而前后每天都是 410~413 行
--       ⇒ 前端点开 20 日涨幅，绝大多数票既没云端数据、现场打 K 线又断 ⇒ 屏幕只剩「…」。
--       口径：每票取【它自己】最近 20 个有腿的交易日（停牌票能回溯），与前端 compound20 一致。
--
--     backfillRange10FromLegs → stock_range_pct（10 日涨幅）
--       为什么：这张表只由 worker 的 9:25 / 16:00 两轮写，**只写当天名单**，上游一断就缺一批。
--       实测 2026-10-08~10-23：每天名单 78~92 只，表里 87~133 行，每天有 9~26 只名单票
--       **完全没有行**（9 天共 219 条空洞）⇒ 前端这一列同样不渲染。
--       口径与 20 日**刻意不同**：10 日 = 全局统一窗口 [T-9, T] 共 10 个真实交易日
--       （对齐 range-window.js#buildRangeRows），窗口内缺哪天就跳过哪天、days 如实 < 10。
--       ⛔ 别把两个函数合并 —— 混用会让停牌票算出一个别人无法比较的数。
--
--   共同安全闸：只补【当天名单里缺的票】；一根腿都没有 ⇒ 不写空行；
--   腿表里没有该日（假期/未开盘）⇒ 直接返回；名单外一律不写（这两张表还喂着龙位/决策看板/卖点段）。
--
-- ⚠️ 执行前把 <ANON_KEY> 替换成你项目的 anon public key
--    （Dashboard → Project Settings → API → Project API Keys → anon public；
--     anon key 本来就是公开的前端钥匙，写进 cron 无泄密风险。
--     ‼️ 与 db/create_range20_cron.sql 里那两条用的是同一个 key）
-- ============================================================


-- ① 扩展（已启用则跳过；与 create_range20_cron.sql 共用）
create extension if not exists pg_cron;
create extension if not exists pg_net;


-- ② 删旧任务（本脚本可重复执行，幂等）

-- 旧版本（腾讯通道，已停用）—— 留着这几行是为了让老环境重跑时清掉它
do $$
begin
  perform cron.unschedule('range20-legs-close');
exception when others then null;
end $$;

do $$
begin
  perform cron.unschedule('range20-legs-morning');
exception when others then null;
end $$;

do $$
begin
  perform cron.unschedule('range20-heal-close');
exception when others then null;
end $$;

do $$
begin
  perform cron.unschedule('range20-heal-morning');
exception when others then null;
end $$;


-- ③ 任务一：收盘后当天自愈（北京 16:30 = UTC 08:30，周一~五）
--    为什么是 16:30：worker 16:00 收盘轮刚把 change_pct 覆盖成收盘涨幅并打上 '-close' 标记，
--    等 30 分钟让它落完整库，再补 —— 这样**当天**腿就齐了，不用拖到次日。
select cron.schedule(
  'range20-heal-close',
  '30 8 * * 1-5',
  $job$
  select net.http_post(
    url := 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/range20-precompute?token=range20-cron-2026&healOnly=1',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <ANON_KEY>'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $job$
);


-- ④ 任务二：早盘前保险（北京 08:50 = UTC 00:50，周一~五）
--    09:25 那轮预计算之前必须腿齐，否则它只能退回逐只拉 K 线（慢，且现在同花顺不可用）。
select cron.schedule(
  'range20-heal-morning',
  '50 0 * * 1-5',
  $job$
  select net.http_post(
    url := 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/range20-precompute?token=range20-cron-2026&healOnly=1',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <ANON_KEY>'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $job$
);


-- ══════════════════════════════════════════════════════════════════════════════
-- ⑤ 【备用】腾讯前复权日线兜底 —— 默认不挂 cron，只在应急时手动触发
--
--   函数里另有 `?legsOnly=1` 入口（backfillLegsOnly），走腾讯日线（src='qt'），
--   用途：万一 worker 16:00 也挂了、market_metrics 压根没更新，heal 就无从下手。
--
--   ⚠️ 为什么不挂 cron：腾讯 web.ifzq.gtimg.cn 对高频请求会触发 WAF，
--     实测连续 372 次请求后直接 HTTP 501（跳 waf.tencent.com），等 100 秒仍未解封。
--     每天 50 只的量风险不大，但没必要为一个已经有兜底的场景去踩这个雷。
--
--   应急手动触发（SQL Editor）：
--     select net.http_post(
--       url := 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/range20-precompute?token=range20-cron-2026&legsOnly=1',
--       headers := jsonb_build_object('Content-Type','application/json',
--                                     'Authorization','Bearer <ANON_KEY>'),
--       body := '{}'::jsonb, timeout_milliseconds := 60000);
--   或指定某一天：追加 &date=2026-10-30
-- ══════════════════════════════════════════════════════════════════════════════


-- ============ 部署后自检（在 SQL Editor 里逐条跑）============

-- ① 四条任务是否都登记了（应有 range20-auc-precompute / range20-close-precompute /
--    range20-heal-close / range20-heal-morning）：
--   select jobname, schedule, active from cron.job order by jobname;

-- ② 最近触发是否成功：
--   select j.jobname, d.status, d.start_time
--     from cron.job_run_details d join cron.job j on j.jobid = d.jobid
--    order by d.start_time desc limit 10;

-- ③ 函数返回（应看到 ok=true / days / healed 数组）：
--   select created, status_code, substring(content from 1 for 400) as body
--     from net._http_response order by created desc limit 10;

-- ④ 腿表最近 10 个交易日行数（健康值 400~415；某天骤降到两位数 = 那天没补上）：
--   select date, count(*) as rows,
--          count(*) filter (where src = 'qt')            as qt_rows,
--          count(*) filter (where src = 'kline')         as kline_rows,
--          count(*) filter (where src = 'metrics_close') as metrics_rows
--     from stock_daily_pct
--    where date >= (current_date - 20)
--    group by date order by date desc limit 10;

-- ⑤ 当天名单的覆盖缺口（应返回 0 行；有行就是还没补上的票）：
--   with w as (select distinct stock from auction_watchlist where date = current_date),
--        l as (select distinct stock from stock_daily_pct where date = current_date)
--   select w.stock from w left join l using (stock) where l.stock is null;
