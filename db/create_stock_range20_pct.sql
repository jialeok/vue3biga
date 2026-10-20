-- ============================================================================
-- 「20日涨幅」结果缓存表（跨设备共享 · 免重复请求同花顺 K 线）
-- 应用层：src/data/stock-range20-cache.js（读写） / src/logic/auction/range20.js（编排）
--
-- 为什么必须建：
--   20 日涨幅的历史日腿只认同花顺 K 线（`auction_watchlist.change_pct` 早盘写的是竞价涨幅，
--   收盘后才覆盖，未覆盖的历史行永久留竞价值 —— 详见 range20.js 的 R20-CLOSE-LEG 注释）。
--   1 只票 = 1 次 K 线请求，看板 40+ 只 ⇒ 每次打开应用/切日期都要 30~90s，而且刷新就白算。
--   本表把算好的结果按 (date, stock) 缓存 ⇒ 第二次打开、切回日期、换设备，都只花 1 次查询。
--
-- 与 stock_range_pct 的关系：**必须是独立的表，⛔ 不要复用**。
--   那张表主键 (date,stock) 且 days 现值只有 10/8/9/7/6（十日口径），20 日写进去会覆盖当天
--   十日行 ⇒ 污染十日涨幅 / 龙位 / 决策看板 / 卖点段（§6 单一真相会被打破）。
--
-- 口径列 leg：
--   'auc'   = 盘中口径（前 19 个交易日收盘涨幅 × 今天【竞价】涨幅）
--   'close' = 收盘口径（20 个交易日全部收盘涨幅）—— 与炒股软件一致，用于复盘
--   同一天可能先后存在两套（早上写 auc，收盘后覆盖成 close）。
--   ⇒ 读取方必须按「当前时刻应有的口径」过滤，leg 不匹配的行视为【还没有】，触发重算。
--
-- 执行方式：Supabase Dashboard -> SQL Editor -> 新建 Query -> Run（幂等，可重复执行）
-- ============================================================================

create table if not exists stock_range20_pct (
  date       text        not null,   -- 窗口结束日 T（= 看板当前日期）
  stock      text        not null,   -- 股票名称
  pct        text,                   -- 20 日区间涨幅(%)，形如 "+210.98"；算不出为 null（⛔ 不写 0）
  days       int         default 0,  -- 实际参与累乘的天数（停牌/缺数据会 < 20）
  leg        text        not null default 'close',  -- 'auc' = 盘中竞价口径 / 'close' = 收盘口径
  updated_at timestamptz default now(),
  primary key (date, stock)
);

comment on table stock_range20_pct is
  '「20日涨幅」结果缓存：含今天在内 20 个交易日的复利区间涨幅（同花顺 K 线算出后落库，避免每次打开都重算）';
comment on column stock_range20_pct.leg is
  'auc = 盘中口径（今天那根腿取竞价涨幅）；close = 收盘口径（今天那根腿取收盘涨幅，与炒股软件一致）';

-- 行级安全：与 stock_range_pct / auction_watchlist / market_metrics 保持一致（anon 全开放）
alter table stock_range20_pct enable row level security;

drop policy if exists "allow_all_stock_range20_pct" on stock_range20_pct;
create policy "allow_all_stock_range20_pct"
  on stock_range20_pct for all to anon using (true) with check (true);

-- 按日期快速查询某天的全部结果（面板每次都按 date 过滤）
create index if not exists idx_stock_range20_pct_date on stock_range20_pct(date);

-- 可选：清理 90 天前的行（表只用于「当前 + 近期复盘」，太老的价值低、会拖慢查询）
-- delete from stock_range20_pct where date < to_char(now() - interval '90 days', 'YYYY-MM-DD');
