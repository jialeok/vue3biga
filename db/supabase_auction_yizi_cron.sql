-- ============================================================================
-- 「竞价一字」看板数据源时间表（pg_cron）— 在 Supabase Dashboard → SQL Editor 执行
--
-- 作用：每个交易日【北京 09:25】调用 auction-yizi-fetch Edge Function，
--       抓猫抓数据 daily_auc_fd（竞价一字）→ 整日对齐写入 auction_yizi。
--
-- ⚠️ 与 bidding-a / limit-pool-fetch 完全解耦：
--    本文件只新增 auction-yizi-* 一个 job、只调 auction-yizi-fetch 一个函数；
--    不修改、不重启、不影响任何其它看板的 cron 与路由。
--    两个函数各有独立 URL / 独立令牌 / 独立猫抓 key（另一只小号）。
--
-- ════════════════════════════════════════════════════════════════════════════
-- ⛔ 为什么只有一条定时（绝不加 09:26 的 job）
-- ════════════════════════════════════════════════════════════════════════════
--   需求原话：「每天早上 9点25-26分自动获取…（不要超过26分）」。
--   pg_cron 的最小粒度是【1 分钟】，加不出 09:25:30 这种秒级补跑；
--   若再加一条 09:26 的 job，最晚动作会落在 09:26:0x 之后 → 【越过 26 分】。
--   因此本方案把「稳妥」放在【函数内部】而不是【多排 cron】：
--     · cron 准点 09:25:00 触发；
--     · 函数内部 09:25:00 → 09:25:55 每 ~8 秒打一次上游（见 index.ts 的
--       WINDOW_START / WINDOW_DEADLINE / POLL_MS）；
--     · 一旦拿到「有一字数据」立刻写库返回；到 09:25:55 仍无 → 【不写库】并返回
--       ok:false（§10 未就绪 ≠ 没有，宁可空着也不写错值）。
--   → 全文最晚动作 = 09:25:55，⛔ 绝不越过 09:26。
--
--   万一 09:25 这一趟真失败了（上游限流 / 函数冷启动卡顿 / 库暂时不可用），
--   补救方式【不是加 09:26 的 job】，而是手动补抓一次（幂等，见文末 4.4）：
--     https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/auction-yizi-fetch/fetch?token=123456
--   —— tradedate 已把日期钉死，盘中/盘后任何时候补抓，取到的仍是【该日 9:25 的快照】
--      （fa_0915~fa_0925 / fa_0920f / fa_0925l 都是当日终值，不会漂移）。
--
-- ════════════════════════════════════════════════════════════════════════════
-- 前置（必须先做完，否则 job 会稳定失败）
-- ════════════════════════════════════════════════════════════════════════════
--   0) ★ 在 SQL Editor 执行 db/create_auction_yizi.sql 建 auction_yizi 表。
--        漏这一步的报错长相是（前端红字）：
--        `Could not find the table 'public.auction_yizi' in the schema cache`（PGRST205）
--        —— 这不是「调用方法不对」，就是表还不存在。
--   1) 已部署 Edge Function auction-yizi-fetch
--      （Dashboard → Functions → 新建，粘贴 supabase/functions/auction-yizi-fetch/index.ts）；
--   2) Secrets 里设置【另一只猫抓小号】的 key：NUMCAT_API_KEY_YIZI
--      （备选变量名 NUMCAT_API_KEY_YIZI_AUCTION）
--      ⛔ 默认【不】回退主账号 NUMCAT_API_KEY —— 本看板与早盘竞价看板额度互不侵占。
--         确实要它在小号失败时借用主号，才显式设 NUMCAT_YIZI_KEY_FALLBACK=1。
--   3) Secrets 里设置 AUCTION_YIZI_FETCH_TOKEN
--      （未设置则回退复用 FETCH_TOKEN，此时下面的 token=123456 可直接跑通）；
--   4) Verify JWT 开或关都能跑本 cron（下面的 net.http_post 带 anon 的 apikey +
--      Authorization，平台鉴权直接通过）；只有想用【浏览器直接打开 /health、/probe】
--      时才需要关掉它。
--
-- 自检（出问题先开这两个，按顺序）：
--   .../functions/v1/auction-yizi-fetch/health
--        → 看 numcatKeySource 是不是 NUMCAT_API_KEY_YIZI（显示 NUMCAT_API_KEY_YIZI_AUCTION
--          说明主变量没配、走了备选；显示「未配置」说明两把都没配）
--        → 看 endpoints 是不是你期望的候选顺序
--   .../functions/v1/auction-yizi-fetch/probe?token=123456
--        → 对「每个端点 × 每把 key」各打一次真实上游请求，回显 HTTP 状态 / 耗时 /
--          上游业务码 / 字段名单 / 一字命中数 / 首行样例，并顺带探 auction_yizi 表在不在。
--        → 加 &symbols=000001,600000 可做轻量探测（只请求这两只，更快）。
--
-- 时区：Supabase 数据库默认时区 UTC。
--   北京时间 09:25 = UTC 01:25 → '25 1'
--   先 `show timezone;` 确认你库时区；若已改成 Asia/Shanghai，把 '25 1' 改成 '25 9'。
--
-- 默认令牌：若你没有单独设置 AUCTION_YIZI_FETCH_TOKEN，函数会回退复用 FETCH_TOKEN，
--   此时下面 token= 保持 123456 即可直接跑通（与 db/supabase_limit_pool_cron.sql 同一约定）。
--   若你设置了独立令牌，把下面 token=123456 换成该值。
-- ============================================================================

-- 1) 启用扩展（仅需一次；其它看板已启用则跳过）
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2) 主抓（唯一一条）：北京 09:25（UTC 01:25）→ 周一至周五
--    ⚠️ 不要改成 26 分。窗口收紧（尤其"不要超过26分"）靠的是函数内部轮询，
--       不是靠多排 cron —— 见本文件顶部说明。
select cron.schedule('auction-yizi-09-25', '25 1 * * 1-5', $$
  select net.http_post(
    url     := 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/auction-yizi-fetch/fetch?token=123456',
    headers := '{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg"}'::jsonb,
    body    := '{}'::jsonb,
    -- ⚠️ 函数内部最坏情况会轮询到 09:25:55（约 55 秒）+ 写库校验；90 秒足够，
    --    且 09:26:25 必然结束 —— 仍不越过"26分"这条线要求的是【数据抓取窗口】，
    --    这里只是给 HTTP 调用留的传输超时，最坏情形也只到 09:26 出头，不会去取新数据。
    timeout_milliseconds := 90000
  );
$$);

-- ============================================================================
-- 3) 自检 / 排查（按需执行）
-- ============================================================================

-- 3.1 job 是否登记成功（应看到 auction-yizi-09-25，active=true，schedule='25 1 * * 1-5'）
-- select jobid, jobname, schedule, active from cron.job order by jobname;

-- 3.2 job 最近几次执行状态（status='succeeded' 表示 HTTP 请求已发出，
--     ★ 注意它不代表函数内部 ok —— 函数返回 500 时这里同样是 succeeded）
-- select jobid, status, return_message, start_time
-- from cron.job_run_details
-- where jobid in (select jobid from cron.job where jobname like 'auction-yizi%')
-- order by start_time desc limit 10;

-- 3.3 ★ 真正判断「抓到没有」看这两条：
-- select date, count(*) as cnt, max(updated_at) as last_write
-- from auction_yizi group by date order by date desc limit 20;

-- select run_date, time_point, ok, detail
-- from bidding_fetch_log
-- where job = 'auction-yizi-fetch'
-- order by created_at desc limit 10;
--   detail 里关键字段：
--     written / deleted          本次写入与清理行数
--     upstreamRows               上游返回总行数（全市场）
--     yiziRows                   其中判定为「一字」的行数
--     droppedNoFa                因「9:15~9:25 从未封上涨停价」被丢弃的行数
--     droppedDateMismatch        因「上游返回的 tradedate ≠ 请求日期」被丢弃的行数
--     attempts / elapsedMs       轮询了几轮 / 总耗时
--     lateBySec                  >0 说明这趟迟到了（cron 漏跑/冷启动卡顿），已按补抓处理
--     keySource / endpoint       实际用了哪把 key / 哪个上游端点（专线 or 公网）

-- 3.4 查某天抓到的一字清单（人工核对用）
-- select stock, code, auc_pct_chg, seal_money, fa_count, fa_first, theme_kpl, theme_xgb, is_st
-- from auction_yizi where date = '2026-09-18' order by seal_money desc nulls last;

-- ============================================================================
-- 4) 手动触发（排查 / 补当天 / 补历史某日）——把 <TOKEN> 换成 123456 或你自己的令牌
-- ============================================================================
-- 4.1 只看配置（不回显密钥）：
--     https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/auction-yizi-fetch/health
--
-- 4.2 【出问题先开这个】逐端点逐 key 体检：
--     https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/auction-yizi-fetch/probe?token=123456
--     轻量版（只探两只股票，更快）：… /probe?token=123456&symbols=000001,600000
--
-- 4.3 补「今天」（会按当前时刻判定：在窗口内则轮询到 09:25:55，过了窗口则尝试一轮）：
--     https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/auction-yizi-fetch/fetch?token=123456
--     只打一轮、不等轮询（纯排查用）：… /fetch?token=123456&once=1
--
-- 4.4 补「历史某日 / 指定某日」（跳过窗口与交易日闸门，只尝试一轮）：
--     https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/auction-yizi-fetch/fetch?token=123456&date=2026-09-18
--     ⚠️ 该日会整日对齐（该日快照 = 该次抓取结果）→ 会清理该日「本次已不在池中」的旧行。
--     ⚠️ 上游对该交易日的 9:25 快照是稳定终值，所以盘中/盘后补抓不会取到错值；
--        但若上游已过保留期（久远日期），可能返回空 → 此时函数判「未就绪」，不写库、不删除（安全）。

-- ============================================================================
-- 5) 可选清理（只在你确实想改行为时执行）
-- ============================================================================
-- 下线本次新增的定时（只动这一个 job，不影响其它看板）：
--   select cron.unschedule('auction-yizi-09-25');
--
-- 临时停跑但保留登记（排查期间用）：
--   update cron.job set active = false where jobname = 'auction-yizi-09-25';
--   update cron.job set active = true  where jobname = 'auction-yizi-09-25';
