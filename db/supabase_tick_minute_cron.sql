-- ============================================================================
-- 「分笔买卖」看板服务端定时抓取（pg_cron）— 在 Supabase Dashboard → SQL Editor 执行
--
-- 作用：每个交易日【北京 09:32】调用【已部署的】Edge Function tick-minute-fetch，
--       把当天 auction_watchlist 里【还没抓过】的股票，一次性抓 9:30:00~9:31:00
--       的分笔快照 → 写入 tick_minute_open。
--
-- ════════════════════════════════════════════════════════════════════════════
-- ⛔ 为什么这个文件是 .sql 而不是写进 index.ts（用户 2026-10-12 的原问）
-- ════════════════════════════════════════════════════════════════════════════
--   用户原话：「关于定时cron，你可以写进ts文件，我重新部署下。就可以了」。
--   —— 这件事在 Supabase 上【做不到】，不是「不推荐」：
--     · pg_cron / pg_net 是【数据库扩展】，只能用 SQL 调用（create extension、
--       cron.schedule、net.http_post 都是 SQL 层的东西）；
--     · Edge Function（index.ts）是【被调用方】，它跑在 Deno 里，运行时长上限
--       (Wall Clock) 远小于 24 小时，进程随时会被回收 ⇒ 它【无法】自己「等到 09:32」
--       再执行 —— 把 sleep 写进 ts 只会在冷启动回收时被静默掐掉；
--     · 真正「到点触发」的角色只能由 pg_cron 扮演，而 pg_cron 的唯一入口就是 SQL Editor。
--   ⇒ 本文件【完全不需要重新部署 Edge Function】，直接粘贴进 SQL Editor 跑一次即可。
--     这也是「尽量不动主账号、不动已部署函数」的要求下唯一可行的做法。
--
-- ════════════════════════════════════════════════════════════════════════════
-- ⛔ 它与「浏览器里那个 09:31:05 定时」的关系：不是替代，是【兜底】+ 零重复
-- ════════════════════════════════════════════════════════════════════════════
--   现状（2026-10-12 复读源码确认）：
--     · 浏览器（useTickBoard.js + tick-minute-store.js#_scheduleRetry）在
--       09:31:05 触发一次抓取 —— 主路径，最快；
--     · 但只要浏览器没开 / 那个标签页关了，09:31 就没有任何人去抓 ⇒ 当天永远空白。
--
--   本 cron 补的就是这个缺口，且【绝不重复花钱】：
--     · 触发点 = 北京 09:32:00（UTC 01:32），在浏览器那次（09:31:05）之后；
--     · 请求体里的 items 只含「今天在 auction_watchlist 里、但 tick_minute_open 里
--       【还没有行】」的股票；
--     · 浏览器已经抓完 ⇒ items 为空 ⇒ 下面 where 不成立 ⇒ net.http_post
--       【一次都不发】⇒ 0 次上游调用。
--       （实测依据：src/logic/tick/tick-minute-store.js:261 的
--         missing = list.filter(t => !have.has(t.name) && !attempted.has(t.name))
--         —— 前端自己也会按「库里已有」去重，两边不会各抓一次。）
--     · 反过来，浏览器没开 ⇒ 本 cron 抓全量，用户 09:32 之后随便什么时候打开看板
--       都能【立刻】看到分笔统计 —— 这就是用户要的「不用一定开浏览器了」。
--
-- ════════════════════════════════════════════════════════════════════════════
-- ★ 为什么这里【不】新建一张「决策选票表」（用户提议：决策看板 + 分笔看板共用一张表）
-- ════════════════════════════════════════════════════════════════════════════
--   用户原话：「做一张表给它，就是决策看板的买点和卖点的股票，写入表…两个看板共用一张」
--   调查结论（2026-10-12，源码 + 线上数据实测）：
--     ① 决策看板的买点/卖点【确实只在浏览器内存里】，没有任何表 —— 这点用户猜对了
--        （db/ 下没有 picks 类建表脚本，全仓也没有任何代码写「选股结果」）。
--     ② 但【做这张表并不能省额度，也不能让决策看板变快】：
--        · 分笔抓取的成本是【按调用次数】算的，一次调用最多带 60 只，
--          抓 10 只和抓 30 只是【同一个价】⇒ 用「当天全量名单」当抓取清单，
--          一点都不比「只用选出来的那几只」贵；
--        · 决策看板慢的原因与分笔表【完全无关】—— 是 collectDecisionData 被
--          两个看板各跑了一遍（useDecisionBoard.js:122 与 useTickBoard.js:93），
--          同一份重计算跑两次。加表并不能省掉任何一次计算。
--     ③ 真要「共用一张表」，代价很大且会破坏现有语义：
--        tick_minute_open 的主键是 (date,name)，且「没有这一行」= 前端三种「没有」
--        状态之一（未抓取 / 无数据 / 缺代码）；把决策票塞进同一张表会出现
--        【两个写者写同一行】+ 把「事实」和「结论」混在一张表里（§6 单一真相）。
--     ⇒ 结论：本期【不建表】。要「随时翻看历史选票」的话，单开一张只读的
--        decision_picks 是合理的【下一步】，和分笔抓取彼此独立，不阻塞今天这件事。
--
-- ════════════════════════════════════════════════════════════════════════════
-- ★ 额度账（这才是「尽量不动」的关键，2026-10-12 线上实测）
-- ════════════════════════════════════════════════════════════════════════════
--   上游：猫头鹰 tick_history，免费档【10 次/日】（与猫爪共用同一池，北京 0 点重置）。
--   本 cron 每天花几次？= ceil(当天待抓股票数 / 60)，实测历史每日名单规模：
--       2026-09-25: 61 只   2026-09-28: 61 只   2026-09-29: 47 只   2026-09-30: 42 只
--       2026-10-08: 47 只   2026-10-09: 30 只   （10-07/10-06/…/10-01 是 11 只）
--     ⇒ 61 只会被拆成 2 次上游请求（Edge 的 MAX_SYMBOLS_PER_CALL=60），其余全是 1 次。
--     ⇒ 本 cron 每天 = 1~2 次；且只要浏览器先抓过，就是 0 次。
--   ⚠️ 但请记住：tick-minute-fetch 与 auction-yizi-fetch【共用同一把 key】
--      （两边 /health 都回显 nc_O***HuGJ）⇒ 也共用这 10 次。
--      竞价一字自己占 2 次（1 次 cron + 1 次 09:35 趋势腿），本 cron 占 1~2 次，
--      余量留给早盘竞价 worker 兜底。
--   ★ 因此本文件【刻意只排 1 条 job、只调 1 次】。⛔ 不要再加 09:35 / 09:40 的补抓，
--      那会把免费额度吃干（历史上「实时轮询 3 秒一次 = 15 次/日」就是这么爆掉的）。
--
-- ════════════════════════════════════════════════════════════════════════════
-- ★ 空名单闸门（必须有，不是可选）
-- ════════════════════════════════════════════════════════════════════════════
--   实测：auction_watchlist 的【未来日期不是预铺的】—— 2026-10-12 当时只有 1 行。
--   因此本 cron 的第一道闸门就是「今天没有待抓的股票 ⇒ 一次都不抓」，
--   这同时覆盖了「休市日 / worker 还没写名单 / 名单已全抓完」三种情况（§10 不猜）。
--
-- ════════════════════════════════════════════════════════════════════════════
-- ★ 超时红线（2026-10-10 事故的直接教训）
-- ════════════════════════════════════════════════════════════════════════════
--   规矩：【等上游的那一方（后端）的最坏耗时 < 等后端的那一方（调用方）的最长时间】。
--     · Edge 内部最坏 = TOTAL_BUDGET_MS(15000) × key 把数(≤2) = 30000ms
--       （已部署的那一版是「每端点 20s × 2 端点 = 40000ms」，照样够）；
--     · 本 cron 给的 timeout_milliseconds = 90000ms > 上述任何一个 ⇒ 安全。
--   ⛔ 不要把这个数改小。历史上前端写成 25s（< 后端 40s）就是这个事故的成因。
--
-- 前置（必须先做完，否则 job 会稳定失败）：
--   0) ★ 已执行 db/create_tick_minute_open.sql（表必须存在）；
--   1) ★ 已部署 Edge Function tick-minute-fetch —— 【用现在线上这一版就行，不用重部署】；
--   2) Secrets 里已配 NUMCAT_TICK_API_KEY（或复用 NUMCAT_API_KEY）；
--   3) Verify JWT 开或关都能跑本 cron（下面的 net.http_post 带了 anon 的 apikey +
--      Authorization，平台鉴权直接通过）；只有想用【浏览器直接打开 /health、/probe】
--      时才需要把它关掉。
--
-- 时区：Supabase 数据库默认时区 UTC。
--   北京 09:32 = UTC 01:32 → '32 1'
--   先 `show timezone;` 确认你的库时区；若已被改成 Asia/Shanghai，把 '32 1' 改成 '32 9'。
-- ============================================================================

-- 1) 启用扩展（仅需一次；其它看板已启用则跳过）
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2) 主抓（唯一一条）：北京 09:32（UTC 01:32）→ 周一至周五
--    ⚠️ 为什么是 32 分而不是 31 分：
--      · 函数内部有一道 9:31 闸门（index.ts:633，CONFIG.WINDOW_READY='09:31:00'），
--        早于 09:31:00 打进去会被回 skipped:'too-early'（那一分钟的成交还没走完）；
--      · 浏览器的主路径在 09:31:05 触发，给上游留了 +5 秒；本 cron 排在更后面，
--        既是兜底、又能让「浏览器先抓完 ⇒ 这里 0 次调用」这条去重真正生效。
--      · pg_cron 最小粒度是【1 分钟】，排不出 09:31:30；32 分是安全且最靠近的整分点。
select cron.schedule('tick-minute-09-32', '32 1 * * 1-5', $job$
  with t as (
    select (now() at time zone 'Asia/Shanghai')::date::text as d
  ),
  miss as (
    select jsonb_agg(
             jsonb_build_object('name', w.stock, 'code', w.code)
             order by w.stock
           ) as items
      from auction_watchlist w, t
     where w.date = t.d
       -- ★ 只取【库里还没有】的：浏览器 09:31:05 抓过的那批在这里被自动排除
       and not exists (
             select 1
               from tick_minute_open tm
              where tm.date = t.d
                and tm.name = w.stock
           )
  )
  select net.http_post(
    -- 用【已部署的】函数：路径以 /minute 结尾即命中该路由；
    -- ⛔ 不带 token 参数 = 跳过函数内部的令牌校验（与浏览器端的调用口径一致）。
    --    若日后要锁死，就设 Secret TICK_FETCH_TOKEN，再在这里追加 ?token=<值>。
    url     := 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/tick-minute-fetch/minute',
    headers := '{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg"}'::jsonb,
    body    := jsonb_build_object(
                 'date',  (select d from t),
                 'items', coalesce((select items from miss), '[]'::jsonb)
               ),
    -- 见文件头「超时红线」：必须 > 后端最坏耗时（30000ms）。
    timeout_milliseconds := 90000
  )
  -- ★ 空名单闸门：今天没有「待抓」的股票 ⇒ where 不成立 ⇒ 一次上游都不打（0 次调用）
  where (select items from miss) is not null
    and jsonb_array_length((select items from miss)) > 0;
$job$);

-- ============================================================================
-- 3) 自检 / 排查（按需执行）
-- ============================================================================

-- 3.1 job 是否登记成功（应看到 tick-minute-09-32，active=true，schedule='32 1 * * 1-5'）
-- select jobid, jobname, schedule, active from cron.job order by jobname;

-- 3.2 job 最近几次执行状态（status='succeeded' 只表示 HTTP 请求已【发出】，
--     ★ 不代表函数内部 ok —— 函数返回 500 时这里同样是 succeeded）
-- select jobid, status, return_message, start_time
-- from cron.job_run_details
-- where jobid in (select jobid from cron.job where jobname like 'tick-minute%')
-- order by start_time desc limit 10;

-- 3.3 ★ 真正判断「抓到没有」看这两条：
-- select date, count(*) as rows, max(updated_at) as last_write
-- from tick_minute_open group by date order by date desc limit 20;

-- select run_date, ok, detail
-- from bidding_fetch_log
-- where job = 'tick-minute-fetch'
-- order by created_at desc limit 10;
--   detail 里关键字段：
--     written / readBack        本次写入行数 / 回读校验到的行数（§11 写入要带回读证据）
--     symbols / upstreamRequests 点名几只 / 实际打了几次上游（= 额度消耗，2026-10-12 新增）
--     keyPasses                 逐把 key 的结果（usedQuota=true 说明那一刻额度已用完）
--     uncovered                 因总预算用完而没取到的票（既不是「无数据」也不是「抓到了」）
--     budgetExhausted           true = 预算打满，下一天/下一次该重试

-- 3.4 手动等效触发（不改 cron，只验一次「这条 SQL 到底会不会发请求」）——
--     把下面整段粘贴执行，看返回的 request id 是否为 NULL：
--       NULL   ⇒ 今天已抓完 / 今天没有名单（= 0 次调用，符合预期）
--       非 NULL ⇒ 已把请求排进 net.http_request_queue
-- select net.http_post(
--   url     := 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/tick-minute-fetch/minute',
--   headers := '{"Content-Type":"application/json","apikey":"<ANON>","Authorization":"Bearer <ANON>"}'::jsonb,
--   body    := jsonb_build_object(
--                'date', (now() at time zone 'Asia/Shanghai')::date::text,
--                'items', coalesce((
--                  select jsonb_agg(jsonb_build_object('name', w.stock, 'code', w.code))
--                    from auction_watchlist w
--                   where w.date = (now() at time zone 'Asia/Shanghai')::date::text
--                     and not exists (select 1 from tick_minute_open tm
--                                      where tm.date = w.date and tm.name = w.stock)
--                ), '[]'::jsonb)
--              ),
--   timeout_milliseconds := 90000
-- );

-- 3.5 看 pg_net 实际发出去的结果（有没有真的成功、函数回了什么）
-- select id, status_code, content, error_msg, created
-- from net._http_response order by created desc limit 10;

-- ============================================================================
-- 4) 可选清理（只在你确实想改行为时执行）
-- ============================================================================
-- 下线本次新增的定时（只动这一个 job，不影响其它看板）：
--   select cron.unschedule('tick-minute-09-32');
--
-- 临时停跑但保留登记（排查期间用）：
--   update cron.job set active = false where jobname = 'tick-minute-09-32';
--   update cron.job set active = true  where jobname = 'tick-minute-09-32';
--
-- ★ 若某天 cron 漏跑（上游限流 / 库抖动），补救【不是加排 cron】，而是手动补一次
--   （幂等：只抓库里没有的；遇 403 额度耗尽会立刻停手）：
--     POST https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/tick-minute-fetch/minute
--     body: {"date":"2026-10-12","items":[{"name":"上海洗霸","code":"603200"}]}
--   ⛔ 补历史日期属于「花明天的额度办昨天的事」，务必先确认当天额度没用完。
-- ============================================================================
