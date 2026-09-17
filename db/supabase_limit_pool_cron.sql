-- ============================================================================
-- 「涨跌停」看板数据源时间表（pg_cron）— 在 Supabase Dashboard → SQL Editor 执行
--
-- 作用：每个交易日【北京 15:40】调用 limit-pool-fetch Edge Function，
--       抓同花顺「涨停池 + 跌停池」→ 整日对齐写入 limit_pool。
--
-- ⚠️ 与 bidding-a 完全解耦：
--    本文件只新增 limit-pool-* 两个 job、只调 limit-pool-fetch 这一个函数；
--    不修改、不重启、不影响 bidding-a（竞价看板）的任何 cron 与路由。
--    两个函数各有独立 URL / 独立令牌 / 独立同花顺 key（小号）。
--
-- 前置（必须先做完，否则 job 会稳定失败）：
--   0) ★ 在 SQL Editor 执行 db/create_limit_pool.sql 建 limit_pool 表。
--        漏这一步的报错长相是（前端红字）：
--        `Could not find the table 'public.limit_pool' in the schema cache`（PGRST205）
--        —— 这不是「调用方法不对」，就是表还不存在。
--   1) 已部署 Edge Function limit-pool-fetch
--      （Dashboard → Functions → 新建，粘贴 supabase/functions/limit-pool-fetch/index.ts）；
--   2) Secrets 里设置：FUYAO_API_KEY_LIMITPOOL（另一个同花顺小号）、
--      LIMIT_POOL_FETCH_TOKEN（未设置则回退复用 FETCH_TOKEN）；
--   3) Verify JWT 开或关都能跑本 cron（下面的 net.http_post 带 anon 的 apikey + Authorization，
--      平台鉴权直接通过）；只有想用浏览器直接开 /health、/probe 时才需要关掉它。
--   自检（出问题先开这两个，按顺序）：
--     https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/limit-pool-fetch/health
--     https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/limit-pool-fetch/probe?token=123456
--       /health → 看 fuyaoKeySource 是不是 FUYAO_API_KEY_LIMITPOOL（显示回退 = 小号没配上）
--       /probe  → 对「小号/主号」两把 key 各打一次最小上游请求，回显 HTTP 状态 / 耗时 / 上游业务码
--                 + 顺带探 limit_pool 表在不在。上游正常耗时应在 1~5 秒。
--
-- 时区：Supabase 数据库默认时区 UTC。
--   北京时间 15:40 = UTC 07:40 → '40 7'
--   北京时间 16:10 = UTC 08:10 → '10 8'
--   先 `show timezone;` 确认你库时区；若已改成 Asia/Shanghai，把 '40 7' 改 '40 15'、'10 8' 改 '10 16'。
--
-- 为什么排两次（都是幂等 upsert，重跑结果相同）：
--   15:40 是主抓（收盘 40 分钟后，上游涨跌停池已是终态）；
--   16:10 是安全网（主抓若遇上游限流/函数冷启动超时，这一趟会自动补上，
--   代价只有 2~6 次上游请求）。只想跑一次 → 执行文件末尾的「可选清理」。
--
-- 默认令牌：若你没有单独设置 LIMIT_POOL_FETCH_TOKEN，函数会回退复用 FETCH_TOKEN，
--   此时下面 token= 保持 123456 即可直接跑通（与 db/supabase_auction_close_cron.sql 同一约定）。
--   若你设置了独立令牌，把下面两处 token=123456 换成该值。
-- ============================================================================

-- 1) 启用扩展（仅需一次；bidding-a 已启用则跳过）
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2) 主抓：北京 15:40（UTC 07:40）→ 周一至周五
select cron.schedule('limit-pool-15-40', '40 7 * * 1-5', $$
  select net.http_post(
    url     := 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/limit-pool-fetch/fetch?point=limitpool&token=123456',
    headers := '{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg"}'::jsonb,
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);

-- 3) 安全网：北京 16:10（UTC 08:10）→ 周一至周五（幂等，重复跑不产生多余变更）
select cron.schedule('limit-pool-retry-16-10', '10 8 * * 1-5', $$
  select net.http_post(
    url     := 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/limit-pool-fetch/fetch?point=limitpool&token=123456',
    headers := '{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg"}'::jsonb,
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);

-- ============================================================================
-- 4) 自检 / 排查（按需执行）
-- ============================================================================

-- 4.1 job 是否登记成功（应看到 limit-pool-15-40 / limit-pool-retry-16-10，active=true）
-- select jobid, jobname, schedule, active from cron.job order by jobname;

-- 4.2 job 最近几次执行状态（status='succeeded' 表示 HTTP 请求已发出，★ 注意它不代表函数内部 ok）
-- select jobid, status, return_message, start_time
-- from cron.job_run_details
-- where jobid in (select jobid from cron.job where jobname like 'limit-pool%')
-- order by start_time desc limit 10;

-- 4.3 ★ 真正判断「抓到没有」看这两条：
-- select date, board, count(*) as cnt, max(updated_at) as last_write
-- from limit_pool group by date, board order by date desc, board limit 20;

-- select run_date, time_point, ok, detail
-- from bidding_fetch_log
-- where job = 'limit-pool-fetch'
-- order by created_at desc limit 10;

-- 4.4 手动触发一次（补当天 / 补历史某日）——把 <TOKEN> 换成 123456 或你自己的令牌：
-- 当天：  https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/limit-pool-fetch/fetch?token=123456&point=limitpool
-- 历史：  https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/limit-pool-fetch/fetch?token=123456&date=2026-09-14
--   ⚠️ date= 走「手动补抓」，跳过交易日闸门，但仍会整日对齐（该日快照 = 该次抓取结果）。
-- 健康检查：https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/limit-pool-fetch/health

-- ============================================================================
-- 5) 可选清理（只在你确实想改行为时执行）
-- ============================================================================
-- 只保留一次抓取（删掉安全网）：
-- select cron.unschedule('limit-pool-retry-16-10');
--
-- 全部下线：
-- select cron.unschedule('limit-pool-15-40');
-- select cron.unschedule('limit-pool-retry-16-10');
