-- ============================================================================
-- 竞价一字看板「趋势图」缓存表 yizi_trend
-- 应用层：src/data/yizi-trend.js（读） / src/logic/yizi/yizi-trend.js（编排）
--         src/logic/yizi/trend-model.js（纯函数：组装 5 日序列）
--         src/views/AuctionYiziBoard.vue（展开面板，4 张 TrendChart）
-- 写入者：Supabase Edge Function auction-yizi-fetch 的 /trend 路由（⛔ 前端绝不直连上游）
-- 上游  ：猫抓【竞价一字同一只小号】（NUMCAT_API_KEY_YIZI）上的【另外两个 apiname】——
--         ⛔ 不是 9:25 快照用的 daily_auc_fd（那个端点只支持【单日 tradedate】，取不了区间）
--         ① 竞价腿 daily_auc → auc_vol(手) / auc_pct_chg / auc_to_pre_vol_pct
--         ② K 线腿  daily     → pct_chg
--         两条腿都是「窗口内**全部股票** = 1 次请求」（params: symbols + startdate + enddate）
--         ⇒ 注意：换的是 **apiname、不是 key** —— 仍然是那只小号（用户明确要求「不要搞混了」）
--
-- 【为什么需要落库缓存】
--   · 小号猫抓额度每天只有 10 次，9:25 的自动抓取还要占 1~2 次；
--   · 趋势要「近 5 个交易日」、十日涨幅要「近 10 个交易日」，若每次打开看板都现拉
--     = 每天 N 次 × 2 次请求 ⇒ 必然把 9:25 抓取饿死；
--   · 落库后：每个交易日只新增 1 个日期，摊薄到 2 次/天封顶，且跨设备 / 跨会话 0 消耗。
--   · 🔴 2026-09-20 起本表【一表两用】：change_pct 同时供「趋势图」与「十日涨幅（通道一）」使用
--     ⇒ 竞价一字算十日涨幅时是【纯读库、0 上游请求】，彻底不必碰早盘竞价的主账号额度。
--
-- 【两条腿的请求形态（★ 额度关键：整窗口 = 1 次请求，⛔ 不是「每天一次」）】
--   竞价腿 daily_auc：params { symbols:'c1,c2,…', startdate:'YYYYMMDD', enddate:'YYYYMMDD' }
--                     → 一次拿回「窗口内每一天 × 每一只」的 auc_vol / auc_pct_chg / auc_to_pre_vol_pct
--   K 线腿 daily    ：同形态 → 一次拿回窗口内每一天的 pct_chg
--   ⇒ 10 天窗口 = 2 次请求（两腿各 1 次），而不是 20 次。
--
-- 【为什么本表不需要「全市场」】
--   因为竞价腿是「按窗口 + 按股票」一次抓回来的：某只股票第一次被请求时，它**整个窗口**的
--   历史就同时写进来了（不存在「第二天池子换人、历史缺新股票」的问题）。
--   ⚠️ 因此本表只存【被请求过的池子股票】，体积很小（≈ 池子只数 × 天数），无需滚动清理；
--      下面的滚动清理仍然保留，纯粹是为了「万一手工补抓了很长的窗口」兜底。
--
-- 【单位口径（与既有看板一致，⛔ 不要另立一套）】
--   · auc_vol    = 猫抓 auc_vol 原样（单位【手】）；前端展示「竞价量(万)」时 /100（1万=100手）
--                  —— 与早盘竞价看板 volume 字段同一换算（logic/auction/auction-numcat.js#668、
--                     workers/bidding-auto-fetch/logic/morning-workflow.js#551）
--   · yest_volume = auc_vol(手) / auc_to_pre_vol_pct（单位【万股】）
--                  ⚠️ 与 morning-workflow.js#567 的「反推」口径同一式（该字段是百分比数值，如 35.2）
--   · change_pct / auc_pct_chg = text（与 auction_watchlist / auction_yizi 同口径：text 存百分比文本）
--   · source     = 'numcat'（本表当前只有小号猫抓一个上游；将来若引入同花顺 K 线回落，标 'fuyao_kline'）
--
-- 【§10 红线】本表是「附加信息」的缓存：读失败 / 缺失只让对应曲线点变少或显示 '-',
--   ⛔ 绝不影响 auction_yizi 的池子渲染，也绝不被当成「当天没有一字」的依据。
--
-- 执行方式：Supabase Dashboard -> SQL Editor -> 新建 Query -> Run（幂等，可重复执行）
-- ============================================================================

create table if not exists yizi_trend (
  date          text        not null,   -- 交易日 YYYY-MM-DD
  stock         text        not null,   -- 股票简称（与 auction_yizi.stock / stock_topics.stock 同键）
  code          text,                   -- 规整后的 6 位纯代码

  -- 竞价腿（来源 = 小号 daily_auc，整窗口一次请求）
  auc_vol       numeric,                -- 竞价量（单位【手】，展示时 /100 = 万股）
  auc_pct_chg   text,                   -- 竞价涨幅文本，形如 "+10.02"

  -- K 线腿（来源 = 小号 daily；昨日成交量由竞价腿的 auc_to_pre_vol_pct 反推）
  yest_volume   numeric,                -- 昨日成交量（万股）= auc_vol(手) / auc_to_pre_vol_pct
  change_pct    text,                   -- 当日涨幅文本，形如 "+3.25"

  source        text,                   -- 'numcat'（本表唯一上游）；将来引入同花顺回落时标 'fuyao_kline'
  updated_at    timestamptz default now(),
  primary key (date, stock)
);

comment on table yizi_trend is
  '竞价一字看板「趋势图」缓存：按 (date, stock) 存竞价量/竞价涨幅/昨日成交量（小号 daily_auc，整窗口一次请求）+ 当日涨幅（小号 daily）。前端只读本表，抓取由 auction-yizi-fetch 的 /trend 路由负责（只补缺口、从不删除）。';
comment on column yizi_trend.auc_vol is '竞价量（单位「手」，猫抓 auc_vol 原样）；展示「竞价量(万)」= 本值 / 100';
comment on column yizi_trend.auc_pct_chg is '竞价涨幅文本 "+10.02"（与 auction_yizi.auc_pct_chg 同口径）';
comment on column yizi_trend.yest_volume is '昨日成交量（万股）= auc_vol(手) ÷ auc_to_pre_vol_pct；与该字段缺失时留 NULL（⛔ 不补 0）';
comment on column yizi_trend.change_pct is '当日涨幅文本 "+3.25"（猫抓 daily 的 pct_chg 原样，text 与其它表同口径）';
comment on column yizi_trend.source is '本行数据来源：numcat（小号猫抓，当前唯一来源）；将来引入同花顺 K 线回落时标 fuyao_kline';

-- 行级安全：与 auction_yizi / limit_pool 等保持一致（anon 全开放，前端只读）
alter table yizi_trend enable row level security;

drop policy if exists "allow_all_yizi_trend" on yizi_trend;
create policy "allow_all_yizi_trend"
  on yizi_trend for all to anon using (true) with check (true);

-- 看板查询形态：date in (窗口 5 天) and stock in (池内若干只) → 复合索引覆盖
create index if not exists idx_yizi_trend_date on yizi_trend(date);
create index if not exists idx_yizi_trend_date_stock on yizi_trend(date, stock);
-- /trend 路由回写 K 线腿时按 code 定位当日池内股票
create index if not exists idx_yizi_trend_code on yizi_trend(code);

-- 让 PostgREST 立刻刷新 schema cache（否则前端可能红字 PGRST205）
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- 定时补腿（每个交易日北京 09:35 调一次 /trend）—— ★ 本看板【唯一的自动数据任务】
--   为什么放在 09:35（而不是 9:25 那一分钟）：
--     ① 9:25 那条腿（auction-yizi-fetch /fetch）在北京 09:25:00~09:25:55 跑完 → 池子此刻才落库；
--        早于它跑，/trend 读 auction_yizi(date) 会读到空池子（等于白烧 1 次小号额度）。
--     ② /trend 自带【北京 09:20~09:30 上游禁用窗口】（保护 9:25 快照抓取），其间调用一律不发上游。
--     ⇒ 09:35 是本看板能自动取数的最早安全时刻，**仍是同一个交易日**，不影响「当天数据当天落库」。
--   为什么 window=10（2026-09-20 由 5 改为 10）：
--     · yizi_trend.change_pct 现在【一表两用】：既画趋势图（取最近 5 天），
--       又是本看板「十日涨幅」通道一的数据源（window=10 才覆盖得下 [T-9, T]）。
--     · 好处：竞价一字算十日涨幅时 **0 上游请求** —— 直接读这张表，⛔ 不必再去打
--       numcat-proxy（那是早盘竞价的主账号额度，用户明确要求两个账号额度互不侵占）。
--     · 代价：每天 2 次请求（两腿各 1 次，整窗口一次抓回），远低于 /trend 的每日预算 6。
--   ⚠️ 另一条 cron（9:25 抓池子）见 db/supabase_auction_yizi_cron.sql，⛔ 两条必须错开。
--   幂等：cron.schedule 对同名 job 是【更新语义】⇒ 重复执行不会产生重复 job。
--   想下线 / 暂停：见文末自检区。
--   🔴 生效方式：本文件是 SQL 脚本，改完必须【在 SQL Editor 重新执行一次】
--      （同名的 cron.schedule 会被更新为新窗口，不会产生重复 job）。
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 北京 09:35 = UTC 01:35（'35 1'）；只排周一~周五，函数内部再按本地日历判交易日。
-- ★ /trend 路由【不校验 token】，所以这里 URL 不带 token 也能跑；
--   仍带上 apikey/Authorization 是为了兼容「Verify JWT = 开」的函数（平台鉴权直接通过）。
select cron.schedule('yizi-trend-0935', '35 1 * * 1-5', $$
  select net.http_post(
    url     := 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/auction-yizi-fetch/trend?window=10',
    headers := '{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg"}'::jsonb,
    body    := '{}'::jsonb,
    -- 两条腿各 1 次请求（25s 超时/次）+ 读表 → 30 秒足够；超时也只是少补一次，下次展开会再补。
    timeout_milliseconds := 30000
  );
$$);

-- ---------------------------------------------------------------------------
-- 滚动清理（兜底）：正常用法下本表只存「池子股票 × 天数」，体积很小、无需清理；
-- 保留这条是为了「万一手工补抓了很长的窗口」时体积有界（保留 60 个自然日）。
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- cron.schedule(名字, 时间, 命令) 对同名 job 是【更新语义】⇒ 重复执行本文件不会产生重复 job
    perform cron.schedule(
      'yizi-trend-prune',
      '0 3 * * *',
      $job$delete from yizi_trend where date < to_char((now() at time zone 'Asia/Shanghai') - interval '60 days', 'YYYY-MM-DD')$job$
    );
  end if;
end $$;

-- 手动清理（等价于上面的 cron）：
-- delete from yizi_trend where date < to_char((now() at time zone 'Asia/Shanghai') - interval '60 days', 'YYYY-MM-DD');

-- 自检（执行完后跑一遍）：
-- select count(*) as rows, count(distinct date) as days, min(date), max(date) from yizi_trend;
-- select date, count(*) filter (where auc_vol is not null) as auc_rows,
--        count(*) filter (where change_pct is not null) as pct_rows
--   from yizi_trend group by date order by date desc limit 10;
-- select jobname, schedule, active from cron.job where jobname in ('auction-yizi-09-25','yizi-trend-0935','yizi-trend-prune');
-- job 最近执行状态：
-- select jobid, status, return_message, start_time from cron.job_run_details
--  where jobid in (select jobid from cron.job where jobname like 'yizi-trend%') order by start_time desc limit 10;
-- /trend 自己的运行日志（含 requests / skipped / written）：
-- select run_date, time_point, ok, detail from bidding_fetch_log
--  where job = 'auction-yizi-trend' order by created_at desc limit 10;
-- 下线定时：select cron.unschedule('yizi-trend-0935');
-- 暂停/恢复：update cron.job set active = false where jobname = 'yizi-trend-0935';
