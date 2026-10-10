-- ============================================================================
-- 分笔买卖表 tick_minute_open
-- 应用层：src/data/tick-minute.js（读写） / src/logic/tick/*（明细推导 + 红绿统计）
--         src/views/TickBoard.vue（「分笔买卖」看板，独立组件，挂在「决策」看板下面）
-- 上游：猫头鹰数据（market 版）—— tick_history（分笔历史）
--   日内专线   深圳 https://sz.meoz.cn:6688/api
--              上海 https://sh.meoz.cn:6688/api
--   抓取执行者：Supabase Edge Function tick-minute-fetch
--               （独立函数 / 独立表 / 独立 Secret，详见该文件头）
--
-- 【⚠️ 与既有看板彻底解耦】
--   · 独立 Edge Function：supabase/functions/tick-minute-fetch/index.ts
--   · 独立 Secret：NUMCAT_TICK_API_KEY（优先）→ 回退 NUMCAT_API_KEY（用户已确认
--                  同一把猫抓 key 同时可用猫头鹰的数据）
--                   TICK_FETCH_TOKEN（函数自身鉴权，浏览器端路由不需要）
--   · 独立表：tick_minute_open（不复用、不写入 auction_watchlist / market_metrics /
--             limit_pool / auction_yizi / yizi_trend 任何一张）
--   · ⛔ 与「早盘竞价看板」的 numcat-proxy、以及「竞价一字」的 auction-yizi-fetch
--      完全独立；本表只由 tick-minute-fetch 写。
--
-- 【产品口径（用户 2026-10-10 原话）】
--   · 只看【9:30:00 ~ 9:31:00】这一分钟（左闭右开，上游 start_time 含 / end_time 不含），
--     只看【决策看板选中】的那些买点 / 卖点股票。
--   · 判据 = 这一分钟内【每一笔】的成交价与上一笔相比：涨（红）/ 跌（绿）/ 平（绿，按用户口径并入下跌）。
--     这一分钟里「上涨数 > 下跌数」⇒ 开盘强；反之 ⇒ 开盘弱。用户拿它复核
--     竞价买 / 竞价卖 / 尾盘买 / 尾盘卖 四个判断。
--   · 数据源【只能是猫头鹰 tick_history】：东方财富的逐笔非常不稳定，⛔ 本功能
--     【不做任何东财兜底】（用户明确禁止）。
--
-- 【为什么落库而不是每次现拉】
--   ① §6 单一真相：一份数据、一次抓取，跨设备 / 多次打开共用；
--   ② §8：跨设备共享的业务数据必须上云；
--   ③ 9:30~9:31 的分笔是【当日瞬时快照】语义 —— 上游只保留「已发布」的数据，
--      晚抓 / 隔天抓会拿不到或拿到别的批次 ⇒ 当天抓到就必须落库；
--   ④ 落库后「同一票同一天」不会再重复抓（前端按 (date,name) 去重）。
--
-- 【⚠️ 本表只存【原始事实】，不存任何业务结论】
--   pens 里每一条 = 上游一个快照的原始读数（时间 / 成交价 / 本快照成交量）。
--   「红 / 绿 / 平怎么算」「平盘算不算下跌」「量的单位怎么显示」全部在
--   src/logic/tick/tick-minute.js 一处实现（§6）——
--   落库时就把结论算好 = 日后改口径必须连带重刷历史表，而且会出现第二个真相源。
--   自检想直接看结论时，用文件末尾的 SQL 片段现算即可。
--
-- 执行方式：Supabase Dashboard -> SQL Editor -> 新建 Query -> Run（幂等，可重复执行）
-- ============================================================================

create table if not exists tick_minute_open (
  date        text        not null,   -- 交易日 YYYY-MM-DD（由上游 tradedate 的 YYYYMMDD 归一）
  name        text        not null,   -- 股票简称（与 stock_topics.stock / auction_yizi.stock 同键，便于跟决策看板对上）
  code        text,                   -- 6 位纯代码（= 上游 symbol；上游口径：不含交易所后缀）

  -- 当日开盘价（= 9:25 集合竞价的成交价）。用途：本分钟【第一笔】的涨跌基准 ——
  -- 第一笔的「上一笔交易」就是集合竞价的最后一笔，其成交价 = 开盘价。
  -- ⚠️ 上游没给（null）时，第一笔的方向判定为【未知】，计入「未知」而不是硬算成平盘（§10）。
  open_price  numeric,

  -- 本分钟的原始快照序列（数组按时间升序）：
  --   [{ "t": "09:30:03", "p": 10.36, "v": 1200 }, ...]
  --   t = 快照时间 HH:MM:SS.SSS（原样保留上游 time 的时分秒毫秒）
  --   p = 该快照的最新成交价（上游 close 字段；null = 上游缺值）
  --   v = 本快照【新增】成交量（单位：【手】）= 本行 vol − 上一行 vol（上游 vol 是【累计】成交量）
  --       ★ 2026-10-10 实测更正：上游 vol 的差分值【本身就是手】，不要再 ÷100。
  --         证据：用户对照东财，东财 1129 ↔ 本表 11.29（差正好 100 倍）；且线上 76 个差值里
  --         是 100 的整数倍的占 0%（A 股一笔成交必是 100 股整数倍，若是「股」不可能 0%）。
  --         本表存的【是原值】，所以这次只改前端展示，⛔ 不需要刷历史数据。
  --       ⚠️ 第一行没有上一行 ⇒ v 恒为 null（⛔ 绝不拿累计值冒充单笔量）
  --       ⚠️ v = 0 表示这一快照里没有任何成交（停顿时段）—— 是否算「一笔」由 Logic 层决定，
  --          本表【原样保留】，不做过滤。
  pens        jsonb,

  -- 本分钟【真实成交笔数】= 上游 transaction_num（累计成交笔数）在窗口内的差分。
  -- ⚠️ 口径说明：上游只给累计值，第一行之前的基数拿不到 ⇒ 本列 = tn[最后一行] − tn[第一行]，
  --    因此【不含第一行那个快照自身发生的成交笔数】（通常少 1~几笔）。
  --    它的用途是【让「快照数 ≠ 成交笔数」这件事被看见】：
  --    上游是按固定间隔给快照（快照里可能已合并了若干笔成交），东财的「20 笔」是逐笔成交，
  --    两个数字天然不同 —— 看板展示的是【快照序列】的红绿方向，本列只做对照，不参与红绿统计。
  --    上游缺失（null）⇒ 本列 null（§10 不猜）。
  trade_count int,

  -- 抓取窗口（跟随当次请求，便于日后核对口径有没有变）
  start_time  text,                   -- '09:30:00'
  end_time    text,                   -- '09:31:00'（上游语义：不含该边界）
  source      text,                   -- 抓取来源标识（固定 'tick_history'）
  updated_at  timestamptz default now(),
  primary key (date, name)
);

comment on table tick_minute_open is
  '分笔买卖：每交易日 9:30:00~9:31:00 一分钟的分笔快照（猫头鹰 tick_history），供「分笔买卖」看板按红/绿笔数判开盘强弱。（独立函数 tick-minute-fetch，与其它看板解耦）';
comment on column tick_minute_open.name is '股票简称，与 stock_topics.stock 同键 → 可直接跟决策看板的买点/卖点行对上';
comment on column tick_minute_open.code is '6 位纯代码（上游 symbol，不含交易所后缀）';
comment on column tick_minute_open.open_price is '当日开盘价（集合竞价成交价）= 本分钟第一笔的涨跌基准';
comment on column tick_minute_open.pens is '本分钟原始快照序列 [{t,p,v}]；v=本快照新增成交量(手，上游原值，⛔ 不再÷100)，首条为 null，0 表示该快照无成交。红/绿/平一律由 Logic 层现算，本表只存事实';
comment on column tick_minute_open.trade_count is '本分钟真实成交笔数（= 上游累计成交笔数在窗口内的差分，不含首行自身；null=上游缺值）。只做对照：快照数 ≠ 成交笔数。不参与红绿统计';
comment on column tick_minute_open.start_time is '抓取窗口起点 09:30:00（含）';
comment on column tick_minute_open.end_time is '抓取窗口终点 09:31:00（上游语义：不含该边界）';

-- 行级安全：与 auction_watchlist / market_metrics / limit_pool / auction_yizi 保持一致（anon 全开放）
alter table tick_minute_open enable row level security;

drop policy if exists "allow_all_tick_minute_open" on tick_minute_open;
create policy "allow_all_tick_minute_open"
  on tick_minute_open for all to anon using (true) with check (true);

-- 看板主查询：按 date 读该日全部分笔
create index if not exists idx_tick_minute_open_date on tick_minute_open(date);

-- Realtime：本表是「一天一次」的写入（9:31 后由前端触发一次），
-- 因此【不】加入 supabase_realtime 发布 —— 不引入无意义的推送通道（§36）。
-- 若日后要「一台设备抓完，其它设备自动刷新」，再把下面这段打开，并在
-- src/data/tick-minute.js 里补 startTickMinuteRealtime / stopTickMinuteRealtime（§31 成对）。
-- do $$
-- begin
--   if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
--     if not exists (
--       select 1 from pg_publication_tables
--       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tick_minute_open'
--     ) then
--       alter publication supabase_realtime add table tick_minute_open;
--     end if;
--   end if;
-- end $$;

-- 让 PostgREST 立刻刷新 schema cache。
-- 症状对照：若前端/函数红字
--   `Could not find the table 'public.tick_minute_open' in the schema cache`（PGRST205）
-- —— 99% 是【本文件还没执行过】，不是「调用方式不对」。执行过仍报再跑下面这行。
notify pgrst, 'reload schema';

-- 自检（执行完后跑一遍）：
-- select count(*) as rows, count(distinct date) as days from tick_minute_open;
-- select date, name, code, open_price, jsonb_array_length(pens) as snapshots, updated_at
--   from tick_minute_open order by date desc, name limit 20;
-- 想直接看某只票的红/绿笔数（口径与 Logic 层一致：平盘计入绿；v=0 的空快照不计）：
-- select date, name,
--        count(*) filter (where p > lag_p) as up,
--        count(*) filter (where p <= lag_p) as down_incl_flat
--   from (
--     select date, name,
--            (e->>'p')::numeric as p,
--            lag((e->>'p')::numeric) over (partition by date, name order by ord) as lag_p,
--            (e->>'v')::numeric as v,
--            ord
--       from tick_minute_open t,
--            lateral jsonb_array_elements(t.pens) with ordinality as x(e, ord)
--   ) s
--  where lag_p is not null and (v is null or v <> 0)
--  group by date, name;
